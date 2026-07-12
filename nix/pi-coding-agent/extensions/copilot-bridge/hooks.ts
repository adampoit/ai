import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type HookEventName =
	| "sessionStart"
	| "sessionEnd"
	| "userPromptSubmitted"
	| "preToolUse"
	| "postToolUse"
	| "agentStop";

type HookEntry = {
	type?: "command" | "prompt";
	bash?: string;
	command?: string;
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	timeoutSec?: number;
	matcher?: string;
	prompt?: string;
};

type HookConfig = {
	version?: number;
	disableAllHooks?: boolean;
	hooks?: Partial<Record<HookEventName, HookEntry[]>>;
};

type HookOutput = {
	permissionDecision?: "allow" | "deny" | "ask";
	permissionDecisionReason?: string;
	modifiedArgs?: Record<string, unknown>;
	modifiedResult?: { resultType?: string; textResultForLlm?: string };
	additionalContext?: string;
	decision?: "allow" | "block";
	reason?: string;
};

type CommandResult = {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

async function findJsonFiles(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

async function readHookConfig(
	filePath: string,
): Promise<HookConfig | undefined> {
	try {
		const parsed = JSON.parse(
			await readFile(filePath, "utf8"),
		) as HookConfig;
		if (parsed.version !== 1 || parsed.disableAllHooks) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
	return typeof ctx.isProjectTrusted === "function"
		? ctx.isProjectTrusted()
		: false;
}

async function loadHooks(
	cwd: string,
	ctx: ExtensionContext,
): Promise<Record<HookEventName, HookEntry[]>> {
	const hooks: Record<HookEventName, HookEntry[]> = {
		sessionStart: [],
		sessionEnd: [],
		userPromptSubmitted: [],
		preToolUse: [],
		postToolUse: [],
		agentStop: [],
	};
	const copilotHome =
		process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
	const files = [
		...(await findJsonFiles(path.join(copilotHome, "hooks"))),
		...(isProjectTrusted(ctx)
			? await findJsonFiles(path.join(cwd, ".github", "hooks"))
			: []),
	];

	for (const file of files) {
		const config = await readHookConfig(file);
		if (!config?.hooks) continue;
		for (const name of Object.keys(hooks) as HookEventName[]) {
			hooks[name].push(...(config.hooks[name] ?? []));
		}
	}

	return hooks;
}

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile?.() ?? ctx.cwd;
}

function matches(entry: HookEntry, value: string): boolean {
	if (!entry.matcher) return true;
	try {
		return new RegExp(`^(?:${entry.matcher})$`).test(value);
	} catch {
		return false;
	}
}

const BLOCKED_HOOK_ENV_NAMES = new Set([
	"BASH_ENV",
	"CDPATH",
	"ENV",
	"GCONV_PATH",
	"IFS",
	"NODE_OPTIONS",
	"PATH",
	"PERL5OPT",
	"PYTHONPATH",
	"RUBYOPT",
	"SHELLOPTS",
]);

function safeHookEnvironment(
	overrides: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const [name, value] of Object.entries(overrides ?? {})) {
		const normalizedName = name.toUpperCase();
		if (
			BLOCKED_HOOK_ENV_NAMES.has(normalizedName) ||
			normalizedName.startsWith("LD_") ||
			normalizedName.startsWith("DYLD_")
		) {
			continue;
		}
		environment[name] = value;
	}
	return environment;
}

function runCommandHook(
	entry: HookEntry,
	cwd: string,
	payload: unknown,
): Promise<CommandResult> {
	const command = entry.bash ?? entry.command;
	if (!command) {
		return Promise.resolve({
			code: 0,
			stdout: "",
			stderr: "",
			timedOut: false,
		});
	}

	const hookCwd = entry.cwd ? path.resolve(cwd, entry.cwd) : cwd;
	const timeoutMs =
		Math.max(1, entry.timeoutSec ?? entry.timeout ?? 30) * 1000;
	const child = spawn("/bin/bash", ["-lc", command], {
		cwd: hookCwd,
		env: safeHookEnvironment(entry.env),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let spawnError: Error | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, timeoutMs);

	child.on("error", (error) => {
		spawnError = error;
	});
	child.stdin.on("error", (error) => {
		stderr += error.message;
	});
	child.stdin.end(JSON.stringify(payload));
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});

	return new Promise((resolve) => {
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code,
				stdout,
				stderr: spawnError?.message ?? stderr,
				timedOut,
			});
		});
	});
}

function parseHookOutput(
	stdout: string,
	ctx: ExtensionContext,
): HookOutput | undefined {
	const lines = stdout.split(/\r?\n/);
	const retained: string[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line.trim()) as {
				type?: string;
				message?: string;
			};
			if (parsed.type === "progress") {
				if (parsed.message) ctx.ui.notify(parsed.message, "info");
				continue;
			}
		} catch {
			// Non-JSON lines are preserved for final output parsing.
		}
		retained.push(line);
	}

	const output = retained.join("\n").trim();
	if (!output) return undefined;
	try {
		return JSON.parse(output) as HookOutput;
	} catch {
		return undefined;
	}
}

async function runCommandHooks(
	entries: HookEntry[],
	eventName: HookEventName,
	matcherValue: string,
	ctx: ExtensionContext,
	payload: unknown,
): Promise<
	Array<{ entry: HookEntry; result: CommandResult; output?: HookOutput }>
