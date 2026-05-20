import type {
	ExtensionAPI,
	GrepToolDetails,
	GrepToolInput,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { createGrepToolDefinition } from "@mariozechner/pi-coding-agent";
import {
	gruvbox,
	StaticLines,
	ToolShell,
	type BadgeSpec,
	type ToolShellOptions,
} from "../../components/index.ts";
import {
	displayPath,
	isExpanded,
	oneLine,
	pendingText,
	safeString,
	textOutput,
	GrepResultPane,
	type ResultInfo,
	type SkinRenderContext,
	type SkinState,
} from "./shared.ts";

const COLLAPSED_GREP_LINES = 18;

function buildGrepShell(
	args: GrepToolInput,
	info: ResultInfo<GrepToolDetails | undefined> | undefined,
	theme: Theme,
	context: SkinRenderContext,
): ToolShellOptions {
	const output =
		textOutput(info?.result) || pendingText(context.executionStarted);
	const details = info?.result.details;
	const isPending = !info || info.options.isPartial;
	const state = info?.isError ? "error" : isPending ? "pending" : "success";
	const status = info?.isError
		? "error"
		: isPending
			? context.executionStarted
				? "searching"
				: "queued"
			: output === "No matches found"
				? "none"
				: "matches";
	const pattern = safeString(args.pattern);
	const invocation = {
		command: "grep",
		icon: "",
		args: [
			{
				label: args.literal ? "literal" : "regex",
				value: `"${oneLine(pattern || "…")}"`,
			},
			...(args.path
				? [{ label: "path", value: displayPath(args.path) }]
				: []),
			...(args.glob ? [{ label: "glob", value: args.glob }] : []),
		],
	};

	const telemetry: BadgeSpec[] = [];
	if (args.ignoreCase)
		telemetry.push({ text: "ignore-case", bg: gruvbox.bg1 });
	if (args.context)
		telemetry.push({ text: `±${args.context}`, bg: gruvbox.bg1 });
	if (details?.matchLimitReached)
		telemetry.push({
			text: `limit ${details.matchLimitReached}`,
			fg: gruvbox.bg,
			bg: gruvbox.yellow,
		});
	if (details?.truncation?.truncated || details?.linesTruncated)
		telemetry.push({
			text: "truncated",
			fg: gruvbox.bg,
			bg: gruvbox.yellow,
		});
	const expanded = isExpanded(info, context);

	return {
		title: "grep",
		icon: "",
		accent: gruvbox.purple,
		state,
		status,
		invocation,
		telemetry,
		expansion: { expanded },
		theme,
		background: gruvbox.bg1,
		children: new GrepResultPane(output, args, theme, {
			maxLines: expanded ? 120 : COLLAPSED_GREP_LINES,
			expansionLimit: COLLAPSED_GREP_LINES,
		}),
	};
}

export default function registerGrepTool(pi: ExtensionAPI) {
	const originalGrep = createGrepToolDefinition(process.cwd());
	pi.registerTool({
		...originalGrep,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as SkinState<
				GrepToolDetails | undefined
			>;
			const shell = state.shell ?? new ToolShell({ title: "grep" });
			state.shell = shell;
			shell.setOptions(buildGrepShell(args, state.info, theme, context));
			return shell;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as SkinState<
				GrepToolDetails | undefined
			>;
			state.info = { result, options, isError: context.isError };
			state.shell?.setOptions(
				buildGrepShell(context.args, state.info, theme, context),
			);
			return new StaticLines([]);
		},
	});
}
