import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const PRETTIER_FORMATTER = ["prettier", "--write"];

type ToolResultDetails = {
	diff?: string;
	formatter?: string;
	originalContent?: string;
} & Record<string, unknown>;

const FORMAT_TIMEOUT_MS = 15000;

function setFormatterStatus(
	ctx: ExtensionContext,
	color: "dim" | "success" | "warning" | "error",
	status: string,
): void {
	ctx.ui.setStatus("autoformat", ctx.ui.theme.fg(color, `fmt: ${status}`));
}

function formatFormatterSummary(
	available: string[],
	missing: string[],
): string {
	if (available.length === 0 && missing.length === 0) return "none";
	const availableStatus = available
		.map((command) => ` ${command}`)
		.join("  ");
	const missingStatus = missing.map((command) => ` ${command}`).join("  ");
	return [availableStatus, missingStatus].filter(Boolean).join("  ");
}

function formatOnOffSections(
	title: string,
	entries: Array<{ on: boolean; text: string }>,
	includeOff = false,
): string {
	const on = entries.filter((entry) => entry.on).map((entry) => entry.text);
	const off = entries.filter((entry) => !entry.on).map((entry) => entry.text);
	const lines = [
		`${title}:`,
		"",
		`On (${on.length}):`,
		on.length ? on.join("\n") : "- none",
	];
	if (includeOff) {
		lines.push(
			"",
			`Off (${off.length}):`,
			off.length ? off.join("\n") : "- none",
		);
	} else if (off.length) {
		lines.push("", `${off.length} off/configured entries hidden.`);
	}
	return lines.join("\n");
}

async function showToggleView(
	ctx: ExtensionContext,
	title: string,
	entries: Array<{ on: boolean; text: string }>,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, kb, done) => {
			let showAll = false;
			const border = new DynamicBorder((text) =>
				theme.fg("border", text),
			);
			return {
				render(width: number) {
					const lines = [
						theme.fg(
							"dim",
							`t: ${showAll ? "show on only" : "show all configured"} • esc: close`,
						),
						"",
						...formatOnOffSections(title, entries, showAll).split(
							"\n",
						),
						"",
						border.render(width)[0] ?? "",
					];
					return lines.map((line) => truncateToWidth(line, width));
				},
				invalidate() {},
				handleInput(data: string) {
					if (kb.matches(data, "tui.select.cancel")) {
						done();
						return;
					}
					if (data === "t") showAll = !showAll;
					tui.requestRender();
				},
			};
		},
		{ overlay: false },
	);
}

async function commandPath(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await pi.exec(
		"bash",
		["-lc", `command -v "$1"`, "--", command],
		{ cwd, signal, timeout: 2000 },
	);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

async function commandExists(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	signal?: AbortSignal,
): Promise<boolean> {
	return Boolean(await commandPath(pi, cwd, command, signal));
}

async function commandVersion(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await pi.exec(
		"bash",
		[
			"-lc",
			`"$1" --version 2>&1 | head -n 1 || "$1" version 2>&1 | head -n 1`,
			"--",
			command,
		],
		{ cwd, signal, timeout: 3000 },
	);
	const version = result.stdout.trim() || result.stderr.trim();
	return result.code === 0 && version ? version : "unknown";
}

async function findProjectFormatterCommands(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const result = await pi.exec(
		"bash",
		[
			"-lc",
			`find . \\
				-path './.git' -prune -o \\
				-path './.jj' -prune -o \\
				-path './node_modules' -prune -o \\
				-type f -print`,
		],
		{ cwd, signal, timeout: 5000 },
	);
	if (result.code !== 0) return [];

	const commands = new Set<string>();
	for (const relativePath of result.stdout.split("\n")) {
		if (!relativePath) continue;
		const formatter = getFormatter(relativePath);
		if (formatter) commands.add(formatter[0] ?? "");
		if (extname(relativePath).toLowerCase() === ".cs")
			commands.add("dotnet");
	}
	commands.delete("");
	return [...commands].sort();
}

function getConfiguredFormatterCommands(): string[] {
	const commands = new Set(
		Object.values(formatterByExtension).map(
			(formatter) => formatter[0] ?? "",
		),
	);
	commands.add("dotnet");
	commands.add("nix");
	commands.delete("");
	return [...commands].sort();
}

async function refreshFormatterStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	setFormatterStatus(ctx, "dim", "󰔟 scanning");
	const commands = await findProjectFormatterCommands(
		pi,
		ctx.cwd,
		ctx.signal,
	);
	if (commands.length === 0) {
		setFormatterStatus(ctx, "dim", "none");
		return;
	}

	const available: string[] = [];
	const missing: string[] = [];
	for (const command of commands) {
		((await commandExists(pi, ctx.cwd, command, ctx.signal))
			? available
			: missing
		).push(command);
	}

	setFormatterStatus(
		ctx,
		missing.length > 0 ? "warning" : "dim",
		formatFormatterSummary(available, missing),
	);
}

