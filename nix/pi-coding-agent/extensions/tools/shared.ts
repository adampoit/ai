import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
	CachedComponent,
	fillAnsiLine,
	gruvbox,
	ToolShell,
	type ExpansionAwareComponent,
} from "../../components/index.ts";

export type ResultInfo<TDetails> = {
	result: AgentToolResult<TDetails>;
	options: ToolRenderResultOptions;
	isError: boolean;
};

export type SkinState<TDetails> = {
	shell?: ToolShell;
	info?: ResultInfo<TDetails>;
	startedAt?: number;
	endedAt?: number;
};

export type SkinRenderContext = {
	executionStarted: boolean;
	expanded: boolean;
};

export function textOutput(result: AgentToolResult<any> | undefined): string {
	return (
		result?.content
			.filter((item) => item.type === "text")
			.map((item) => item.text ?? "")
			.join("\n")
			.trimEnd() ?? ""
	);
}

export function pendingText(started: boolean): string {
	return started ? "working…" : "queued…";
}

export function countLines(text: string | undefined): number {
	if (!text) return 0;
	return text.split(/\r?\n/).length;
}

export function isExpanded<TDetails>(
	info: ResultInfo<TDetails> | undefined,
	context: SkinRenderContext,
): boolean {
	return info?.options.expanded ?? context.expanded;
}

export function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function firstTextLine(text: string): string {
	return text.trim().split(/\r?\n/)[0] ?? "";
}

export function displayPath(path: string): string {
	const normalized = path.replace(/^@/, "");
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && normalized.startsWith(home)
		? `~${normalized.slice(home.length)}`
		: normalized;
}

export function oneLine(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function listItems(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !/^\[.*limit.*\]$/i.test(line))
		.filter((line) => line !== "No files found matching pattern")
		.filter((line) => line !== "(empty directory)");
}

export function countListItems(output: string): number {
	return listItems(output).length;
}

function fileIcon(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "󰛦";
	if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "󰌞";
	if (lower.endsWith(".json")) return "";
	if (lower.endsWith(".nix")) return "";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "";
	if (lower.endsWith(".css") || lower.endsWith(".scss")) return "";
	if (lower.endsWith(".html")) return "";
	if (
		lower.endsWith(".png") ||
		lower.endsWith(".jpg") ||
		lower.endsWith(".jpeg")
	)
		return "";
	return "";
}

export class PathListPane
	extends CachedComponent
	implements ExpansionAwareComponent
{
	private readonly items: string[];

	constructor(
		private readonly output: string,
		private readonly theme: Theme,
		private readonly options: {
			maxLines: number;
			expansionLimit: number;
			accent: "accent" | "success";
			emptyText: string;
		},
	) {
		super();
		this.items = listItems(output);
	}

	hasExpandableContent(): boolean {
		return this.items.length > this.options.expansionLimit;
	}

	protected doRender(width: number): string[] {
		if (this.items.length === 0) {
			return [
				fillAnsiLine(
					this.theme.fg(
						"muted",
						this.output || this.options.emptyText,
					),
					width,
				),
			];
		}

		const lines = this.items
			.slice(0, this.options.maxLines)
			.map((item) => fillAnsiLine(this.renderItem(item), width));
		if (this.items.length > this.options.maxLines) {
			lines.push(
				fillAnsiLine(
					this.theme.fg(
						"muted",
						`… ${this.items.length - this.options.maxLines} more entries`,
					),
					width,
				),
			);
		}
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderItem(item: string): string {
		const isDirectory = item.endsWith("/");
		const normalized = item.replace(/\\/g, "/");
		const withoutSlash = isDirectory ? normalized.slice(0, -1) : normalized;
		const slashIndex = withoutSlash.lastIndexOf("/");
		const directory =
			slashIndex >= 0 ? withoutSlash.slice(0, slashIndex + 1) : "";
		const basename =
			slashIndex >= 0 ? withoutSlash.slice(slashIndex + 1) : withoutSlash;
		const icon = isDirectory ? "" : fileIcon(basename);
		return [
			this.theme.fg(isDirectory ? this.options.accent : "dim", icon),
			" ",
			directory ? this.theme.fg("dim", directory) : "",
			this.theme.fg(
				isDirectory ? this.options.accent : "toolOutput",
				basename,
			),
			isDirectory ? this.theme.fg("dim", "/") : "",
		].join("");
	}
}

export class GrepResultPane
	extends CachedComponent
	implements ExpansionAwareComponent
{
	private readonly lines: string[];
	private readonly regex?: RegExp;

	constructor(
		output: string,
		args: { pattern?: string; literal?: boolean; ignoreCase?: boolean },
		private readonly theme: Theme,
		private readonly options: { maxLines: number; expansionLimit: number },
	) {
		super();
		this.lines = output.split(/\r?\n/);
		if (args.pattern) {
			try {
				this.regex = args.literal
					? new RegExp(
							escapeRegExp(args.pattern),
							args.ignoreCase ? "gi" : "g",
						)
					: new RegExp(args.pattern, args.ignoreCase ? "gi" : "g");
			} catch {
				// invalid regex
			}
		}
	}

	hasExpandableContent(): boolean {
		return this.lines.length > this.options.expansionLimit;
	}

	protected doRender(width: number): string[] {
		const lines = this.lines
			.slice(0, this.options.maxLines)
			.map((line) => fillAnsiLine(this.renderLine(line), width));
		if (this.lines.length > this.options.maxLines) {
			lines.push(
				fillAnsiLine(
					this.theme.fg(
						"muted",
						`… ${this.lines.length - this.options.maxLines} more matches`,
					),
					width,
				),
			);
		}
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderLine(line: string): string {
		if (line === "No matches found") return this.theme.fg("muted", line);
		const match = line.match(/^(.+?)([:\-])(\d+)([:\-])\s?(.*)$/);
		if (!match) return this.theme.fg("toolOutput", line);

		const [, file, leftSep, lineNo, rightSep, text] = match;
		const isMatch = leftSep === ":" && rightSep === ":";
		return [
			this.theme.fg("accent", file),
			this.theme.fg(isMatch ? "warning" : "dim", leftSep),
			this.theme.fg("muted", lineNo),
			this.theme.fg(isMatch ? "warning" : "dim", rightSep),
			" ",
			this.highlight(text),
		].join("");
	}

	private highlight(text: string): string {
		if (!this.regex) return this.theme.fg("toolOutput", text);
		try {
			return text.replace(this.regex, (value) =>
				this.theme.fg("warning", value),
			);
		} catch {
			return this.theme.fg("toolOutput", text);
		}
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// no-op default in case Pi scans this file directly
export default function () {}
