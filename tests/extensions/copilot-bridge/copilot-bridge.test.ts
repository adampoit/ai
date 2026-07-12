import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import copilotBridgeExtension from "../../../nix/pi-coding-agent/extensions/copilot-bridge/index.ts";
import contextViewerExtension from "../../../nix/pi-coding-agent/extensions/context-viewer.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	runCommand,
} from "../helpers.ts";

test.beforeEach(async () => {
	process.env.COPILOT_HOME = await mkdtemp(
		path.join(tmpdir(), "copilot-home-"),
	);
});

test("copilot bridge extension registers its public surface", () => {
	const pi = loadExtension(copilotBridgeExtension);

	assertPublicSurface(pi, {
		commands: ["copilot-bridge", "copilot-prompt", "copilot-prompts"],
		handlers: [
			"agent_end",
			"before_agent_start",
			"context",
			"session_shutdown",
			"session_start",
			"tool_call",
			"tool_result",
		],
	});
});

test("copilot bridge contributes repository-wide Copilot instructions as project context", async () => {
	loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "instructions"), {
		recursive: true,
	});
	await writeFile(
		path.join(ctx.cwd, ".github", "copilot-instructions.md"),
		"Use repository-wide Copilot guidance.",
	);
	await writeFile(
		path.join(
			ctx.cwd,
			".github",
			"instructions",
			"typescript.instructions.md",
		),
		"---\napplyTo: '**/*.ts'\n---\nUse TypeScript-specific Copilot guidance.",
	);
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: ctx.cwd,
		noExtensions: true,
	});
	await loader.reload();

	const files = loader.getAgentsFiles().agentsFiles;

	assert.equal(files.length, 1);
	assert.equal(
		files[0].path,
		path.join(ctx.cwd, ".github", "copilot-instructions.md"),
	);
	assert.equal(
		files[0].content,
		"GitHub Copilot repository instructions.\n\nUse repository-wide Copilot guidance.",
	);
	assert.equal(
		JSON.stringify(files).includes("typescript.instructions.md"),
		false,
	);
});

test("context viewer shows both AGENTS.md and Copilot instructions", async () => {
	const pi = loadExtension(contextViewerExtension);
	copilotBridgeExtension(pi as never);
	const rendered: string[] = [];
	const ctx = await createContext();
	ctx.ui.custom = async (factory: any) => {
		const view = factory(
			{ requestRender() {} },
			ctx.ui.theme,
			{ matches: () => false },
			() => {},
		);
		view.handleInput("3");
		rendered.push(...view.render(100));
		return undefined as never;
	};
	await mkdir(path.join(ctx.cwd, ".github"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "copilot-instructions.md"),
		"Use repository-wide Copilot guidance.",
	);

	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: ctx.cwd,
		noExtensions: true,
		agentsFilesOverride: (base) => ({
			agentsFiles: [
				{
					path: path.join(ctx.cwd, "AGENTS.md"),
					content: "Use repository AGENTS guidance.",
				},
				...base.agentsFiles,
			],
		}),
	});
	await loader.reload();
	ctx.getSystemPromptOptions = () => ({
		cwd: ctx.cwd,
		contextFiles: loader.getAgentsFiles().agentsFiles,
	});
	await runCommand(pi, "context", "", ctx);

	const output = rendered.join("\n");
	assert.ok(output.includes("AGENTS.md"), output);
	assert.ok(output.includes("Use repository AGENTS guidance."), output);
	assert.ok(output.includes(".github/copilot-instructions.md"), output);
	assert.ok(output.includes("Use repository-wide Copilot guidance."), output);
});