> {
	const results = [];
	for (const entry of entries) {
		if (
			(entry.type ?? "command") !== "command" ||
			!matches(entry, matcherValue)
		) {
			continue;
		}
		const result = await runCommandHook(entry, ctx.cwd, payload);
		const output = parseHookOutput(result.stdout, ctx);
		if (result.stderr && eventName !== "preToolUse") {
			ctx.ui.notify(
				result.stderr.trim(),
				result.code === 0 ? "info" : "warning",
			);
		}
		results.push({ entry, result, output });
	}
	return results;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content);
	return content
		.map((block) =>
			block && typeof block === "object" && "text" in block
				? String((block as { text: unknown }).text)
				: JSON.stringify(block),
		)
		.join("\n");
}

export function registerHookBridge(pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		const hooks = await loadHooks(ctx.cwd, ctx);
		const payload = {
			sessionId: sessionId(ctx),
			timestamp: Date.now(),
			cwd: ctx.cwd,
			source: event.reason,
		};
		for (const { output } of await runCommandHooks(
			hooks.sessionStart,
			"sessionStart",
			"sessionStart",
			ctx,
			payload,
		)) {
			if (output?.additionalContext) {
				pi.sendMessage({
					customType: "copilot-hooks",
					content: output.additionalContext,
					display: false,
				});
			}
		}
		for (const entry of hooks.sessionStart) {
			if (entry.type === "prompt" && entry.prompt) {
				pi.sendUserMessage(entry.prompt, { deliverAs: "followUp" });
			}
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const hooks = await loadHooks(ctx.cwd, ctx);
		await runCommandHooks(
			hooks.sessionEnd,
			"sessionEnd",
			"sessionEnd",
			ctx,
			{
				sessionId: sessionId(ctx),
				timestamp: Date.now(),
				cwd: ctx.cwd,
				reason: event.reason === "quit" ? "user_exit" : event.reason,
			},
		);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const hooks = await loadHooks(ctx.cwd, ctx);
		await runCommandHooks(
			hooks.userPromptSubmitted,
			"userPromptSubmitted",
			"userPromptSubmitted",
			ctx,
			{
				sessionId: sessionId(ctx),
				timestamp: Date.now(),
				cwd: ctx.cwd,
				prompt: event.prompt,
			},
		);
	});

	pi.on("tool_call", async (event, ctx) => {
		const hooks = await loadHooks(ctx.cwd, ctx);
		const payload = {
			sessionId: sessionId(ctx),
			timestamp: Date.now(),
			cwd: ctx.cwd,
			toolName: event.toolName,
			toolArgs: event.input,
		};

		for (const { result, output } of await runCommandHooks(
			hooks.preToolUse,
			"preToolUse",
			event.toolName,
			ctx,
			payload,
		)) {
			if (result.timedOut) {
				ctx.ui.notify(
					"preToolUse hook timed out; allowing tool call.",
					"warning",
				);
				continue;
			}
			if (result.code !== 0 && result.code !== 2) {
				return {
					block: true,
					reason: "Denied by preToolUse hook (hook errored)",
				};
			}
			if (output?.modifiedArgs && typeof event.input === "object") {
				for (const key of Object.keys(
					event.input as Record<string, unknown>,
				)) {
					delete (event.input as Record<string, unknown>)[key];
				}
				Object.assign(
					event.input as Record<string, unknown>,
					output.modifiedArgs,
				);
			}
			if (
				output?.permissionDecision === "deny" ||
				output?.permissionDecision === "ask"
			) {
				return {
					block: true,
					reason:
						output.permissionDecisionReason ??
						"Denied by preToolUse hook",
				};
			}
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const hooks = await loadHooks(ctx.cwd, ctx);
		const payload = {
			sessionId: sessionId(ctx),
			timestamp: Date.now(),
			cwd: ctx.cwd,
			toolName: event.toolName,
			toolArgs: event.input,
			toolResult: {
				resultType: "success",
				textResultForLlm: textContent(event.content),
			},
		};
		const outputs = await runCommandHooks(
			hooks.postToolUse,
			"postToolUse",
			event.toolName,
			ctx,
			payload,
		);
		let replacement: string | undefined;
		const additionalContext: string[] = [];
		for (const { output } of outputs) {
			if (output?.modifiedResult?.textResultForLlm) {
				replacement = output.modifiedResult.textResultForLlm;
			}
			if (output?.additionalContext)
				additionalContext.push(output.additionalContext);
		}
		if (!replacement && additionalContext.length === 0) return undefined;

		return {
			content: [
				{
					type: "text" as const,
					text: [
						replacement ?? textContent(event.content),
						...additionalContext,
					]
						.join("\n\n")
						.slice(0, 10_000),
				},
			],
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		const hooks = await loadHooks(ctx.cwd, ctx);
		for (const { output } of await runCommandHooks(
			hooks.agentStop,
			"agentStop",
			"agentStop",
			ctx,
			{
				sessionId: sessionId(ctx),
				timestamp: Date.now(),
				cwd: ctx.cwd,
				transcriptPath: ctx.sessionManager.getSessionFile?.() ?? "",
				stopReason: "end_turn",
			},
		)) {
			if (output?.decision === "block" && output.reason) {
				pi.sendUserMessage(output.reason, { deliverAs: "followUp" });
			}
		}
	});
}
