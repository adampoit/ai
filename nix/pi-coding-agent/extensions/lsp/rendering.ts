import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	CachedComponent,
	expandTabs,
	gruvbox,
	StaticLines,
	ToolShell,
	type BadgeSpec,
	type ExpansionAwareComponent,
	type InvocationLineOptions,
	type ToolShellOptions,
} from "../../components/index.ts";
import {
	diagnosticsFromDetails,
	isFailedLspDetails,
	severityColor,
	severityCounts,
	severityThemeToken,
	type DiagnosticSeverity,
} from "./diagnostics.ts";
import type { LspToolResult } from "./types.ts";

export const collapsedDiagnosticMessageLines = 16;
export const expandedDiagnosticMessageLines = 120;
const collapsedResultLines = 12;

type LspToolInfo = {
	result: LspToolResult;
	options: { expanded?: boolean; isPartial?: boolean };
	isError: boolean;
};

type LspToolRenderContext = {
	args: unknown;
	state: unknown;
	executionStarted: boolean;
	expanded: boolean;
	isError: boolean;
};

type LspToolState = {
	shell?: ToolShell;
	info?: LspToolInfo;
};

export function lspToolRenderer(label: string, icon: string, accent: string) {
	return {
		renderCall(args: unknown, theme: any, context: LspToolRenderContext) {
			const state = context.state as LspToolState;
			const shell = state.shell ?? new ToolShell({ title: label });
			state.shell = shell;
			shell.setOptions(
				buildLspShell(
					label,
					icon,
					accent,
					args,
					state.info,
					theme,
					context,
				),
			);
			return shell;
		},
		renderResult(
			result: LspToolResult,
			options: { expanded?: boolean; isPartial?: boolean },
			theme: any,
			context: LspToolRenderContext,
		) {
			const state = context.state as LspToolState;
			state.info = { result, options, isError: context.isError };
			state.shell?.setOptions(
				buildLspShell(
					label,
					icon,
					accent,
					context.args,
					state.info,
					theme,
					context,
				),
			);
			return new StaticLines([]);
		},
	};
}

function buildLspShell(
	label: string,
	icon: string,
	accent: string,
	args: unknown,
	info: LspToolInfo | undefined,
	theme: any,
	context: Pick<LspToolRenderContext, "executionStarted" | "expanded">,
): ToolShellOptions {
	const diagnostics = diagnosticsFromDetails(info?.result.details);
	const counts = severityCounts(diagnostics);
	const hasErrors =
		counts.error > 0 ||
		info?.isError ||
		isFailedLspDetails(info?.result.details);
	const hasWarnings = counts.warning > 0;
	const isPending = !info || info.options.isPartial;
	const expanded = info?.options.expanded ?? context.expanded;
	const text =
		lspTextOutput(info?.result) ||
		(isPending
			? context.executionStarted
				? "Working..."
				: "Queued..."
			: "No output");
	const textLines = splitTextLines(text);
	const hidden = expanded
		? 0
		: Math.max(0, textLines.length - collapsedResultLines);

	const invocation = summarizeLspInvocation(label, icon, args);
	const telemetry = [...severityBadges(counts)];
	if (hidden > 0) {
		telemetry.push({
			text: `${hidden} hidden`,
			bg: gruvbox.bg1,
		});
	}

	return {
		title: label,
		icon,
		accent: hasErrors ? gruvbox.red : hasWarnings ? gruvbox.yellow : accent,
		state: hasErrors
			? "error"
			: isPending
				? "pending"
				: hasWarnings
					? "neutral"
					: "success",
		status: hasErrors
			? "errors"
			: isPending
				? context.executionStarted
					? "running"
					: "queued"
				: hasWarnings
					? "warnings"
					: diagnostics.length > 0
						? "clean"
						: "ok",
		invocation,
		telemetry,
		expansion: { expanded },
		theme,
		children: new LspResultPane(text, theme, {
			maxLines: expanded ? 200 : collapsedResultLines,
			expansionLimit: collapsedResultLines,
		}),
	};
}

export class LspResultPane
	extends CachedComponent
	implements ExpansionAwareComponent
{
	private readonly lines: string[];

	constructor(
		text: string,
		private readonly theme: any,
		private readonly options: { maxLines: number; expansionLimit: number },
	) {
		super();
		this.lines = splitTextLines(text);
	}

	hasExpandableContent(): boolean {
		return this.lines.length > this.options.expansionLimit;
	}

	protected doRender(width: number): string[] {
		const visible = this.lines.slice(0, this.options.maxLines);
		return visible.map((line) =>
			truncateToWidth(
				colorizeLspLine(expandTabs(line), this.theme),
				width,
				"",
			),
		);
	}
}

function summarizeLspInvocation(
	label: string,
	icon: string,
	args: unknown,
): InvocationLineOptions | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = args as Record<string, unknown>;
	const invocationArgs: NonNullable<InvocationLineOptions["args"]> = [];

	if (typeof value.symbol === "string") {
		invocationArgs.push({
			label: "symbol",
			value: `"${formatArgValue(value.symbol)}"`,
		});
	}
	if (Array.isArray(value.files) && value.files.length > 0) {
		invocationArgs.push(
			value.files.length === 1
				? { label: "file", value: formatArgValue(value.files[0]) }
				: { label: "files", value: `${value.files.length} files` },
		);
	} else if (typeof value.file === "string") {
		invocationArgs.push({
			label: "file",
			value: formatArgValue(value.file),
		});
	} else if (typeof value.scope === "string") {
		invocationArgs.push({ label: "scope", value: value.scope });
	}

	if (typeof value.query === "string") {
		invocationArgs.push({
			label: "query",
			value: `"${formatArgValue(value.query)}"`,
		});
	}
	if (typeof value.line === "number" || typeof value.character === "number") {
		invocationArgs.push({
			label: "position",
			value: `${value.line ?? "?"}:${value.character ?? "?"}`,
		});
	}

	if (invocationArgs.length === 0) return undefined;
	return { command: label, icon, args: invocationArgs };
}

export function severityBadges(
	counts: Record<DiagnosticSeverity, number>,
): BadgeSpec[] {
	return (["error", "warning", "info", "hint", "unknown"] as const)
		.filter((severity) => counts[severity] > 0)
		.map((severity) => ({
			text: `${counts[severity]} ${severity}`,
			fg: severity === "warning" ? gruvbox.bg : gruvbox.fg0,
			bg: severityColor(severity),
		}));
}

function formatArgValue(value: unknown) {
	if (typeof value !== "string") return String(value);
	return value.replace(/^@/, "");
}

function lspTextOutput(result: LspToolResult | undefined): string {
	return (
		result?.content
			?.filter(
				(content) =>
					content.type === "text" && typeof content.text === "string",
			)
			.map((content) => content.text ?? "")
			.join("\n")
			.trimEnd() ?? ""
	);
}

export function splitTextLines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function colorizeLspLine(line: string, theme: any): string {
	const match = line.match(
		/^(?<prefix>-\s+.*?:\d+:\d+:\s+)(?<severity>error|warning|info|hint|unknown)(?<suffix>.*)$/,
	);
	if (!match?.groups) return line;
	const severity = match.groups.severity as DiagnosticSeverity;
	const token = severityThemeToken(severity);
	return `${theme.fg("muted", match.groups.prefix)}${theme.fg(token, severity)}${theme.fg("toolOutput", match.groups.suffix ?? "")}`;
}
