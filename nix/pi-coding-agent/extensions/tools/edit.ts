import {
	createEditTool,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
	CachedComponent,
	gruvbox,
	gruvboxBackground,
	reapplyBackgroundAfterAnsiResets,
	StaticLines,
	styleText,
	ToolShell,
	type BadgeSpec,
	type ExpansionAwareComponent,
	type ToolShellOptions,
} from "../../components/index.ts";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { countLines, firstTextLine, textOutput } from "./shared.ts";

const COLLAPSED_RENDERED_LINES = 32;
const EXPANDED_RENDERED_LINES = 160;

type DiffDetails = {
	diff?: string;
	formatter?: string;
	originalContent?: string;
	renderedDiff?: string;
	renderedDiffError?: string;
};

type EditArgs = {
	path?: string;
	edits?: Array<{ oldText?: string; newText?: string }>;
};

type Preview = { diff: string } | { error: string };

class DeltaDiff extends CachedComponent implements ExpansionAwareComponent {
	constructor(
		private readonly diff: string,
		private readonly filePath: string | undefined,
		private readonly background: (value: string) => string,
		private readonly warning: (value: string) => string,
		private readonly maxRenderedLines: number,
	) {
		super();
	}

	hasExpandableContent(): boolean {
		return (
			countLines(toUnifiedDiff(this.diff, this.filePath)) >
			COLLAPSED_RENDERED_LINES
		);
	}

	protected doRender(width: number): string[] {
		let rendered: Component;
		try {
			const renderedDiff = renderWithDelta(
				this.diff,
				this.filePath,
				width,
			);
			const lines = renderedDiff.split("\n");
			const visible = lines.slice(0, this.maxRenderedLines);
			let output = visible.join("\n");
			if (lines.length > this.maxRenderedLines) {
				output +=
					"\n" +
					styleText(
						`… ${lines.length - this.maxRenderedLines} more diff lines`,
						{ fg: gruvbox.gray },
					);
			}
			rendered = new Text(
				reapplyBackgroundAfterAnsiResets(output, this.background),
				0,
				0,
				this.background,
			);
		} catch (error) {
			const errorText =
				error instanceof Error ? error.message : String(error);
			const message = this.diff.trim()
				? `Diff rendering unavailable: ${errorText}`
				: "No diff produced";
			rendered = new Text(this.warning(message), 0, 0, this.background);
		}

		return rendered.render(width);
	}
}

type ResultInfo = {
	result: AgentToolResult<DiffDetails>;
	options: ToolRenderResultOptions;
	isError: boolean;
};

type EditState = {
	shell?: ToolShell;
	info?: ResultInfo;
	preview?: Preview;
	previewArgsKey?: string;
	previewPending?: boolean;
	deltaDiff?: DeltaDiff;
	lastDiff?: string;
	lastExpanded?: boolean;
};

type EditRenderContext = {
	executionStarted: boolean;
	expanded: boolean;
};