test("copilot bridge injects matching path-specific instructions from prompt paths", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "instructions"), {
		recursive: true,
	});
	await writeFile(
		path.join(
			ctx.cwd,
			".github",
			"instructions",
			"typescript.instructions.md",
		),
		"---\napplyTo: '**/*.ts'\n---\nUse TypeScript-specific Copilot guidance.",
	);
	await writeFile(
		path.join(ctx.cwd, ".github", "instructions", "python.instructions.md"),
		"---\napplyTo: '**/*.py'\n---\nUse Python-specific Copilot guidance.",
	);

	await pi.emit(
		"before_agent_start",
		{
			prompt: "Update src/index.ts",
			systemPrompt: "Base prompt",
			systemPromptOptions: { cwd: ctx.cwd },
		},
		ctx,
	);
	const [result] = await pi.emit(
		"context",
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
			],
		},
		ctx,
	);

	assert.ok(result && typeof result === "object");
	const messages = (result as { messages: Array<{ content: string }> })
		.messages;
	assert.equal(
		messages[0].content.includes(
			"GitHub Copilot path-specific instructions",
		),
		true,
	);
	assert.equal(
		messages[0].content.includes(
			"Use TypeScript-specific Copilot guidance.",
		),
		true,
	);
	assert.equal(
		messages[0].content.includes("Use Python-specific Copilot guidance."),
		false,
	);
	assert.equal(messages[0].content.includes("applyTo:"), false);
});

test("copilot bridge progressively injects path-specific instructions after tool calls encounter files", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "instructions"), {
		recursive: true,
	});
	await writeFile(
		path.join(
			ctx.cwd,
			".github",
			"instructions",
			"typescript.instructions.md",
		),
		"---\napplyTo: '**/*.ts'\n---\nUse TypeScript-specific Copilot guidance.",
	);

	await pi.emit(
		"before_agent_start",
		{
			prompt: "Inspect the implementation",
			systemPrompt: "Base prompt",
			systemPromptOptions: { cwd: ctx.cwd },
		},
		ctx,
	);
	const [beforeRead] = await pi.emit(
		"context",
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
			],
		},
		ctx,
	);
	assert.equal(beforeRead, undefined);

	await pi.emit(
		"tool_call",
		{ toolName: "read", toolCallId: "1", input: { path: "src/index.ts" } },
		ctx,
	);
	const [afterRead] = await pi.emit(
		"context",
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
			],
		},
		ctx,
	);

	assert.ok(afterRead && typeof afterRead === "object");
	const messages = (afterRead as { messages: Array<{ content: string }> })
		.messages;
	assert.equal(
		messages[0].content.includes(
			"Use TypeScript-specific Copilot guidance.",
		),
		true,
	);
});

test("copilot bridge skips cloud-agent excluded path instructions", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "instructions"), {
		recursive: true,
	});
	await writeFile(
		path.join(
			ctx.cwd,
			".github",
			"instructions",
			"excluded.instructions.md",
		),
		"---\napplyTo: '**/*.ts'\nexcludeAgent: 'cloud-agent'\n---\nDo not inject this guidance.",
	);

	await pi.emit(
		"before_agent_start",
		{
			prompt: "Update src/index.ts",
			systemPrompt: "Base prompt",
			systemPromptOptions: { cwd: ctx.cwd },
		},
		ctx,
	);
	const [result] = await pi.emit(
		"context",
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
			],
		},
		ctx,
	);

	assert.equal(result, undefined);
});

test("copilot bridge loads Copilot prompt files into the editor", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "prompts"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "prompts", "review.prompt.md"),
		"---\ndescription: Review current changes\n---\nReview the current diff.",
	);

	await runCommand(pi, "copilot-prompt", "review", ctx);

	assert.equal(ctx.editorText, "Review the current diff.");
	assert.deepEqual(ctx.notifications, [
		{
			message: "Loaded .github/prompts/review.prompt.md into the editor.",
			level: "info",
		},
	]);
});

test("copilot bridge rejects prompt symlinks outside the prompts directory", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	const promptDir = path.join(ctx.cwd, ".github", "prompts");
	const outsideFile = path.join(ctx.cwd, "secret.prompt.md");
	await mkdir(promptDir, { recursive: true });
	await writeFile(outsideFile, "Sensitive content");
	await symlink(outsideFile, path.join(promptDir, "leak.prompt.md"));

	await runCommand(pi, "copilot-prompt", "leak", ctx);

	assert.equal(ctx.editorText, undefined);
	assert.deepEqual(ctx.notifications, [
		{ message: "Copilot prompt not found: leak", level: "error" },
	]);
});

