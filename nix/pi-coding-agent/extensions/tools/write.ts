import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	CodePane,
	gruvbox,
	StaticLines,
	ToolShell,
	type BadgeSpec,
	type ToolShellOptions,
} from "../../components/index.ts";
import {
	countLines,
	displayPath,
	firstTextLine,
	isExpanded,
	safeString,
	textOutput,
	type ResultInfo,
	type SkinRenderContext,
	type SkinState,
} from "./shared.ts";

const COLLAPSED_WRITE_LINES = 18;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kib = bytes / 1024;
	if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
	const mib = kib / 1024;
	return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
}

function buildWriteShell(
	args: { path?: string; content?: string },
	info: ResultInfo<undefined> | undefined,
	theme: Theme,
	context: SkinRenderContext,
): ToolShellOptions {
	const path = safeString(args.path);
	const content = safeString(args.content);
	const lineCount = countLines(content);
	const bytes = Buffer.byteLength(content, "utf8");
	const isPending = !info || info.options.isPartial;
	const state = info?.isError ? "error" : isPending ? "pending" : "success";
	const status = info?.isError
		? "error"
		: isPending
			? context.executionStarted
				? "writing"
				: "queued"
			: "written";
	const error = info?.isError ? firstTextLine(textOutput(info.result)) : "";
	const invocation = {
		command: "write",
		icon: "󰈔",
		args: [{ label: "path", value: displayPath(path || "…") }],
	};

	const telemetry: BadgeSpec[] = [
		{
			text: `${lineCount} ${lineCount === 1 ? "line" : "lines"}`,
			bg: gruvbox.bg1,
		},
		{ text: formatBytes(bytes), bg: gruvbox.bg1 },
	];

	const expanded = isExpanded(info, context);
	const preview = content
		? new CodePane({
				code: content,
				path,
				maxLines: expanded ? 140 : COLLAPSED_WRITE_LINES,
				expansionLimit: COLLAPSED_WRITE_LINES,
				theme,
			})
		: new StaticLines([theme.fg("muted", "empty file")]);
	const children = error
		? [new StaticLines([theme.fg("error", error)]), preview]
		: preview;

	return {
		title: "write",
		icon: "󰈔",
		accent: gruvbox.orange,
		state,
		status,
		invocation,
		telemetry,
		expansion: { expanded },
		theme,
		background: gruvbox.bg1,
		children,
	};
}

export default function registerWriteTool(pi: ExtensionAPI) {
	const originalWrite = createWriteToolDefinition(process.cwd());
	pi.registerTool({
		...originalWrite,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as SkinState<undefined>;
			const shell = state.shell ?? new ToolShell({ title: "write" });
			state.shell = shell;
			shell.setOptions(buildWriteShell(args, state.info, theme, context));
			return shell;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as SkinState<undefined>;
			state.info = { result, options, isError: context.isError };
			state.shell?.setOptions(
				buildWriteShell(context.args, state.info, theme, context),
			);
			return new StaticLines([]);
		},
	});
}
