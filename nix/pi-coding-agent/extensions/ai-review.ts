import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type NvimRunResult = {
	exitCode: number | null;
	stderr: string;
	error?: string;
	signal?: NodeJS.Signals | null;
};

type SelectionArtifact = {
	schema: "unified-review.agent-selection.v1";
	selected_at?: string;
	label?: string;
	description?: string;
	target?: unknown;
	open_command?: string;
};

type ContextArtifact = {
	schema?: string;
	session?: { id?: string; kind?: string; target?: unknown };
	files?: Array<{ path?: string; raw_patch?: string }>;
};

type ImportDiagnostics = {
	status?: string;
	message?: string;
	result?: {
		imported_threads?: number;
		imported_comments?: number;
		updated_threads?: number;
		skipped?: unknown[];
		warnings?: unknown[];
		session_id?: string;
	};
	v_errmsg?: string;
	messages?: string;
};

type ReviewWorkspace = {
	tempDir: string;
	selectionPath: string;
	contextPath: string;
	feedbackPath: string;
	importDiagnosticsPath: string;
	selection: SelectionArtifact;
	context: ContextArtifact;
};

type PendingReview = ReviewWorkspace;

type ImportedReview = ReviewWorkspace & {
	keepTempDir?: boolean;
};

async function tryExec(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	args: string[],
	timeout = 5000,
): Promise<ExecResult | undefined> {
	try {
		return await pi.exec(command, args, { cwd, timeout });
	} catch {
		return undefined;
	}
}

async function commandExists(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
): Promise<boolean> {
	const result = await tryExec(
		pi,
		cwd,
		"bash",
		["-lc", 'command -v "$1"', "--", command],
		2000,
	);
	return result?.code === 0;
}

function luaString(value: string): string {
	return JSON.stringify(value);
}

function luaJson(value: unknown): string {
	return `vim.json.decode(${luaString(JSON.stringify(value))})`;
}

function readTextIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