test("copilot bridge runs user prompt hooks", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "prompt.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				userPromptSubmitted: [
					{
						type: "command",
						bash: "node -e 'process.stdin.pipe(process.stdout)' > prompt-hook.json",
					},
				],
			},
		}),
	);

	await pi.emit(
		"before_agent_start",
		{
			prompt: "Implement the feature",
			systemPrompt: "Base prompt",
			systemPromptOptions: { cwd: ctx.cwd },
		},
		ctx,
	);

	const hookInput = JSON.parse(
		await readFile(path.join(ctx.cwd, "prompt-hook.json"), "utf8"),
	) as { prompt: string; cwd: string };
	assert.equal(hookInput.prompt, "Implement the feature");
	assert.equal(hookInput.cwd, ctx.cwd);
});

test("copilot bridge blocks tool calls denied by preToolUse hooks", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "deny.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [
					{
						type: "command",
						matcher: "bash",
						bash: 'echo \'{"permissionDecision":"deny","permissionDecisionReason":"No shell"}\'',
					},
				],
			},
		}),
	);

	const results = await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input: { command: "date" } },
		ctx,
	);

	assert.deepEqual(
		results.find((result) => result !== undefined),
		{ block: true, reason: "No shell" },
	);
});

test("copilot bridge applies postToolUse hook result context", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "post.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				postToolUse: [
					{
						type: "command",
						matcher: "read",
						bash: 'echo \'{"additionalContext":"Remember to validate this file."}\'',
					},
				],
			},
		}),
	);

	const [result] = await pi.emit(
		"tool_result",
		{
			toolName: "read",
			toolCallId: "1",
			input: { path: "src/index.ts" },
			content: [{ type: "text", text: "file contents" }],
			details: {},
			isError: false,
		},
		ctx,
	);

	assert.deepEqual(result, {
		content: [
			{
				type: "text",
				text: "file contents\n\nRemember to validate this file.",
			},
		],
	});
});

test("copilot bridge lists prompt files with descriptions", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "prompts", "nested"), {
		recursive: true,
	});
	await writeFile(
		path.join(ctx.cwd, ".github", "prompts", "nested", "fix.prompt.md"),
		"---\ndescription: Fix a bug\n---\nFix it.",
	);

	await runCommand(pi, "copilot-prompts", "", ctx);

	assert.deepEqual(ctx.notifications, [
		{
			message: "Copilot prompts: nested/fix — Fix a bug",
			level: "info",
		},
	]);
});

test("copilot bridge reports unknown prompt files", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "prompts"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "prompts", "review.prompt.md"),
		"Review the current diff.",
	);

	await runCommand(pi, "copilot-prompt", "missing", ctx);

	assert.deepEqual(ctx.notifications, [
		{ message: "Copilot prompt not found: missing", level: "error" },
	]);
});

test("copilot bridge runs session start command and prompt hooks", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "session.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				sessionStart: [
					{
						type: "command",
						bash: "node -e 'process.stdin.pipe(process.stdout)' > session-start.json",
					},
					{ type: "prompt", prompt: "/copilot-prompts" },
				],
			},
		}),
	);

	await pi.emit("session_start", { reason: "startup" }, ctx);

	const hookInput = JSON.parse(
		await readFile(path.join(ctx.cwd, "session-start.json"), "utf8"),
	) as { source: string; cwd: string };
	assert.equal(hookInput.source, "startup");
	assert.equal(hookInput.cwd, ctx.cwd);
	assert.deepEqual(pi.sentUserMessages, [
		{ content: "/copilot-prompts", options: { deliverAs: "followUp" } },
	]);
});

test("copilot bridge runs session end hooks", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "session-end.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				sessionEnd: [
					{
						type: "command",
						bash: "node -e 'process.stdin.pipe(process.stdout)' > session-end.json",
					},
				],
			},
		}),
	);

	await pi.emit("session_shutdown", { reason: "quit" }, ctx);

	const hookInput = JSON.parse(
		await readFile(path.join(ctx.cwd, "session-end.json"), "utf8"),
	) as { reason: string };
	assert.equal(hookInput.reason, "user_exit");
});