const formatterByExtension: Record<string, string[]> = {
	".c": ["clang-format", "-i"],
	".cc": ["clang-format", "-i"],
	".cpp": ["clang-format", "-i"],
	".cxx": ["clang-format", "-i"],
	".h": ["clang-format", "-i"],
	".hh": ["clang-format", "-i"],
	".hpp": ["clang-format", "-i"],
	".hxx": ["clang-format", "-i"],
	".css": PRETTIER_FORMATTER,
	".html": PRETTIER_FORMATTER,
	".js": PRETTIER_FORMATTER,
	".jsx": PRETTIER_FORMATTER,
	".json": PRETTIER_FORMATTER,
	".less": PRETTIER_FORMATTER,
	".md": PRETTIER_FORMATTER,
	".mdx": PRETTIER_FORMATTER,
	".ts": PRETTIER_FORMATTER,
	".tsx": PRETTIER_FORMATTER,
	".yaml": PRETTIER_FORMATTER,
	".yml": PRETTIER_FORMATTER,
	".kt": ["ktlint", "-F"],
	".kts": ["ktlint", "-F"],
	".lua": ["stylua"],
	".nix": ["alejandra"],
	".py": ["ruff", "format"],
	".sh": ["shfmt", "-w", "-i", "0"],
	".bash": ["shfmt", "-w", "-i", "0"],
	".zsh": ["shfmt", "-w", "-i", "0"],
	".swift": ["swiftlint", "--fix", "--path"],
	".tf": ["terraform", "fmt", "-no-color"],
	".tfvars": ["terraform", "fmt", "-no-color"],
	".sql": ["sqlfluff", "fix"],
};

function getToolPath(toolName: string, input: unknown): string | undefined {
	if (
		(toolName !== "edit" && toolName !== "write") ||
		!input ||
		typeof input !== "object"
	)
		return undefined;
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" ? path.replace(/^@/, "") : undefined;
}

function getFormatter(path: string): string[] | undefined {
	const base = path.split(/[\\/]/).pop() ?? "";
	if (base === "flake.lock") return ["nix", "fmt"];
	return formatterByExtension[extname(path).toLowerCase()];
}

function findLocalPrettier(file: string, cwd: string): string | undefined {
	let dir = dirname(file);
	while (true) {
		const prettier = join(dir, "node_modules", ".bin", "prettier");
		if (existsSync(prettier)) return prettier;

		if (dir === cwd) break;
		const next = dirname(dir);
		if (next === dir) break;
		dir = next;
	}
	return undefined;
}

