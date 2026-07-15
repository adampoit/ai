import type {
	ExtensionAPI,
	ReadToolDetails,
	ReadToolInput,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	CodePane,
	gruvbox,
	StaticLines,
	ToolPresentation,
	type BadgeSpec,
	type ToolPresentationModel,
} from "../../components/index.ts";
import {
	countLines,
	displayPath,
	isExpanded,
	pendingText,
	safeString,
	textOutput,
	type ResultInfo,
	type SkinRenderContext,
	type SkinState,
} from "./shared.ts";

const COLLAPSED_READ_LINES = 18;

function normalizeReadCode(output: string): string {
	if (!output) return output;
	const lines = output.split(/\r?\n/);
	const codeLines = lines.filter(
		(line) => !/^\s*…\s+\d+\s+more lines\s*$/.test(line),
	);
	const stripped = codeLines.map((line) => {
		const match = line.match(/^\s*\d+\s*\| ?(.*)$/);
		return match ? match[1]! : line;
	});
	const guttered = stripped.filter(
		(line, index) => line !== codeLines[index],
	).length;
	const code =
		guttered >= Math.max(1, Math.floor(codeLines.length * 0.5))
			? stripped.join("\n")
			: codeLines.join("\n");
	return code;
}

function lineRange(args: ReadToolInput): string | undefined {
	if (args.offset === undefined && args.limit === undefined) return undefined;
	if (args.offset !== undefined && args.limit !== undefined)
		return `L${args.offset}+${args.limit}`;
	if (args.offset !== undefined) return `from L${args.offset}`;
	return `limit ${args.limit}`;
}

function buildReadPresentation(
	args: ReadToolInput,
	info: ResultInfo<ReadToolDetails | undefined> | undefined,
	theme: Theme,
	context: SkinRenderContext,
): ToolPresentationModel {
	const path = safeString(args.path);
	const output = textOutput(info?.result);
	const codeOutput = normalizeReadCode(output);
	const content = info?.result.content ?? [];
	const hasImage = content.some((item) => item.type === "image");
	const isPending = !info || info.options.isPartial;
	const state = info?.isError ? "error" : isPending ? "pending" : "success";
	const status = info?.isError
		? "error"
		: isPending
			? context.executionStarted
				? "reading"
				: "queued"
			: hasImage
				? "image"
				: "ok";
	const lineCount = countLines(codeOutput || output);
	const details = info?.result.details;
	const expanded = isExpanded(info, context);
	const range = lineRange(args);
	const invocation = {
		command: "read",
		icon: "󰈙",
		args: [
			{ label: "path", value: displayPath(path || "…") },
			...(range ? [{ label: "range", value: range }] : []),
		],
	};

	const telemetry: BadgeSpec[] = [];
	if (output) telemetry.push({ text: `${lineCount} lines`, bg: gruvbox.bg1 });
	if (details?.truncation?.truncated)
		telemetry.push({
			text: "truncated",
			fg: gruvbox.bg,
			bg: gruvbox.yellow,
		});

	const body = output
		? new CodePane({
				code: codeOutput || output,
				path,
				startLine: args.offset ?? 1,
				maxLines: expanded ? 140 : COLLAPSED_READ_LINES,
				expansionLimit: COLLAPSED_READ_LINES,
				theme,
			})
		: new StaticLines([
				theme.fg(
					"muted",
					hasImage
						? "image attachment rendered below"
						: pendingText(context.executionStarted),
				),
			]);

	return {
		title: "read",
		icon: "󰈙",
		accent: gruvbox.blue,
		state,
		status,
		invocation,
		telemetry,
		expansion: { expanded },
		theme,
		background: gruvbox.bg1,
		children: body,
	};
}

export default function registerReadTool(pi: ExtensionAPI) {
	const originalRead = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...originalRead,
		renderShell: "default",
		renderCall(args, theme, context) {
			const state = context.state as SkinState<
				ReadToolDetails | undefined
			>;
			const presentation =
				state.presentation ?? new ToolPresentation({ title: "read" });
			state.presentation = presentation;
			presentation.setOptions(
				buildReadPresentation(args, state.info, theme, context),
			);
			return presentation;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as SkinState<
				ReadToolDetails | undefined
			>;
			state.info = { result, options, isError: context.isError };
			state.presentation?.setOptions(
				buildReadPresentation(context.args, state.info, theme, context),
			);
			return new StaticLines([]);
		},
	});
}