test("copilot bridge queues agentStop continuation prompts", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "stop.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				agentStop: [
					{
						type: "command",
						bash: 'echo \'{"decision":"block","reason":"Run validation now."}\'',
					},
				],
			},
		}),
	);

	await pi.emit("agent_end", { messages: [] }, ctx);

	assert.deepEqual(pi.sentUserMessages, [
		{ content: "Run validation now.", options: { deliverAs: "followUp" } },
	]);
});

test("copilot bridge applies preToolUse modifiedArgs", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "modify.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [
					{
						type: "command",
						matcher: "bash",
						bash: 'echo \'{"permissionDecision":"allow","modifiedArgs":{"command":"echo safe"}}\'',
					},
				],
			},
		}),
	);
	const input = { command: "rm -rf tmp" };

	await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input },
		ctx,
	);

	assert.deepEqual(input, { command: "echo safe" });
});

test("copilot bridge fails closed for preToolUse command errors", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "error.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [{ type: "command", bash: "exit 1" }],
			},
		}),
	);

	const results = await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input: { command: "date" } },
		ctx,
	);

	assert.deepEqual(
		results.find((result) => result !== undefined),
		{
			block: true,
			reason: "Denied by preToolUse hook (hook errored)",
		},
	);
});

test("copilot bridge handles hook spawn errors without crashing", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "spawn-error.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [
					{
						type: "command",
						bash: "exit 0",
						cwd: "missing-directory",
					},
				],
			},
		}),
	);

	const results = await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input: { command: "date" } },
		ctx,
	);

	assert.deepEqual(
		results.find((result) => result !== undefined),
		{
			block: true,
			reason: "Denied by preToolUse hook (hook errored)",
		},
	);
});

test("copilot bridge fails open for preToolUse timeouts", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "timeout.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [
					{ type: "command", bash: "sleep 2", timeoutSec: 1 },
				],
			},
		}),
	);

	const results = await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input: { command: "date" } },
		ctx,
	);

	assert.equal(
		results.find((result) => result !== undefined),
		undefined,
	);
	assert.deepEqual(ctx.notifications, [
		{
			message: "preToolUse hook timed out; allowing tool call.",
			level: "warning",
		},
	]);
});

test("copilot bridge applies postToolUse modifiedResult", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "post-modify.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				postToolUse: [
					{
						type: "command",
						bash: 'echo \'{"modifiedResult":{"resultType":"success","textResultForLlm":"replacement"}}\'',
					},
				],
			},
		}),
	);

	const [result] = await pi.emit(
		"tool_result",
		{
			toolName: "read",
			toolCallId: "1",
			input: { path: "src/index.ts" },
			content: [{ type: "text", text: "file contents" }],
			details: {},
			isError: false,
		},
		ctx,
	);

	assert.deepEqual(result, {
		content: [{ type: "text", text: "replacement" }],
	});
});

test("copilot bridge skips hooks when matchers do not match", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "skip.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [
					{
						type: "command",
						matcher: "edit",
						bash: 'echo \'{"permissionDecision":"deny"}\'',
					},
				],
			},
		}),
	);

	const results = await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input: { command: "date" } },
		ctx,
	);

	assert.equal(
		results.find((result) => result !== undefined),
		undefined,
	);
});

test("copilot bridge passes hook cwd and env", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await mkdir(path.join(ctx.cwd, "scripts"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "cwd-env.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				userPromptSubmitted: [
					{
						type: "command",
						bash: 'pwd > ../hook-cwd.txt; printf %s "$HOOK_VALUE" > ../hook-env.txt',
						cwd: "scripts",
						env: { HOOK_VALUE: "from-env" },
					},
				],
			},
		}),
	);

	await pi.emit(
		"before_agent_start",
		{
			prompt: "Implement the feature",
			systemPrompt: "Base prompt",
			systemPromptOptions: { cwd: ctx.cwd },
		},
		ctx,
	);

	assert.ok(
		(await readFile(path.join(ctx.cwd, "hook-cwd.txt"), "utf8"))
			.trim()
			.endsWith(`${path.basename(ctx.cwd)}/scripts`),
	);
	assert.equal(
		await readFile(path.join(ctx.cwd, "hook-env.txt"), "utf8"),
		"from-env",
	);
});

