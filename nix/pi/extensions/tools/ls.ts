import type {
	ExtensionAPI,
	LsToolDetails,
	LsToolInput,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { createLsToolDefinition } from "@mariozechner/pi-coding-agent";
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
	pendingText,
	textOutput,
	PathListPane,
	type ResultInfo,
	type SkinRenderContext,
	type SkinState,
} from "./shared.ts";

const COLLAPSED_LS_ENTRIES = 24;

function buildLsShell(
	args: LsToolInput,
	info: ResultInfo<LsToolDetails | undefined> | undefined,
	theme: Theme,
	context: SkinRenderContext,
): ToolShellOptions {
	const output = textOutput(info?.result);
	const details = info?.result.details;
	const entryCount = countListItems(output);
	const isEmpty = output === "(empty directory)";
	const isPending = !info || info.options.isPartial;
	const state = info?.isError ? "error" : isPending ? "pending" : "success";
	const status = info?.isError
		? "error"
		: isPending
			? context.executionStarted
				? "listing"
				: "queued"
			: isEmpty
				? "empty"
				: "listed";
	const invocation = {
		command: "ls",
		icon: "",
		args: [{ label: "path", value: displayPath(args.path || ".") }],
	};

	const telemetry: BadgeSpec[] = [];
	if (args.limit)
		telemetry.push({ text: `limit ${args.limit}`, bg: gruvbox.bg1 });
	if (entryCount > 0)
		telemetry.push({ text: `${entryCount} entries`, bg: gruvbox.bg1 });
	if (details?.entryLimitReached)
		telemetry.push({
			text: `limit ${details.entryLimitReached}`,
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
						maxLines: expanded ? 160 : COLLAPSED_LS_ENTRIES,
						expansionLimit: COLLAPSED_LS_ENTRIES,
						accent: "accent",
						emptyText: "(empty directory)",
					})
				: new StaticLines([
						theme.fg(
							"muted",
							pendingText(context.executionStarted),
						),
					]);

	return {
		title: "ls",
		icon: "",
		accent: gruvbox.blue,
		state,
		status,
		invocation,
		telemetry,
		expansion: { expanded },
		theme,
		children: body,
	};
}

export default function registerLsTool(pi: ExtensionAPI) {
	const originalLs = createLsToolDefinition(process.cwd());
	pi.registerTool({
		...originalLs,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as SkinState<LsToolDetails | undefined>;
			const shell = state.shell ?? new ToolShell({ title: "ls" });
			state.shell = shell;
			shell.setOptions(buildLsShell(args, state.info, theme, context));
			return shell;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as SkinState<LsToolDetails | undefined>;
			state.info = { result, options, isError: context.isError };
			state.shell?.setOptions(
				buildLsShell(context.args, state.info, theme, context),
			);
			return new StaticLines([]);
		},
	});
}