function buildEditShell(
	args: EditArgs | undefined,
	state: EditState,
	theme: Theme,
	_context: EditRenderContext,
): ToolShellOptions {
	const path = args?.path?.replace(/^@/, "") ?? "";
	const summary = summarizeEditArgs(args);

	const info = state.info;
	const isPartial = info?.options.isPartial ?? true;
	const isError = info?.isError ?? false;
	const settled = !isPartial;
	const settledError = isError;
	const formatter = info?.result.details?.formatter;

	let preview: Preview | undefined;
	if (info) {
		if (isError) {
			const text = textOutput(info.result);
			preview = {
				error: text ? firstTextLine(text) : "Edit failed",
			};
		} else if (typeof info.result.details?.diff === "string") {
			preview = { diff: info.result.details.diff };
		}
	} else {
		preview = state.preview;
	}

	const isErrorState = settledError || (preview && "error" in preview);
	const shellState = isErrorState ? "error" : settled ? "success" : "pending";
	const status = settled
		? isErrorState
			? "error"
			: "applied"
		: state.previewPending
			? "preview"
			: "editing";

	const invocation = path
		? {
				command: "edit",
				icon: "",
				args: [
					{ label: "path", value: path },
					...(summary ? [{ label: "changes", value: summary }] : []),
				],
			}
		: undefined;

	const expanded = info?.options.expanded ?? _context.expanded;
	const telemetry: BadgeSpec[] = [];
	if (formatter) {
		telemetry.push({
			text: formatter,
			icon: "fmt",
			fg: gruvbox.bg,
			bg: gruvbox.green,
		});
	}

	const children: Component[] = [];
	if (preview) {
		if ("error" in preview) {
			children.push(new Text(theme.fg("error", preview.error), 0, 0));
		} else {
			if (
				!state.deltaDiff ||
				state.lastDiff !== preview.diff ||
				state.lastExpanded !== expanded
			) {
				state.deltaDiff = new DeltaDiff(
					preview.diff,
					path,
					gruvboxBackground("bg1"),
					(value) => theme.fg("warning", value),
					expanded
						? EXPANDED_RENDERED_LINES
						: COLLAPSED_RENDERED_LINES,
				);
				state.lastDiff = preview.diff;
				state.lastExpanded = expanded;
			}
			children.push(state.deltaDiff);
		}
	}

	return {
		title: "edit",
		icon: "",
		accent: gruvbox.orange,
		state: shellState,
		status,
		invocation,
		telemetry,
		expansion: { expanded },
		theme,
		children,
	};
}

function stripPiLineNumbers(lines: string[]): string[] {
	return lines.map((line) => {
		const match = line.match(/^([ +\-])\s*\d+\s(.*)$/);
		return match ? `${match[1]}${match[2]}` : line;
	});
}

