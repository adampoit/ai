import {
	createEditTool,
	type ExtensionAPI,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Spacer, Text, type Component } from "@mariozechner/pi-tui";
import { CenteredBlockContent } from "../components/centered-block-content.js";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_RENDERED_LINES = 160;
const DELTA_PADDING_X = 1;
const DELTA_PADDING_Y = 1;
const DELTA_WIDTH_RATIO = 0.95;

function darkDeltaBackground(value: string): string {
	return `\x1b[48;2;50;48;47m${value}\x1b[49m`;
}

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

class Stacked implements Component {
	constructor(private readonly children: Component[]) {}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}
}

class DeltaDiff implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly diff: string,
		private readonly filePath: string | undefined,
		private readonly background: (value: string) => string,
		private readonly blockBackground: (value: string) => string,
		private readonly warning: (value: string) => string,
		private readonly footer?: string,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width)
			return this.cachedLines;

		const renderWidth = Math.max(1, Math.floor(width * DELTA_WIDTH_RATIO));
		const deltaWidth = Math.max(1, renderWidth - DELTA_PADDING_X * 2);
		let rendered: Component;
		try {
			const renderedDiff = renderWithDelta(
				this.diff,
				this.filePath,
				deltaWidth,
			);
			rendered = new Text(
				reapplyBackgroundAfterAnsiResets(renderedDiff, this.background),
				DELTA_PADDING_X,
				DELTA_PADDING_Y,
				this.background,
			);
		} catch (error) {
			const errorText =
				error instanceof Error ? error.message : String(error);
			const message = this.diff.trim()
				? `Diff rendering unavailable: ${errorText}`
				: "No diff produced";
			rendered = new Text(
				this.warning(message),
				DELTA_PADDING_X,
				DELTA_PADDING_Y,
				this.background,
			);
		}

		const renderedLines = rendered.render(renderWidth);
		if (this.footer) {
			renderedLines.push(
				this.blockBackground(" ".repeat(renderWidth)),
				...new Text(
					this.footer,
					DELTA_PADDING_X,
					0,
					this.blockBackground,
				).render(renderWidth),
				this.blockBackground(" ".repeat(renderWidth)),
			);
		}

		this.cachedWidth = width;
		const cachedLines = new CenteredBlockContent(
			new StaticLines(renderedLines),
			this.blockBackground,
			DELTA_WIDTH_RATIO,
		).render(width);
		this.cachedLines = cachedLines;
		return cachedLines;
	}
}

class StaticLines implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
}

class EditCallBlock implements Component {
	preview?: Preview;
	previewArgsKey?: string;
	previewPending = false;
	settled = false;
	settledError = false;
	formatter?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private args: unknown,
		private readonly theme: Parameters<
			NonNullable<ToolDefinition<any, DiffDetails>["renderCall"]>
		>[1],
	) {}

	setArgs(args: unknown): void {
		this.args = args;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width)
			return this.cachedLines;

		const args = this.args as EditArgs | undefined;
		const path = args?.path?.replace(/^@/, "") ?? "";
		const summary = summarizeEditArgs(args);
		const bg =
			this.settledError || (this.preview && "error" in this.preview)
				? (value: string) => this.theme.bg("toolErrorBg", value)
				: this.preview && "diff" in this.preview
					? (value: string) => this.theme.bg("toolSuccessBg", value)
					: (value: string) => this.theme.bg("toolPendingBg", value);

		const prefix = this.settled ? "" : `${spinner()} `;
		const header = new Text(
			`${prefix}${this.theme.fg("toolTitle", this.theme.bold("edit"))}${path ? ` ${this.theme.fg("accent", path)}` : ""}${summary ? ` ${this.theme.fg("muted", summary)}` : ""}`,
			1,
			1,
			bg,
		);
		const children: Component[] = [header];

		if (this.preview) {
			children.push(new Text("", 0, 0, bg));
			if ("error" in this.preview) {
				children.push(
					new Text(
						this.theme.fg("error", this.preview.error),
						1,
						0,
						bg,
					),
				);
			} else {
				children.push(
					new DeltaDiff(
						this.preview.diff,
						path,
						darkDeltaBackground,
						(value) => this.theme.bg("toolSuccessBg", value),
						(value) => this.theme.fg("warning", value),
						this.formatter
							? this.theme.fg("success", `✓ ${this.formatter}`)
							: undefined,
					),
				);
			}
		}

		if (this.formatter && (!this.preview || "error" in this.preview)) {
			children.push(
				new Text(
					this.theme.fg("success", `✓ ${this.formatter}`),
					1,
					0,
					bg,
				),
			);
		}

		this.cachedWidth = width;
		this.cachedLines = new Stacked(children).render(width);
		return this.cachedLines;
	}
}

