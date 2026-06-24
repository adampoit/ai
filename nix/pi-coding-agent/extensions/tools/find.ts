import type {
	ExtensionAPI,
	FindToolDetails,
	FindToolInput,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	gruvbox,
	StaticLines,
	ToolShell,
	type BadgeSpec,
	type ToolShellOptions,
} from "../../components/index.ts";
import {
	countListItems,
	displayPath,
	firstTextLine,
	isExpanded,
	oneLine,
	pendingText,
	safeString,
	textOutput,
	PathListPane,
	type ResultInfo,
	type SkinRenderContext,
	type SkinState,
} from "./shared.ts";

const COLLAPSED_FIND_ENTRIES = 22;

function buildFindShell(
	args: FindToolInput,
	info: ResultInfo<FindToolDetails | undefined> | undefined,
	theme: Theme,
	context: SkinRenderContext,
): ToolShellOptions {
	const output = textOutput(info?.result);
	const details = info?.result.details;
	const resultCount = countListItems(output);
	const isNone = output.startsWith("No files found");
	const isPending = !info || info.options.isPartial;
	const state = info?.isError ? "error" : isPending ? "pending" : "success";
	const status = info?.isError
		? "error"
		: isPending
			? context.executionStarted
				? "searching"
				: "queued"
			: isNone
				? "none"
				: "found";
	const invocation = {
		command: "find",
		icon: "󰱼",
		args: [
			{
				label: "pattern",
				value: oneLine(safeString(args.pattern) || "…"),
			},
			...(args.path
				? [{ label: "path", value: displayPath(args.path) }]
				: []),
		],
	};

	const telemetry: BadgeSpec[] = [];
	if (args.limit)
		telemetry.push({ text: `limit ${args.limit}`, bg: gruvbox.bg1 });
	if (resultCount > 0)
		telemetry.push({ text: `${resultCount} paths`, bg: gruvbox.bg1 });
	if (details?.resultLimitReached)
		telemetry.push({
			text: `limit ${details.resultLimitReached}`,
			fg: gruvbox.bg,
			bg: gruvbox.yellow,
		});
	if (details?.truncation?.truncated)
		telemetry.push({
			text: "truncated",
			fg: gruvbox.bg,
			bg: gruvbox.yellow,
		});
	const expanded = isExpanded(info, context);

	const body =
		info?.isError && output
			? new StaticLines([theme.fg("error", firstTextLine(output))])
			: output
				? new PathListPane(output, theme, {
						maxLines: expanded ? 160 : COLLAPSED_FIND_ENTRIES,
						expansionLimit: COLLAPSED_FIND_ENTRIES,
						accent: "success",
						emptyText: "No files found matching pattern",
					})
				: new StaticLines([
						theme.fg(
							"muted",
							pendingText(context.executionStarted),
						),
					]);

	return {
		title: "find",
		icon: "󰱼",
		accent: gruvbox.aqua,
		state,
		status,
		invocation,
		telemetry,
		expansion: { expanded },
		theme,
		children: body,
	};
}

export default function registerFindTool(pi: ExtensionAPI) {
	const originalFind = createFindToolDefinition(process.cwd());
	pi.registerTool({
		...originalFind,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as SkinState<
				FindToolDetails | undefined
			>;
			const shell = state.shell ?? new ToolShell({ title: "find" });
			state.shell = shell;
			shell.setOptions(buildFindShell(args, state.info, theme, context));
			return shell;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as SkinState<
				FindToolDetails | undefined
			>;
			state.info = { result, options, isError: context.isError };
			state.shell?.setOptions(
				buildFindShell(context.args, state.info, theme, context),
			);
			return new StaticLines([]);
		},
	});
}