test("copilot bridge blocks dangerous hook environment overrides", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "unsafe-env.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				userPromptSubmitted: [
					{
						type: "command",
						bash: 'printf %s "$NODE_OPTIONS" > hook-node-options.txt; printf %s "$LD_PRELOAD" > hook-ld-preload.txt',
						env: {
							NODE_OPTIONS: "--require /tmp/evil.cjs",
							LD_PRELOAD: "/tmp/evil.so",
						},
					},
				],
			},
		}),
	);

	await pi.emit(
		"before_agent_start",
		{
			prompt: "Implement the feature",
			systemPrompt: "Base prompt",
			systemPromptOptions: { cwd: ctx.cwd },
		},
		ctx,
	);

	assert.equal(
		await readFile(path.join(ctx.cwd, "hook-node-options.txt"), "utf8"),
		process.env.NODE_OPTIONS ?? "",
	);
	assert.equal(
		await readFile(path.join(ctx.cwd, "hook-ld-preload.txt"), "utf8"),
		process.env.LD_PRELOAD ?? "",
	);
});

test("copilot bridge loads user-level hooks from COPILOT_HOME", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	const copilotHome = process.env.COPILOT_HOME;
	assert.ok(copilotHome);
	await mkdir(path.join(copilotHome, "hooks"), { recursive: true });
	await writeFile(
		path.join(copilotHome, "hooks", "user.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [
					{
						type: "command",
						bash: 'echo \'{"permissionDecision":"deny","permissionDecisionReason":"user hook"}\'',
					},
				],
			},
		}),
	);

	const results = await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input: { command: "date" } },
		ctx,
	);

	assert.deepEqual(
		results.find((result) => result !== undefined),
		{
			block: true,
			reason: "user hook",
		},
	);
});

test("copilot bridge does not load repository hooks for untrusted projects", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext({ isProjectTrusted: () => false });
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "deny.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [
					{
						type: "command",
						bash: 'echo \'{"permissionDecision":"deny"}\'',
					},
				],
			},
		}),
	);

	const results = await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input: { command: "date" } },
		ctx,
	);

	assert.equal(
		results.find((result) => result !== undefined),
		undefined,
	);
});

test("copilot bridge defaults to not loading repository hooks when trust is unavailable", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext({ isProjectTrusted: undefined as never });
	await mkdir(path.join(ctx.cwd, ".github", "hooks"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "hooks", "deny.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				preToolUse: [
					{
						type: "command",
						bash: 'echo \'{"permissionDecision":"deny"}\'',
					},
				],
			},
		}),
	);

	const results = await pi.emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "1", input: { command: "date" } },
		ctx,
	);

	assert.equal(
		results.find((result) => result !== undefined),
		undefined,
	);
});

test("copilot bridge leaves the system prompt unchanged when no Copilot files exist", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();

	const [result] = await pi.emit(
		"before_agent_start",
		{
			prompt: "Implement a feature",
			systemPrompt: "Base prompt",
			systemPromptOptions: { cwd: ctx.cwd },
		},
		ctx,
	);

	assert.equal(result, undefined);
});

test("copilot bridge command reports discovered files", async () => {
	const pi = loadExtension(copilotBridgeExtension);
	const ctx = await createContext();
	await mkdir(path.join(ctx.cwd, ".github"), { recursive: true });
	await writeFile(
		path.join(ctx.cwd, ".github", "copilot-instructions.md"),
		"Use repository-wide Copilot guidance.",
	);

	await runCommand(pi, "copilot-bridge", "", ctx);

	assert.deepEqual(ctx.notifications, [
		{
			message:
				"Copilot bridge found 1 instruction file: .github/copilot-instructions.md",
			level: "info",
		},
	]);
});