function readJsonIfExists<T>(path: string): T | undefined {
	const text = readTextIfExists(path);
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function lastInterestingLines(text: string | undefined, count = 10): string {
	return (text ?? "")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(-count)
		.join("\n");
}

function nvimExitSummary(
	result: NvimRunResult,
	diagnostics?: ImportDiagnostics,
): string {
	const details = [
		result.signal
			? `nvim was terminated by ${result.signal}`
			: `nvim exited with code ${result.exitCode ?? "unknown"}`,
	];
	if (diagnostics?.status) details.push(`status: ${diagnostics.status}`);
	if (diagnostics?.message) details.push(`message: ${diagnostics.message}`);
	if (diagnostics?.v_errmsg)
		details.push(`v:errmsg: ${diagnostics.v_errmsg}`);
	const messages = lastInterestingLines(diagnostics?.messages);
	if (messages) details.push(`:messages:\n${messages}`);
	return details.join("\n");
}

function runInteractiveNvim(
	ctx: {
		cwd: string;
		ui: { custom: <T>(factory: any, options?: any) => Promise<T> };
	},
	args: string[],
	env?: NodeJS.ProcessEnv,
) {
	return ctx.ui.custom<NvimRunResult>(
		(
			tui: any,
			_theme: any,
			_keybindings: any,
			done: (result: NvimRunResult) => void,
		) => {
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			const child = spawnSync("nvim", args, {
				cwd: ctx.cwd,
				stdio: "inherit",
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			tui.start();
			tui.requestRender(true);
			done({
				exitCode: child.status,
				stderr: "",
				error: child.error?.message,
				signal: child.signal,
			});
			return { render: () => [], invalidate: () => {} };
		},
		{ overlay: false },
	);
}

async function runHeadlessNvim(
	pi: ExtensionAPI,
	cwd: string,
	initPath: string,
	timeout = 120_000,
): Promise<NvimRunResult> {
	const result = await tryExec(
		pi,
		cwd,
		"nvim",
		[
			"--headless",
			"--cmd",
			"let g:auto_session_enabled = v:false",
			"--cmd",
			"lua vim.g.session_autoload = false",
			"-S",
			initPath,
		],
		timeout,
	);
	return {
		exitCode: result?.code ?? null,
		stderr: result?.stderr ?? "",
	};
}

function buildContextInit(path: string, target: unknown): string {
	return [
		`local context_path = ${luaString(path)}`,
		`local target = ${luaJson(target)}`,
		"local agent_feedback = require('unified_review.agent_feedback')",
		"local result, err = agent_feedback.write_context(context_path, { target = target })",
		"if not result then",
		"  error(err and err.message or 'failed to write agent context')",
		"end",
		"vim.cmd('qa')",
	].join("\n");
}

function buildImportInit(
	feedbackPath: string,
	diagnosticsPath: string,
	target: unknown,
): string {
	return [
		`local feedback_path = ${luaString(feedbackPath)}`,
		`local diagnostics_path = ${luaString(diagnosticsPath)}`,
		`local target = ${luaJson(target)}`,
		"local function collect_messages()",
		"  local ok, result = pcall(vim.api.nvim_exec2, 'messages', { output = true })",
		"  return ok and result.output or ''",
		"end",
		"local function write(status, fields)",
		"  fields = fields or {}",
		"  fields.status = status",
		"  fields.v_errmsg = vim.v.errmsg",
		"  fields.messages = collect_messages()",
		"  pcall(vim.fn.writefile, { vim.json.encode(fields) }, diagnostics_path)",
		"end",
		"local ok, result_or_err = pcall(function()",
		"  local result, err = require('unified_review.agent_feedback').import_file(feedback_path, { target = target, refresh_ui = false })",
		"  if not result then error(err and err.message or 'failed to import agent feedback') end",
		"  return result",
		"end)",
		"if ok then write('imported', { result = result_or_err }) else write('error', { message = tostring(result_or_err) }) end",
		"vim.cmd(ok and 'qa' or 'cqa')",
	].join("\n");
}

function buildOpenInit(target: unknown): string {
	return [
		`local target = ${luaJson(target)}`,
		"vim.api.nvim_create_autocmd('VimEnter', { once = true, callback = function()",
		"  vim.schedule(function() require('unified_review.session.manager').open_target(target, {}) end)",
		"end })",
	].join("\n");
}

function formatReviewPrompt(context: ContextArtifact): string {
	return [
		"Review the selected unified-review target using only the diff context below plus repository files you inspect as needed.",
		"",
		"Return feedback by calling the `submit_ai_review_feedback` tool exactly once.",
		"Do not edit files as part of this review. Only submit structured review feedback.",
		"Prefer comments on changed lines on the `right` side. Use file-level comments only when no precise line applies.",
		"If there are no issues, submit an empty `comments` array with a short summary.",
		"",
		"The tool payload must match `unified-review.agent-feedback.v1`.",
		"Use stable `id` values for comments so repeated imports can update instead of duplicate them.",
		"",
		"Diff context JSON:",
		"```json",
		JSON.stringify(context, null, 2),
		"```",
	].join("\n");
}

const sideSchema = StringEnum(["left", "right"] as const);
const fileTargetSchema = Type.Object({
	kind: Type.Literal("file"),
	path: Type.String(),
});
const lineTargetSchema = Type.Object({
	kind: Type.Literal("line"),
	path: Type.String(),
	side: sideSchema,
	line: Type.Number(),
});
const rangeTargetSchema = Type.Object({
	kind: Type.Literal("range"),
	path: Type.String(),
	start_side: sideSchema,
	start_line: Type.Number(),
	side: sideSchema,
	line: Type.Number(),
});
const feedbackSchema = Type.Object({
	schema: Type.Literal("unified-review.agent-feedback.v1"),
	author: Type.Optional(Type.String()),
	source: Type.Optional(
		Type.Object({
			name: Type.String(),
			run_id: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
		}),
	),
	summary: Type.Optional(Type.String()),
	comments: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String()),
			body: Type.String(),
			author: Type.Optional(Type.String()),
			severity: Type.Optional(
				StringEnum(["error", "warning", "info", "nit"] as const),
			),
			category: Type.Optional(Type.String()),
			target: Type.Union([
				fileTargetSchema,
				lineTargetSchema,
				rangeTargetSchema,
			]),
		}),
	),
});