function toUnifiedDiff(diff: string, filePath = "edited file"): string {
	const lines = diff.split("\n");

	if (diff.startsWith("diff --git ") || diff.startsWith("--- ")) {
		return stripPiLineNumbers(lines).join("\n");
	}

	const oldNumbers = lines
		.map((line) => line.match(/^[- ](\d+) /)?.[1])
		.filter(Boolean)
		.map(Number);
	const newNumbers = lines
		.map((line) => line.match(/^[+ ](\d+) /)?.[1])
		.filter(Boolean)
		.map(Number);

	const oldStart = oldNumbers[0] ?? 1;
	const newStart = newNumbers[0] ?? 1;
	const oldCount = oldNumbers.length || 1;
	const newCount = newNumbers.length || 1;
	const body = stripPiLineNumbers(lines);

	return [
		`--- a/${filePath}`,
		`+++ b/${filePath}`,
		`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
		...body,
	].join("\n");
}

function summarizeEditArgs(args: EditArgs | undefined): string {
	const edits = Array.isArray(args?.edits) ? args.edits : [];
	if (edits.length === 0) return "";

	let newLines = 0;
	let oldLines = 0;
	for (const edit of edits) {
		newLines += countLines(edit?.newText);
		oldLines += countLines(edit?.oldText);
	}

	const replacementLabel =
		edits.length === 1 ? "replacement" : "replacements";
	return `${edits.length} ${replacementLabel} • ${oldLines} lines → ${newLines} lines`;
}

function getPreviewInput(args: unknown): Required<EditArgs> | undefined {
	const input = args as EditArgs | undefined;
	if (
		!input?.path ||
		!Array.isArray(input.edits) ||
		input.edits.length === 0
	) {
		return undefined;
	}
	if (
		!input.edits.every(
			(edit) =>
				typeof edit?.oldText === "string" &&
				typeof edit?.newText === "string",
		)
	) {
		return undefined;
	}
	return {
		path: input.path.replace(/^@/, ""),
		edits: input.edits as Required<EditArgs>["edits"],
	};
}

function computePreviewDiff(args: Required<EditArgs>, cwd: string): Preview {
	const filePath = resolve(cwd, args.path);
	const original = readFileSync(filePath, "utf8");
	const replacements = args.edits
		.map((edit) => {
			const oldText = edit.oldText ?? "";
			const newText = edit.newText ?? "";
			const first = original.indexOf(oldText);
			if (first === -1) throw new Error("Replacement text was not found");
			if (original.indexOf(oldText, first + oldText.length) !== -1) {
				throw new Error("Replacement text is not unique");
			}
			return { start: first, end: first + oldText.length, newText };
		})
		.sort((a, b) => a.start - b.start);

	for (let i = 1; i < replacements.length; i++) {
		if (replacements[i - 1]!.end > replacements[i]!.start) {
			throw new Error("Replacement blocks overlap");
		}
	}

	let updated = "";
	let cursor = 0;
	for (const replacement of replacements) {
		updated += original.slice(cursor, replacement.start);
		updated += replacement.newText;
		cursor = replacement.end;
	}
	updated += original.slice(cursor);

	const dir = mkdtempSync(join(tmpdir(), "pi-edit-preview-"));
	try {
		const before = join(dir, "before");
		const after = join(dir, "after");
		writeFileSync(before, original, "utf8");
		writeFileSync(after, updated, "utf8");
		const result = spawnSync("diff", ["-u", before, after], {
			encoding: "utf8",
		});
		if (result.status !== 0 && result.status !== 1) {
			throw new Error(
				result.stderr || `diff exited with status ${result.status}`,
			);
		}
		return {
			diff: result.stdout
				.replaceAll(before, `a/${args.path}`)
				.replaceAll(after, `b/${args.path}`),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function renderWithDelta(
	diff: string,
	filePath: string | undefined,
	width: number,
): string {
	const result = spawnSync(
		"delta",
		[
			"--side-by-side",
			"--paging=never",
			"--file-style=omit",
			"--width",
			String(width),
		],
		{
			input: toUnifiedDiff(diff, filePath),
			encoding: "utf8",
			env: {
				...process.env,
				NO_COLOR: undefined,
			},
		},
	);

	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			result.stderr || `delta exited with status ${result.status}`,
		);
	}

	return result.stdout.trimEnd();
}

export default function registerEditTool(pi: ExtensionAPI) {
	const originalEdit = createEditTool(process.cwd()) as ToolDefinition<
		any,
		DiffDetails
	>;

	const editTool: ToolDefinition<any, DiffDetails> = {
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const editParams = params as { path: string };
			const path = editParams.path?.replace(/^@/, "");
			let originalContent: string | undefined;
			try {
				originalContent = path
					? readFileSync(resolve(ctx.cwd, path), "utf8")
					: undefined;
			} catch {
				originalContent = undefined;
			}
			const result = await originalEdit.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			);

			if (result.details && originalContent !== undefined) {
				result.details.originalContent = originalContent;
			}

			return result;
		},

		renderCall(args, theme, context) {
			const state = context.state as EditState;
			const shell = state.shell ?? new ToolShell({ title: "edit" });
			state.shell = shell;

			const previewInput = getPreviewInput(args);
			const argsKey = previewInput
				? JSON.stringify(previewInput)
				: undefined;
			if (state.previewArgsKey !== argsKey) {
				state.preview = undefined;
				state.previewArgsKey = argsKey;
				state.previewPending = false;
				state.deltaDiff = undefined;
				state.lastDiff = undefined;
				state.lastExpanded = undefined;
			}

			if (
				context.argsComplete &&
				previewInput &&
				!state.preview &&
				!state.previewPending
			) {
				state.previewPending = true;
				const requestKey = argsKey;
				void Promise.resolve()
					.then(() => computePreviewDiff(previewInput, context.cwd))
					.catch(
						(error): Preview => ({
							error:
								error instanceof Error
									? error.message
									: String(error),
						}),
					)
					.then((preview) => {
						if (state.previewArgsKey !== requestKey) return;
						state.preview = preview;
						state.previewPending = false;
						context.invalidate();
					});
			}

			shell.setOptions(
				buildEditShell(args as EditArgs, state, theme, {
					executionStarted: context.executionStarted,
					expanded: context.expanded,
				}),
			);
			return shell;
		},

		renderResult(result, options, theme, context) {
			const state = context.state as EditState;
			state.info = { result, options, isError: context.isError };
			state.shell?.setOptions(
				buildEditShell(context.args as EditArgs, state, theme, {
					executionStarted: context.executionStarted,
					expanded: context.expanded,
				}),
			);
			return new StaticLines([]);
		},
	};

	pi.registerTool(editTool);
}