function isUsableFile(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

function formatDisplayPath(cwd: string, file: string): string {
	const displayPath = relative(cwd, file);
	return displayPath.startsWith("..") ? file : displayPath;
}

function formatCommandName(command: string): string {
	return basename(command);
}

async function computeUnifiedDiff(
	pi: ExtensionAPI,
	before: string,
	after: string,
	displayPath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const dir = mkdtempSync(join(tmpdir(), "pi-autoformat-diff-"));
	try {
		const beforePath = join(dir, "before");
		const afterPath = join(dir, "after");
		writeFileSync(beforePath, before, "utf8");
		writeFileSync(afterPath, after, "utf8");

		const result = await pi.exec(
			"diff",
			[
				"-u",
				"--label",
				`a/${displayPath}`,
				"--label",
				`b/${displayPath}`,
				beforePath,
				afterPath,
			],
			{ signal, timeout: 5000 },
		);
		if (result.code === 0) return "";
		if (result.code === 1) return result.stdout;
		return undefined;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function findDotnetFormatTarget(
	pi: ExtensionAPI,
	file: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	let dir = dirname(file);
	while (true) {
		const probe = await pi.exec(
			"bash",
			["-lc", "printf '%s\\n' *.sln *.csproj 2>/dev/null | head -n 1"],
			{
				cwd: dir,
				signal,
				timeout: 2000,
			},
		);
		const candidate = probe.stdout.trim();
		if (probe.code === 0 && candidate && !candidate.includes("*"))
			return resolve(dir, candidate);

		const next = dirname(dir);
		if (next === dir) break;
		dir = next;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("formatters", {
		description: "Show detected project formatters and availability",
		handler: async (_args, ctx) => {
			const detected = new Set(
				await findProjectFormatterCommands(pi, ctx.cwd, ctx.signal),
			);
			const commands = getConfiguredFormatterCommands();
			const entries = await Promise.all(
				commands.map(async (command) => {
					const executablePath = await commandPath(
						pi,
						ctx.cwd,
						command,
						ctx.signal,
					);
					const lines = [
						`- ${command}`,
						`  path: ${executablePath ?? "unavailable"}`,
					];
					if (executablePath)
						lines.push(
							`  version: ${await commandVersion(pi, ctx.cwd, executablePath, ctx.signal)}`,
						);
					return {
						on: detected.has(command),
						text: lines.join("\n"),
					};
				}),
			);
			await showToggleView(ctx, "formatters", entries);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshFormatterStatus(pi, ctx).catch((error) => {
			setFormatterStatus(ctx, "error", "error");
			ctx.ui.notify(
				`Formatter status failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("autoformat", "");
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		const rawPath = getToolPath(event.toolName, event.input);
		if (!rawPath) return;

		const file = resolve(ctx.cwd, rawPath);
		const cwd = resolve(ctx.cwd);
		if (!isUsableFile(file)) return;
		const displayPath = formatDisplayPath(cwd, file);

		let command: string;
		let args: string[];

		if (extname(file).toLowerCase() === ".cs") {
			const target = await findDotnetFormatTarget(pi, file, ctx.signal);
			if (!target) return;
			command = "dotnet";
			args = ["format", target, "--include", file];
		} else {
			const formatter = getFormatter(file);
			if (!formatter) return;
			[command, ...args] = formatter;
			if (command === "prettier")
				command = findLocalPrettier(file, cwd) ?? command;
			args.push(file);
		}

		const available = await pi.exec(
			"bash",
			["-lc", `command -v "$1"`, "--", command],
			{
				cwd,
				signal: ctx.signal,
				timeout: 2000,
			},
		);
		if (available.code !== 0) return;

		const commandName = formatCommandName(command);
		setFormatterStatus(ctx, "dim", ` ${commandName}`);
		const result = await pi.exec(command, args, {
			cwd,
			signal: ctx.signal,
			timeout: FORMAT_TIMEOUT_MS,
		});

		if (result.code !== 0) {
			const output = (
				result.stderr ||
				result.stdout ||
				"formatter failed"
			).trim();
			ctx.ui.notify(
				`Formatter failed using ${commandName}: ${output}`,
				"warning",
			);
			await refreshFormatterStatus(pi, ctx);
			return;
		}

		await refreshFormatterStatus(pi, ctx);

		if (event.toolName !== "edit") return;

		const details = event.details as ToolResultDetails | undefined;
		if (typeof details?.originalContent !== "string") return;

		const diff = await computeUnifiedDiff(
			pi,
			details.originalContent,
			readFileSync(file, "utf8"),
			displayPath,
			ctx.signal,
		);
		if (diff === undefined)
			return { details: { ...details, formatter: commandName } };

		return { details: { ...details, diff, formatter: commandName } };
	});
}
