import type {
	BashToolDetails,
	BashToolInput,
	ExtensionAPI,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
	gruvbox,
	StaticLines,
	TerminalPane,
	ToolShell,
	type BadgeSpec,
	type ToolShellOptions,
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

const COLLAPSED_BASH_LINES = 14;

type BashSkinState = SkinState<BashToolDetails | undefined> & {
	elapsedTimer?: ReturnType<typeof setInterval>;
};

function stopElapsedTimer(state: BashSkinState): void {
	if (state.elapsedTimer === undefined) return;
	clearInterval(state.elapsedTimer);
	state.elapsedTimer = undefined;
}

function parseExitCode(output: string): number | undefined {
	const match =
		output.match(/Command exited with code (\d+)/i) ??
		output.match(/exit code: (\d+)/i);
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.round(seconds % 60);
	return `${minutes}m ${remainingSeconds}s`;
}

function compactPath(path: string): string {
	return truncateToWidth(displayPath(path), 56, "…");
}

function buildBashShell(
	args: BashToolInput,
	info: ResultInfo<BashToolDetails | undefined> | undefined,
	theme: Theme,
	context: SkinRenderContext,
	timingState?: SkinState<BashToolDetails | undefined>,
): ToolShellOptions {
	const command = safeString(args.command);
	const output =
		textOutput(info?.result) || pendingText(context.executionStarted);
	const lineCount = countLines(output);
	const exitCode = parseExitCode(output);
	const isPending = !info || info.options.isPartial;
	const state = info?.isError ? "error" : isPending ? "pending" : "success";
	const status = info?.isError
		? exitCode === undefined
			? "error"
			: `exit ${exitCode}`
		: isPending
			? context.executionStarted
				? "running"
				: "queued"
			: "ok";
	const details = info?.result.details;
	const expanded = isExpanded(info, context);
	const telemetry: BadgeSpec[] = [
		{
			text: `${lineCount} ${lineCount === 1 ? "line" : "lines"}`,
			bg: gruvbox.bg1,
		},
	];
	if (timingState?.startedAt !== undefined) {
		const elapsedMs =
			(timingState.endedAt ?? Date.now()) - timingState.startedAt;
		telemetry.push({
			text: `${isPending ? "elapsed" : "took"} ${formatDuration(elapsedMs)}`,
			bg: gruvbox.bg1,
		});
	}
	if (details?.truncation?.truncated)
		telemetry.push({
			text: "truncated",
			fg: gruvbox.bg,
			bg: gruvbox.yellow,
		});
	if (details?.fullOutputPath)
		telemetry.push({
			text: `full output: ${compactPath(details.fullOutputPath)}`,
			bg: gruvbox.bg1,
		});

	return {
		title: "bash",
		icon: "",
		accent: gruvbox.orange,
		state,
		status,
		invocation: {
			command: "bash",
			icon: "",
			args: [
				{ label: "command", value: command || "…" },
				...(args.timeout
					? [{ label: "timeout", value: `${args.timeout}s` }]
					: []),
			],
		},
		telemetry,
		expansion: { expanded },
		theme,
		children: new TerminalPane({
			output,
			maxLines: expanded ? 120 : COLLAPSED_BASH_LINES,
			expansionLimit: COLLAPSED_BASH_LINES,
			accent: gruvbox.orange,
			theme,
		}),
	};
}

export default function registerBashTool(pi: ExtensionAPI) {
	const originalBash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...originalBash,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as BashSkinState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			if (
				context.executionStarted &&
				!context.isPartial &&
				state.startedAt !== undefined
			) {
				state.endedAt ??= Date.now();
			}

			const shouldTick =
				context.executionStarted &&
				context.isPartial &&
				!context.isError;
			if (shouldTick && state.elapsedTimer === undefined) {
				state.elapsedTimer = setInterval(() => {
					if (state.endedAt !== undefined) {
						stopElapsedTimer(state);
						return;
					}
					try {
						context.invalidate();
					} catch {
						stopElapsedTimer(state);
					}
				}, 1000);
			} else if (!shouldTick) {
				stopElapsedTimer(state);
			}

			const shell = state.shell ?? new ToolShell({ title: "bash" });
			state.shell = shell;
			shell.setOptions(
				buildBashShell(args, state.info, theme, context, state),
			);
			return shell;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as BashSkinState;
			if (
				(!options.isPartial || context.isError) &&
				state.startedAt !== undefined
			) {
				state.endedAt ??= Date.now();
				stopElapsedTimer(state);
			}
			state.info = { result, options, isError: context.isError };
			state.shell?.setOptions(
				buildBashShell(context.args, state.info, theme, context, state),
			);
			return new StaticLines([]);
		},
	});
}