export default function (pi: ExtensionAPI) {
	let pendingReview: PendingReview | undefined;
	let importedReviewToOpen: ImportedReview | undefined;
	let promptingToOpenReview = false;

	pi.on("agent_end", async (_event, ctx) => {
		if (promptingToOpenReview || !importedReviewToOpen || !ctx.hasUI)
			return;
		promptingToOpenReview = true;
		const review = importedReviewToOpen;
		importedReviewToOpen = undefined;
		try {
			const openNow = await ctx.ui.confirm(
				"Open Neovim review now?",
				"AI review feedback was imported as local draft comments.",
			);
			if (openNow) {
				const openInitPath = join(review.tempDir, "open-init.lua");
				writeFileSync(
					openInitPath,
					buildOpenInit(review.selection.target),
				);
				await runInteractiveNvim(ctx, ["-S", openInitPath]);
			}
		} finally {
			promptingToOpenReview = false;
			if (!review.keepTempDir) {
				rmSync(review.tempDir, { recursive: true, force: true });
			}
		}
	});

	pi.registerTool({
		name: "submit_ai_review_feedback",
		label: "Submit AI Review Feedback",
		description:
			"Submit structured unified-review agent feedback for the active /ai-review workflow.",
		promptSnippet:
			"Submit unified-review.agent-feedback.v1 JSON after completing an /ai-review code review.",
		promptGuidelines: [
			"Use submit_ai_review_feedback exactly once when completing an /ai-review workflow; do not write review JSON to arbitrary files yourself.",
		],
		parameters: feedbackSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!pendingReview) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: "No active /ai-review workflow is waiting for feedback.",
						},
					],
					details: {},
				};
			}

			const review = {
				...params,
				author: params.author ?? "pi-agent",
				source: {
					name: params.source?.name ?? "pi-coding-agent",
					run_id:
						params.source?.run_id ??
						pendingReview.selection.selected_at,
					model:
						params.source?.model ??
						(ctx.model
							? `${ctx.model.provider}/${ctx.model.id}`
							: undefined),
				},
			};
			writeFileSync(
				pendingReview.feedbackPath,
				JSON.stringify(review, null, 2),
			);

			const importInitPath = join(
				pendingReview.tempDir,
				"import-init.lua",
			);
			writeFileSync(
				importInitPath,
				buildImportInit(
					pendingReview.feedbackPath,
					pendingReview.importDiagnosticsPath,
					pendingReview.selection.target,
				),
			);
			const nvimResult = await runHeadlessNvim(
				pi,
				ctx.cwd,
				importInitPath,
			);
			const diagnostics = readJsonIfExists<ImportDiagnostics>(
				pendingReview.importDiagnosticsPath,
			);
			if (nvimResult.exitCode !== 0 || diagnostics?.status === "error") {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Failed to import review feedback.\n${nvimExitSummary(nvimResult, diagnostics)}`,
						},
					],
					details: { diagnostics, nvimResult },
				};
			}

			const imported = diagnostics?.result?.imported_comments ?? 0;
			const updated = diagnostics?.result?.updated_threads ?? 0;
			const skipped = diagnostics?.result?.skipped?.length ?? 0;
			ctx.ui.notify(
				`Imported ${imported} AI review comment(s), updated ${updated}, skipped ${skipped}.`,
				skipped > 0 ? "warning" : "info",
			);

			const keepTempDir = Boolean(diagnostics?.result?.warnings?.length);
			const completed = pendingReview;
			pendingReview = undefined;
			if (ctx.hasUI) {
				importedReviewToOpen = { ...completed, keepTempDir };
			} else if (!keepTempDir) {
				rmSync(completed.tempDir, { recursive: true, force: true });
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Imported ${imported} AI review comment(s), updated ${updated}, skipped ${skipped}.`,
					},
				],
				details: { diagnostics },
			};
		},
	});

	pi.registerCommand("ai-review", {
		description:
			"Pick a unified-review target in Neovim, ask the agent to review it, and import feedback as draft comments",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"/ai-review requires the interactive TUI",
					"error",
				);
				return;
			}
			if (!(await commandExists(pi, ctx.cwd, "nvim"))) {
				ctx.ui.notify("nvim was not found on PATH.", "error");
				return;
			}

			const tempDir = mkdtempSync(join(tmpdir(), "pi-ai-review-"));
			const selectionPath = join(tempDir, "selection.json");
			const contextPath = join(tempDir, "context.json");
			const feedbackPath = join(tempDir, "feedback.json");
			const importDiagnosticsPath = join(
				tempDir,
				"import-diagnostics.json",
			);
			let keepTempDir = false;

			try {
				const selectResult = await runInteractiveNvim(ctx, [
					"--cmd",
					"let g:auto_session_enabled = v:false",
					"--cmd",
					"lua vim.g.session_autoload = false",
					"-c",
					`UnifiedReview agent-select ${selectionPath}`,
				]);
				if (selectResult.error) {
					ctx.ui.notify(
						`Failed to launch nvim: ${selectResult.error}`,
						"error",
					);
					return;
				}

				const selection =
					readJsonIfExists<SelectionArtifact>(selectionPath);
				if (!selection?.target) {
					ctx.ui.notify("No review target was selected.", "warning");
					return;
				}

				const contextInitPath = join(tempDir, "context-init.lua");
				writeFileSync(
					contextInitPath,
					buildContextInit(contextPath, selection.target),
				);
				const contextResult = await runHeadlessNvim(
					pi,
					ctx.cwd,
					contextInitPath,
				);
				if (contextResult.exitCode !== 0) {
					keepTempDir = true;
					ctx.ui.notify(
						`Failed to export AI review context. Temp files retained in ${tempDir}.`,
						"error",
					);
					return;
				}

				const context = readJsonIfExists<ContextArtifact>(contextPath);
				if (!context) {
					keepTempDir = true;
					ctx.ui.notify(
						`Neovim did not write review context. Temp files retained in ${tempDir}.`,
						"error",
					);
					return;
				}

				pendingReview = {
					tempDir,
					selectionPath,
					contextPath,
					feedbackPath,
					importDiagnosticsPath,
					selection,
					context,
				};
				keepTempDir = true;
				ctx.ui.notify(
					`Selected ${selection.label ?? "review target"}; queued AI review for ${context.files?.length ?? 0} file(s).`,
					"info",
				);
				pi.sendUserMessage(formatReviewPrompt(context), {
					deliverAs: "followUp",
				});
			} finally {
				if (!keepTempDir)
					rmSync(tempDir, { recursive: true, force: true });
			}
		},
	});
}