function stripPiLineNumbers(lines: string[]): string[] {
	return lines.map((line) => {
		const match = line.match(/^([ +-])\s*\d+\s(.*)$/);
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

function reapplyBackgroundAfterAnsiResets(
	text: string,
	background: (value: string) => string,
): string {
	const marker = "__PI_BACKGROUND_MARKER__";
	const styledMarker = background(marker);
	const markerIndex = styledMarker.indexOf(marker);
	if (markerIndex === -1) return text;

	const backgroundPrefix = styledMarker.slice(0, markerIndex);
	const resetPattern = /\x1b\[(?:0|39|49)m/g;
	return text
		.split("\n")
		.map(
			(line) =>
				backgroundPrefix +
				line.replace(
					resetPattern,
					(match) => `${match}${backgroundPrefix}`,
				),
		)
		.join("\n");
}

function spinner(): string {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	return frames[Math.floor(Date.now() / 120) % frames.length] ?? frames[0];
}

function countLines(value: string | undefined): number {
	if (!value) return 0;
	return value.split("\n").length;
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

function computePreviewDiff(args: Required<EditArgs>): Preview {
	const filePath = resolve(process.cwd(), args.path);
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
		["--side-by-side", "--paging=never", "--width", String(width)],
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

	const lines = result.stdout.trimEnd().split("\n");
	if (lines.length <= MAX_RENDERED_LINES) return result.stdout.trimEnd();

	return [
		...lines.slice(0, MAX_RENDERED_LINES),
		`... ${lines.length - MAX_RENDERED_LINES} more diff lines`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const originalEdit = createEditTool(process.cwd()) as ToolDefinition<
		any,
		DiffDetails
	>;

	const customEditBlockTool: ToolDefinition<any, DiffDetails> = {
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const editParams = params as { path: string };
			const path = editParams.path?.replace(/^@/, "");
			onUpdate?.({
				content: [{ type: "text", text: "Applying edit..." }],
				details: {},
			});
			let originalContent: string | undefined;
			try {
				originalContent = path
					? readFileSync(resolve(process.cwd(), path), "utf8")
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
			const state = context.state as { callBlock?: EditCallBlock };
			const block = state.callBlock ?? new EditCallBlock(args, theme);
			state.callBlock = block;
			block.setArgs(args);

			const previewInput = getPreviewInput(args);
			const argsKey = previewInput
				? JSON.stringify(previewInput)
				: undefined;
			if (block.previewArgsKey !== argsKey) {
				block.preview = undefined;
				block.previewArgsKey = argsKey;
				block.previewPending = false;
				block.settled = false;
				block.settledError = false;
				block.formatter = undefined;
			}

			if (
				context.argsComplete &&
				previewInput &&
				!block.preview &&
				!block.previewPending
			) {
				block.previewPending = true;
				const requestKey = argsKey;
				void Promise.resolve()
					.then(() => computePreviewDiff(previewInput))
					.catch(
						(error): Preview => ({
							error:
								error instanceof Error
									? error.message
									: String(error),
						}),
					)
					.then((preview) => {
						if (block.previewArgsKey !== requestKey) return;
						block.preview = preview;
						block.previewPending = false;
						block.invalidate();
						context.invalidate();
					});
			}

			return block;
		},

		renderResult(result, options, theme, context) {
			const state = context.state as { callBlock?: EditCallBlock };
			const callBlock = state.callBlock;
			const content = result.content[0];
			const errorText =
				content?.type === "text" && content.text.trim()
					? content.text.trim().split("\n")[0]
					: "Edit failed";

			if (callBlock) {
				const previousFormatter = callBlock.formatter;
				const previousSettled = callBlock.settled;
				const previousSettledError = callBlock.settledError;
				const previousPreview = callBlock.preview;

				callBlock.settled = !options.isPartial;
				callBlock.settledError = context.isError;
				callBlock.formatter = result.details?.formatter;
				if (context.isError) {
					callBlock.preview = { error: errorText };
					callBlock.previewPending = false;
				} else if (typeof result.details?.diff === "string") {
					callBlock.preview = { diff: result.details.diff };
					callBlock.previewPending = false;
				}
				callBlock.invalidate();

				const previewChanged =
					previousPreview !== callBlock.preview &&
					(typeof previousPreview !== "object" ||
						typeof callBlock.preview !== "object" ||
						JSON.stringify(previousPreview) !==
							JSON.stringify(callBlock.preview));
				if (
					previousFormatter !== callBlock.formatter ||
					previousSettled !== callBlock.settled ||
					previousSettledError !== callBlock.settledError ||
					previewChanged
				) {
					context.invalidate();
				}
			}

			if (options.isPartial || context.isError) {
				if (callBlock) return new Stacked([]);

				if (context.isError) {
					const originalResult = originalEdit.renderResult?.(
						result,
						options,
						theme,
						context,
					);
					if (originalResult) return originalResult;

					return new Text(theme.fg("error", errorText), 0, 0);
				}

				return new Stacked([]);
			}

			if (callBlock && typeof result.details?.diff === "string") {
				return new Stacked([]);
			}

			if (typeof result.details?.diff === "string") {
				const diff = new DeltaDiff(
					result.details.diff,
					(context.args as { path?: string } | undefined)?.path,
					darkDeltaBackground,
					(value) => theme.bg("toolSuccessBg", value),
					(value) => theme.fg("warning", value),
					result.details.formatter
						? theme.fg("success", `✓ ${result.details.formatter}`)
						: undefined,
				);

				return new Stacked([new Spacer(1), diff]);
			}

			const successText =
				content?.type === "text" && content.text.trim()
					? content.text.trim().split("\n")[0]
					: "Applied";
			return new Text(
				theme.fg("success", `${successText} (no diff returned)`),
				0,
				0,
			);
		},
	};

	pi.registerTool(customEditBlockTool);
}
