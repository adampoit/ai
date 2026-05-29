import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { BlockFrame, gruvbox, KeyHintLine } from "../components/index.ts";
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

type FormatResult = {
	commandName: string;
	changed: boolean;
	error?: string;
};

const FORMAT_TIMEOUT_MS = 15000;

const lastFormatMtime = new Map<string, number>();

type FormatterCache = {
	paths: Map<string, string>;
	prettierPath?: string;
	nixFormatter?: { command: string; path: string } | null;
};

const formatterCache: FormatterCache = {
	paths: new Map(),
};

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("extension ctx is stale")
	);
}

function setFormatterStatus(
	ctx: ExtensionContext,
	color: "dim" | "success" | "warning" | "error",
	status: string,
): boolean {
	try {
		ctx.ui.setStatus(
			"autoformat",
			ctx.ui.theme.fg(color, `fmt: ${status}`),
		);
		return true;
	} catch (error) {
		if (isStaleContextError(error)) return false;
		throw error;
	}
}

function notifyFormatterWarning(ctx: ExtensionContext, message: string): void {
	try {
		ctx.ui.notify(message, "warning");
	} catch (error) {
		if (isStaleContextError(error)) return;
		throw error;
	}
}

function notifyFormatterInfo(ctx: ExtensionContext, message: string): void {
	try {
		ctx.ui.notify(message, "info");
	} catch (error) {
		if (isStaleContextError(error)) return;
		throw error;
	}
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
			return {
				render(width: number) {
					const onCount = entries.filter((entry) => entry.on).length;
					const offCount = entries.length - onCount;
					return new BlockFrame(
						{
							invalidate() {},
							render(contentWidth: number) {
								const help = new KeyHintLine(
									[
										{
											key: "t",
											label: showAll
												? "show on only"
												: "show all configured",
										},
										{ key: "esc", label: "close" },
									],
									{ theme, accent: gruvbox.orange },
								).render(contentWidth);
								return [
									...help,
									"",
									...formatOnOffSections(
										title,
										entries,
										showAll,
									).split("\n"),
								].map((line) =>
									truncateToWidth(line, contentWidth),
								);
							},
						},
						{
							title: {
								title,
								icon: "󰉢",
								accent: gruvbox.orange,
								badges: [
									{ text: `${onCount} on`, bg: gruvbox.bg2 },
									{
										text: `${offCount} off`,
										bg: gruvbox.bg2,
									},
								],
								theme,
							},
							borderColor: gruvbox.orange,
							background: gruvbox.bg1,
							theme,
							paddingX: 1,
							paddingY: 1,
						},
					).render(width);
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
): Promise<{ command: string; reason: string }[]> {
	// Prefer git ls-files so we naturally respect .gitignore.
	const gitResult = await pi.exec(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{ cwd, signal, timeout: 5000 },
	);
	const stdout =
		gitResult.code === 0
			? gitResult.stdout
			: (
					await pi.exec(
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
					)
				).stdout;
	if (!stdout) return [];

	const triggers = new Map<string, string>();
	const flakeNixPath = join(cwd, "flake.nix");
	const flakeHasFmt =
		existsSync(flakeNixPath) && flakeHasFormatter(flakeNixPath);

	for (const relativePath of stdout.split("\n")) {
		if (!relativePath) continue;
		const ext = extname(relativePath).toLowerCase();
		const formatter = getFormatter(relativePath);
		if (formatter) {
			let cmd = formatter[0] ?? "";
			if (cmd === "alejandra" && flakeHasFmt) {
				cmd = "nix";
			}
			if (cmd && !triggers.has(cmd)) {
				triggers.set(cmd, relativePath);
			}
		}
		if (ext === ".cs" && !triggers.has("dotnet")) {
			triggers.set("dotnet", relativePath);
		}
	}

	return [...triggers.entries()]
		.map(([command, path]) => ({
			command,
			reason: `detected because of ${path}`,
		}))
		.sort((a, b) => a.command.localeCompare(b.command));
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
	const detected = await findProjectFormatterCommands(
		pi,
		ctx.cwd,
		ctx.signal,
	);
	const commands = detected.map((d) => d.command);
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

function findLocalPrettierFromRoot(cwd: string): string | undefined {
	let dir = cwd;
	while (true) {
		const prettier = join(dir, "node_modules", ".bin", "prettier");
		if (existsSync(prettier)) return prettier;
		const next = dirname(dir);
		if (next === dir) break;
		dir = next;
	}
	return undefined;
}

function findFlakeNix(file: string, cwd: string): string | undefined {
	let dir = dirname(file);
	while (true) {
		const flakeNix = join(dir, "flake.nix");
		if (existsSync(flakeNix)) return flakeNix;
		if (dir === cwd) break;
		const next = dirname(dir);
		if (next === dir) break;
		dir = next;
	}
	return undefined;
}

function flakeHasFormatter(flakePath: string): boolean {
	try {
		const content = readFileSync(flakePath, "utf8");
		return /\bformatter\b/.test(content);
	} catch {
		return false;
	}
}

async function warmFormatters(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	formatterCache.paths.clear();
	formatterCache.prettierPath = undefined;
	formatterCache.nixFormatter = undefined;

	const commands = getConfiguredFormatterCommands();
	await Promise.all(
		commands.map(async (command) => {
			const path = await commandPath(pi, cwd, command, signal);
			if (path) formatterCache.paths.set(command, path);
		}),
	);

	const prettier = findLocalPrettierFromRoot(cwd);
	if (prettier) formatterCache.prettierPath = prettier;

	const flakeNix = join(cwd, "flake.nix");
	if (existsSync(flakeNix) && flakeHasFormatter(flakeNix)) {
		for (const cmd of ["nixfmt", "alejandra", "nixpkgs-fmt"]) {
			const path = await commandPath(pi, cwd, cmd, signal);
			if (path) {
				formatterCache.nixFormatter = { command: cmd, path };
				break;
			}
		}
	} else {
		formatterCache.nixFormatter = null;
	}
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

async function resolveFormatter(
	pi: ExtensionAPI,
	file: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<
	{ command: string; args: string[]; commandName: string } | undefined
> {
	if (extname(file).toLowerCase() === ".cs") {
		const target = await findDotnetFormatTarget(pi, file, signal);
		if (!target) return undefined;
		return {
			command: "dotnet",
			args: ["format", target, "--include", file],
			commandName: "dotnet",
		};
	}

	const formatter = getFormatter(file);
	if (!formatter) return undefined;
	let [command, ...args] = formatter;
	if (command === "prettier")
		command =
			formatterCache.prettierPath ??
			findLocalPrettier(file, cwd) ??
			command;
	if (command === "alejandra") {
		if (formatterCache.nixFormatter) {
			command = formatterCache.nixFormatter.path;
			args = [];
		} else if (formatterCache.nixFormatter === undefined) {
			const flakeNix = findFlakeNix(file, cwd);
			if (flakeNix && flakeHasFormatter(flakeNix)) {
				command = "nix";
				args = ["fmt", "--"];
			}
		}
	}
	return {
		command,
		args: [...args, file],
		commandName: formatCommandName(command),
	};
}

async function formatFile(
	pi: ExtensionAPI,
	file: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<FormatResult | undefined> {
	const resolvedFile = resolve(cwd, file);
	if (!isUsableFile(resolvedFile)) return undefined;

	const formatterInfo = await resolveFormatter(pi, resolvedFile, cwd, signal);
	if (!formatterInfo) return undefined;

	const { command, args, commandName } = formatterInfo;

	const isCachedPath = command.startsWith("/");
	if (!isCachedPath) {
		const available = await pi.exec(
			"bash",
			["-lc", `command -v "$1"`, "--", command],
			{ cwd, signal, timeout: 2000 },
		);
		if (available.code !== 0) {
			return {
				commandName,
				changed: false,
				error: "formatter not available",
			};
		}
	}

	const before = readFileSync(resolvedFile, "utf8");
	const result = await pi.exec(command, args, {
		cwd,
		signal,
		timeout: FORMAT_TIMEOUT_MS,
	});
	if (result.code !== 0) {
		const output = (
			result.stderr ||
			result.stdout ||
			"formatter failed"
		).trim();
		return { commandName, changed: false, error: output };
	}

	const after = readFileSync(resolvedFile, "utf8");
	const changed = before !== after;
	return { commandName, changed };
}

async function getModifiedFiles(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const gitResult = await pi.exec("git", ["status", "--porcelain"], {
		cwd,
		signal,
		timeout: 5000,
	});
	if (gitResult.code === 0) {
		const files: string[] = [];
		for (const line of gitResult.stdout.split("\n")) {
			if (!line) continue;
			const status = line.slice(0, 2);
			const path = line.slice(3).trim();
			if (!path) continue;
			if (status === "??") continue;
			if (status.includes("D")) continue;
			if (status.includes("M") || status.includes("A")) {
				files.push(resolve(cwd, path));
			}
		}
		return files;
	}

	const jjResult = await pi.exec("jj", ["status"], {
		cwd,
		signal,
		timeout: 5000,
	});
	if (jjResult.code === 0) {
		const files: string[] = [];
		let inChanges = false;
		for (const line of jjResult.stdout.split("\n")) {
			if (line.startsWith("Working copy changes:")) {
				inChanges = true;
				continue;
			}
			if (!inChanges) continue;
			if (line.startsWith("Working copy ")) break;
			if (!line.trim()) continue;
			const match = line.match(/^([A-Z])\s+(.+)$/);
			if (!match) continue;
			const [, status, path] = match;
			if (status === "D") continue;
			files.push(resolve(cwd, path.trim()));
		}
		return files;
	}

	return [];
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("formatters", {
		description: "Show detected project formatters and availability",
		handler: async (_args, ctx) => {
			const detected = await findProjectFormatterCommands(
				pi,
				ctx.cwd,
				ctx.signal,
			);
			const detectedMap = new Map(
				detected.map((d) => [d.command, d.reason]),
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

					if (command === "prettier" && formatterCache.prettierPath) {
						lines.push(
							`  effective: ${formatterCache.prettierPath} (local)`,
						);
					}
					if (command === "nix") {
						if (formatterCache.nixFormatter) {
							lines.push(
								`  effective: ${formatterCache.nixFormatter.command} (${formatterCache.nixFormatter.path}) via flake formatter`,
							);
						} else if (formatterCache.nixFormatter === null) {
							lines.push(
								`  effective: global alejandra (no flake formatter)`,
							);
						}
					}
					if (
						command === "alejandra" &&
						formatterCache.nixFormatter
					) {
						lines.push(
							`  effective: overridden to ${formatterCache.nixFormatter.command} (${formatterCache.nixFormatter.path}) via flake formatter`,
						);
					}

					const reason = detectedMap.get(command);
					if (reason) {
						lines.push(`  reason: ${reason}`);
					}

					return {
						on: detectedMap.has(command),
						text: lines.join("\n"),
					};
				}),
			);
			await showToggleView(ctx, "formatters", entries);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		warmFormatters(pi, ctx.cwd, ctx.signal).catch(() => {});
		refreshFormatterStatus(pi, ctx).catch((error) => {
			if (isStaleContextError(error)) return;
			if (!setFormatterStatus(ctx, "error", "error")) return;
			notifyFormatterWarning(
				ctx,
				`Formatter status failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			ctx.ui.setStatus("autoformat", "");
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		const rawPath = getToolPath(event.toolName, event.input);
		if (!rawPath) return;

		const file = resolve(ctx.cwd, rawPath);
		const cwd = resolve(ctx.cwd);
		if (!isUsableFile(file)) return;
		const displayPath = formatDisplayPath(cwd, file);

		const formatResult = await formatFile(pi, file, cwd, ctx.signal);
		if (!formatResult) return;

		if (formatResult.error) {
			notifyFormatterWarning(
				ctx,
				`Formatter failed using ${formatResult.commandName}: ${formatResult.error}`,
			);
			await refreshFormatterStatus(pi, ctx);
			return;
		}

		if (formatResult.changed) {
			lastFormatMtime.set(file, statSync(file).mtimeMs);
		}

		setFormatterStatus(ctx, "dim", ` ${formatResult.commandName}`);
		await refreshFormatterStatus(pi, ctx);

		let content: any = event.content;
		if (formatResult.changed) {
			const notice = `Note: This file was autoformatted with ${formatResult.commandName} after the ${event.toolName}.`;
			if (typeof content === "string") {
				content = `${content}\n\n${notice}`;
			} else if (Array.isArray(content)) {
				content = [...content, { type: "text" as const, text: notice }];
			}
		}

		if (event.toolName !== "edit") {
			if (formatResult.changed) return { content };
			return;
		}

		const details = event.details as ToolResultDetails | undefined;
		if (typeof details?.originalContent !== "string") {
			if (formatResult.changed) return { content };
			return;
		}

		const diff = await computeUnifiedDiff(
			pi,
			details.originalContent,
			readFileSync(file, "utf8"),
			displayPath,
			ctx.signal,
		);
		const newDetails =
			diff === undefined
				? { ...details, formatter: formatResult.commandName }
				: { ...details, diff, formatter: formatResult.commandName };

		if (formatResult.changed) return { content, details: newDetails };
		return { details: newDetails };
	});

	pi.on("turn_end", async (event, ctx) => {
		const cwd = resolve(ctx.cwd);
		const modifiedFiles = await getModifiedFiles(pi, cwd, ctx.signal);
		const formatted: { path: string; formatter: string }[] = [];

		for (const file of modifiedFiles) {
			if (!isUsableFile(file)) continue;
			if (!getFormatter(file) && extname(file).toLowerCase() !== ".cs")
				continue;

			const mtime = statSync(file).mtimeMs;
			const lastFormatted = lastFormatMtime.get(file);
			if (lastFormatted !== undefined && mtime <= lastFormatted) continue;

			const result = await formatFile(pi, file, cwd, ctx.signal);
			if (!result || result.error) continue;

			if (result.changed) {
				lastFormatMtime.set(file, statSync(file).mtimeMs);
				formatted.push({
					path: relative(cwd, file),
					formatter: result.commandName,
				});
			}
		}

		if (formatted.length > 0) {
			const summary = formatted
				.map((f) => `${f.path} (${f.formatter})`)
				.join(", ");
			notifyFormatterInfo(
				ctx,
				`Autoformatted ${formatted.length} file${formatted.length === 1 ? "" : "s"}: ${summary}`,
			);
		}
	});
}
