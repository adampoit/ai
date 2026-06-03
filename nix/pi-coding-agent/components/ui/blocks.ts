import {
	getLanguageFromPath,
	highlightCode,
	keyText,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { fillAnsiLine } from "./ansi.ts";
import { gruvbox } from "./gruvbox.ts";
import { CachedComponent, Inset, Stack, StaticLines } from "./layout.ts";
import {
	paintBackground,
	paintForeground,
	styleText,
	type ColorSpec,
	type PiThemeLike,
} from "./theme.ts";

export type BadgeSpec = string | PillOptions;

export type PillOptions = {
	text: string;
	icon?: string;
	fg?: ColorSpec;
	bg?: ColorSpec;
	theme?: PiThemeLike;
	paddingX?: number;
};

export function renderPill(options: PillOptions): string {
	const padding = " ".repeat(options.paddingX ?? 1);
	const content = [options.icon, options.text]
		.filter((part): part is string => Boolean(part))
		.join(" ");
	return styleText(`${padding}${content}${padding}`, {
		fg: options.fg ?? gruvbox.fg0,
		bg: options.bg ?? gruvbox.bg2,
		theme: options.theme,
	});
}

export function renderBadge(
	badge: BadgeSpec,
	defaults: Partial<PillOptions> = {},
) {
	return renderPill(
		typeof badge === "string"
			? { ...defaults, text: badge }
			: { ...defaults, ...badge },
	);
}

export class Pill extends CachedComponent {
	constructor(private options: PillOptions) {
		super();
	}

	setOptions(options: PillOptions): void {
		this.options = options;
		this.invalidate();
	}

	protected doRender(width: number): string[] {
		return [truncateToWidth(renderPill(this.options), width, "…")];
	}
}

export class Badge extends Pill {}

function toolExpansionKey(): string {
	return keyText("app.tools.expand") || "ctrl+o";
}

function toolExpansionBadge(expanded: boolean): BadgeSpec {
	return {
		text: `${expanded ? "expanded" : "collapsed"} · ${toolExpansionKey()} ${expanded ? "collapse" : "expand"}`,
		fg: gruvbox.bg,
		bg: gruvbox.yellow,
	};
}

export type BlockTitleOptions = {
	title: string;
	icon?: string;
	accent?: ColorSpec;
	titleColor?: ColorSpec;
	mutedColor?: ColorSpec;
	meta?: string[];
	badges?: BadgeSpec[];
	theme?: PiThemeLike;
};

export function renderBlockTitle(options: BlockTitleOptions): string {
	const accent = options.accent ?? gruvbox.yellow;
	const pieces = [
		options.icon
			? styleText(options.icon, { fg: accent, theme: options.theme })
			: undefined,
		styleText(options.title, {
			fg: options.titleColor ?? accent,
			theme: options.theme,
		}),
		...(options.meta ?? []).map((meta) =>
			styleText(meta, {
				fg: options.mutedColor ?? gruvbox.gray,
				theme: options.theme,
			}),
		),
		...(options.badges ?? []).map((badge) =>
			renderBadge(badge, {
				fg: gruvbox.fg0,
				bg: gruvbox.bg2,
				theme: options.theme,
				paddingX: 1,
			}),
		),
	].filter((part): part is string => Boolean(part));
	return pieces.join(" ");
}

export class BlockTitle extends CachedComponent {
	constructor(private options: BlockTitleOptions) {
		super();
	}

	setOptions(options: BlockTitleOptions): void {
		this.options = options;
		this.invalidate();
	}

	protected doRender(width: number): string[] {
		return [truncateToWidth(renderBlockTitle(this.options), width, "…")];
	}
}

export type InvocationArgument = {
	label?: string;
	value: unknown;
	icon?: string;
	labelColor?: ColorSpec;
	valueColor?: ColorSpec;
	bulletColor?: ColorSpec;
};

export type InvocationLineOptions = {
	command?: string;
	args?: InvocationArgument[];
	icon?: string;
	showCommand?: boolean;
	accent?: ColorSpec;
	commandFg?: ColorSpec;
	commandBg?: ColorSpec;
	argumentLabelColor?: ColorSpec;
	argumentValueColor?: ColorSpec;
	argumentBulletColor?: ColorSpec;
	paddingX?: number;
	paddingY?: number;
	paddingTop?: number;
	paddingBottom?: number;
	theme?: PiThemeLike;
};

type NormalizedInvocationArgument = {
	label?: string;
	value: string;
	icon?: string;
	labelColor?: ColorSpec;
	valueColor?: ColorSpec;
	bulletColor?: ColorSpec;
};

export class InvocationLine extends CachedComponent {
	constructor(private options: InvocationLineOptions) {
		super();
	}

	setOptions(options: InvocationLineOptions): void {
		this.options = options;
		this.invalidate();
	}

	protected doRender(width: number): string[] {
		if (width <= 0) return [];
		const paddingX = Math.max(0, this.options.paddingX ?? 1);
		const paddingTop = Math.max(
			0,
			this.options.paddingTop ?? this.options.paddingY ?? 1,
		);
		const paddingBottom = Math.max(
			0,
			this.options.paddingBottom ?? this.options.paddingY ?? 1,
		);
		const contentWidth = Math.max(0, width - paddingX * 2);
		const prefix = " ".repeat(paddingX);
		const content = this.renderContent(contentWidth);
		const lines: string[] = [];

		for (let index = 0; index < paddingTop; index++) lines.push("");
		for (const line of content) {
			lines.push(
				truncateToWidth(
					`${prefix}${truncateToWidth(line, contentWidth, "")}`,
					width,
					"",
				),
			);
		}
		for (let index = 0; index < paddingBottom; index++) lines.push("");
		return lines;
	}

	private renderContent(width: number): string[] {
		if (width <= 0) return [];
		const args = normalizeInvocationArguments(this.options.args);
		if (!this.options.command && args.length === 0) return [];
		return this.renderStructuredContent(args, width);
	}

	private renderStructuredContent(
		args: NormalizedInvocationArgument[],
		width: number,
	): string[] {
		const labelWidth = this.getArgumentLabelWidth(args);
		const showCommand = this.options.showCommand ?? true;
		if (!showCommand) {
			return this.renderArgumentsOnlyContent(args, labelWidth, width);
		}

		const accent = this.options.accent ?? gruvbox.yellow;
		const command = this.options.command ?? "invoke";
		const commandPill = renderPill({
			text: command,
			icon: this.options.icon,
			fg: this.options.commandFg ?? gruvbox.bg,
			bg: this.options.commandBg ?? accent,
			theme: this.options.theme,
			paddingX: 1,
		});

		if (args.length === 0) {
			return [truncateToWidth(commandPill, width, "…")];
		}

		return [
			truncateToWidth(commandPill, width, "…"),
			...args.flatMap((arg, index) =>
				this.renderListArgument(
					arg,
					index === args.length - 1,
					labelWidth,
					width,
				),
			),
		];
	}

	private renderArgumentsOnlyContent(
		args: NormalizedInvocationArgument[],
		labelWidth: number,
		width: number,
	): string[] {
		if (args.length === 0) return [];
		return args.flatMap((arg, index) =>
			this.renderListArgument(
				arg,
				index === args.length - 1,
				labelWidth,
				width,
			),
		);
	}

	private getArgumentLabelWidth(
		args: NormalizedInvocationArgument[],
	): number {
		return Math.min(
			18,
			Math.max(0, ...args.map((arg) => visibleWidth(arg.label ?? ""))),
		);
	}

	private renderListArgument(
		arg: NormalizedInvocationArgument,
		isLast: boolean,
		labelWidth: number,
		width: number,
	): string[] {
		const branch = styleText(isLast ? "╰─" : "├─", {
			fg:
				arg.bulletColor ??
				this.options.argumentBulletColor ??
				this.options.accent ??
				gruvbox.yellow,
			theme: this.options.theme,
		});
		const icon = arg.icon
			? `${styleText(arg.icon, {
					fg:
						arg.valueColor ??
						this.options.argumentValueColor ??
						gruvbox.fg0,
					theme: this.options.theme,
				})} `
			: "";
		const label =
			labelWidth > 0 ? this.renderListLabel(arg, labelWidth) : "";
		const prefix = `  ${branch} ${icon}${label}`;
		const prefixWidth = visibleWidth(prefix);
		const valueWidth = Math.max(1, width - prefixWidth);
		const valueLines = wrapTextWithAnsi(
			this.renderArgumentValue(arg),
			valueWidth,
		);
		if (valueLines.length === 0) {
			return [truncateToWidth(prefix, width, "")];
		}

		const continuationPrefix = this.renderListContinuationPrefix(
			arg,
			isLast,
			labelWidth,
			width,
		);
		return [
			truncateToWidth(`${prefix}${valueLines[0] ?? ""}`, width, ""),
			...valueLines
				.slice(1)
				.map((line) =>
					truncateToWidth(`${continuationPrefix}${line}`, width, ""),
				),
		];
	}

	private renderListContinuationPrefix(
		arg: NormalizedInvocationArgument,
		isLast: boolean,
		labelWidth: number,
		width: number,
	): string {
		const bulletColor =
			arg.bulletColor ??
			this.options.argumentBulletColor ??
			this.options.accent ??
			gruvbox.yellow;
		const treePipe = isLast
			? "  "
			: styleText("│ ", { fg: bulletColor, theme: this.options.theme });
		const iconPadding = arg.icon ? "  " : "";
		const label = labelWidth > 0 ? " ".repeat(labelWidth + 3) : "";
		const prefix = `  ${treePipe} ${iconPadding}${label}`;
		const prefixWidth = visibleWidth(prefix);
		if (prefixWidth > width) return " ".repeat(width);
		return prefix;
	}

	private renderListLabel(
		arg: NormalizedInvocationArgument,
		labelWidth: number,
	): string {
		const rawLabel = truncateToWidth(arg.label ?? "", labelWidth, "…");
		const paddedLabel = `${rawLabel}${" ".repeat(
			Math.max(0, labelWidth - visibleWidth(rawLabel)),
		)}`;
		return `${styleText(paddedLabel, {
			fg:
				arg.labelColor ??
				this.options.argumentLabelColor ??
				gruvbox.gray,
			theme: this.options.theme,
		})} ${styleText("│", {
			fg:
				this.options.argumentBulletColor ??
				this.options.accent ??
				gruvbox.yellow,
			theme: this.options.theme,
		})} `;
	}

	private renderArgumentValue(arg: NormalizedInvocationArgument): string {
		return styleText(arg.value, {
			fg:
				arg.valueColor ??
				this.options.argumentValueColor ??
				gruvbox.fg0,
			theme: this.options.theme,
		});
	}
}

export type BlockFrameOptions = {
	title?: string | BlockTitleOptions;
	bottomTitle?: string | BlockTitleOptions;
	titleContent?: Component;
	borderColor?: ColorSpec;
	background?: ColorSpec;
	theme?: PiThemeLike;
	paddingX?: number;
	paddingY?: number;
};

export class BlockFrame extends CachedComponent {
	constructor(
		private child: Component,
		private options: BlockFrameOptions = {},
	) {
		super();
	}

	setChild(child: Component): void {
		this.child = child;
		this.invalidate();
	}

	setOptions(options: BlockFrameOptions): void {
		this.options = options;
		this.invalidate();
	}

	override invalidate(): void {
		super.invalidate();
		this.child.invalidate();
		this.options.titleContent?.invalidate();
	}

	protected doRender(width: number): string[] {
		if (width <= 0) return [];
		if (width <= 2) {
			return this.child
				.render(width)
				.map((line) => truncateToWidth(line, width, ""));
		}

		const border = paintForeground(
			this.options.borderColor ?? gruvbox.bg3,
			this.options.theme,
		);
		const bg = this.options.background
			? paintBackground(this.options.background, this.options.theme)
			: undefined;
		const innerWidth = width - 2;
		const backgroundInsetX = bg && innerWidth >= 2 ? 1 : 0;
		const paintedWidth = Math.max(0, innerWidth - backgroundInsetX * 2);
		const paddingX = Math.max(0, this.options.paddingX ?? 1);
		const paddingY = Math.max(0, this.options.paddingY ?? 0);
		const contentWidth = Math.max(0, paintedWidth - paddingX * 2);
		const titleContentLines =
			this.options.titleContent?.render(paintedWidth) ?? [];
		const childLines = this.child.render(contentWidth);
		const renderInterior = (line: string) => {
			const leftGutter = " ".repeat(backgroundInsetX);
			const rightGutter = " ".repeat(
				Math.max(0, innerWidth - backgroundInsetX - paintedWidth),
			);
			const body =
				paintedWidth > 0 ? fillAnsiLine(line, paintedWidth, bg) : "";
			const resetInterior = "\x1b[0m";
			return `${border("│")}${leftGutter}${body}${resetInterior}${rightGutter}${border("│")}`;
		};
		const blank = renderInterior("");
		const lines = [this.renderHorizontal(width, "top")];

		for (const titleContentLine of titleContentLines) {
			const leftGutter = " ".repeat(backgroundInsetX);
			const rightGutter = " ".repeat(
				Math.max(0, innerWidth - backgroundInsetX - paintedWidth),
			);
			lines.push(
				`${border("│")}${leftGutter}${fillAnsiLine(
					truncateToWidth(titleContentLine, paintedWidth, ""),
					paintedWidth,
				)}${rightGutter}${border("│")}`,
			);
		}
		for (let i = 0; i < paddingY; i++) lines.push(blank);
		for (const childLine of childLines) {
			const content = truncateToWidth(childLine, contentWidth, "");
			const padded = `${" ".repeat(paddingX)}${content}`;
			lines.push(renderInterior(padded));
		}
		for (let i = 0; i < paddingY; i++) lines.push(blank);

		lines.push(this.renderHorizontal(width, "bottom"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderHorizontal(width: number, edge: "top" | "bottom"): string {
		const innerWidth = Math.max(0, width - 2);
		const border = paintForeground(
			this.options.borderColor ?? gruvbox.bg3,
			this.options.theme,
		);
		const left = edge === "top" ? "╭" : "╰";
		const right = edge === "top" ? "╮" : "╯";
		const rawTitle =
			edge === "top" ? this.renderTitle() : this.renderBottomTitle();
		const title = rawTitle
			? truncateToWidth(
					edge === "top"
						? ` ${rawTitle} `
						: `${border("─")}${rawTitle} `,
					innerWidth,
					"…",
				)
			: "";
		const fillWidth = Math.max(0, innerWidth - visibleWidth(title));
		return `${border(left)}${title}${border("─".repeat(fillWidth))}${border(right)}`;
	}

	private renderTitle(): string {
		return this.renderTitleOrBadges(this.options.title);
	}

	private renderBottomTitle(): string {
		return this.renderTitleOrBadges(this.options.bottomTitle);
	}

	private renderTitleOrBadges(
		title: string | BlockTitleOptions | undefined,
	): string {
		if (!title) return "";
		return typeof title === "string"
			? title
			: renderBlockTitle({
					...title,
					theme: title.theme ?? this.options.theme,
				});
	}
}

export type ToolShellState = "neutral" | "pending" | "success" | "error";

export interface ExpansionAwareComponent extends Component {
	hasExpandableContent(): boolean;
}

export type ToolShellExpansion = {
	expanded: boolean;
	available?: boolean;
};

export type ToolShellOptions = {
	title: string;
	icon?: string;
	accent?: ColorSpec;
	state?: ToolShellState;
	status?: string;
	meta?: string[];
	invocation?: Component | InvocationLineOptions;
	children?: Component | Component[];
	telemetry?: BadgeSpec[];
	expansion?: ToolShellExpansion;
	theme?: PiThemeLike;
	background?: ColorSpec;
	paddingX?: number;
	paddingY?: number;
};

export class ToolShell implements Component {
	private frame: BlockFrame;

	constructor(private options: ToolShellOptions) {
		this.frame = new BlockFrame(new StaticLines([]), {});
		this.updateFrame();
	}

	setOptions(options: ToolShellOptions): void {
		this.options = options;
		this.updateFrame();
	}

	invalidate(): void {
		this.frame.invalidate();
	}

	render(width: number): string[] {
		return this.frame.render(width);
	}

	private updateFrame() {
		const accent = this.options.accent ?? stateAccent(this.options.state);
		const statusAccent = stateAccent(this.options.state, accent);
		const contentPaddingX = Math.max(0, this.options.paddingX ?? 1);
		const contentPaddingY = Math.max(0, this.options.paddingY ?? 1);
		const titleContent = this.createTitleInvocationComponent(
			accent,
			contentPaddingX,
			contentPaddingY,
		);
		const children = normalizeChildren(this.options.children);
		const expansionAvailable =
			this.options.expansion?.available ??
			(this.options.expansion !== undefined &&
				hasExpandableContent(children));
		const telemetry = [
			...(this.options.telemetry ?? []),
			...(this.options.expansion && expansionAvailable
				? [toolExpansionBadge(this.options.expansion.expanded)]
				: []),
		];
		const childBody =
			children.length === 0
				? new StaticLines([])
				: children.length === 1
					? children[0]!
					: new Stack(children);

		this.frame.setChild(
			new Inset(childBody, {
				paddingX: contentPaddingX,
				paddingTop: children.length > 0 ? contentPaddingY : 0,
				paddingBottom: children.length > 0 ? contentPaddingY : 0,
			}),
		);
		this.frame.setOptions({
			title: {
				title: this.options.title,
				icon: this.options.icon,
				accent,
				meta: this.options.meta,
				badges: this.options.status
					? [
							{
								text: this.options.status,
								fg: gruvbox.fg0,
								bg: statusAccent,
								theme: this.options.theme,
							},
						]
					: [],
				theme: this.options.theme,
			},
			bottomTitle:
				telemetry.length > 0
					? {
							title: "",
							badges: telemetry,
							accent,
							theme: this.options.theme,
						}
					: undefined,
			titleContent,
			borderColor: accent,
			background: this.options.background ?? defaultBlockBackground(),
			theme: this.options.theme,
			paddingX: 0,
			paddingY: 0,
		});
	}

	private createTitleInvocationComponent(
		accent: ColorSpec,
		paddingX: number,
		paddingY: number,
	): Component | undefined {
		const invocation = this.options.invocation;
		if (!invocation) return undefined;
		if (isComponent(invocation)) return invocation;
		return new InvocationLine({
			accent,
			showCommand: false,
			paddingX,
			paddingTop: 0,
			paddingBottom: paddingY,
			theme: this.options.theme,
			...invocation,
		});
	}
}

export type CodePaneOptions = {
	code: string;
	path?: string;
	language?: string;
	startLine?: number;
	showLineNumbers?: boolean;
	maxLines?: number;
	expansionLimit?: number;
	background?: ColorSpec;
	lineNumberColor?: ColorSpec;
	theme?: PiThemeLike;
};

export class CodePane
	extends CachedComponent
	implements ExpansionAwareComponent
{
	private highlightedCache?: {
		code: string;
		language?: string;
		result: string[];
	};

	constructor(private options: CodePaneOptions) {
		super();
	}

	setOptions(options: CodePaneOptions): void {
		this.options = options;
		this.highlightedCache = undefined;
		this.invalidate();
	}

	hasExpandableContent(): boolean {
		const limit = this.options.expansionLimit ?? this.options.maxLines;
		return (
			limit !== undefined && splitLines(this.options.code).length > limit
		);
	}

	protected doRender(width: number): string[] {
		if (width <= 0) return [];
		const rawLines = splitLines(this.options.code);
		const maxLines = this.options.maxLines ?? rawLines.length;
		const visibleLines = rawLines.slice(0, maxLines);
		const startLine = this.options.startLine ?? 1;
		const showLineNumbers = this.options.showLineNumbers ?? true;
		const gutterWidth = showLineNumbers
			? String(startLine + Math.max(0, visibleLines.length - 1)).length
			: 0;
		const contentWidth = Math.max(
			1,
			width - (showLineNumbers ? gutterWidth + 2 : 0),
		);
		const highlighted = this.getHighlighted(visibleLines.join("\n"));
		const bg = this.options.background
			? paintBackground(this.options.background, this.options.theme)
			: undefined;
		const lines = highlighted.map((line, index) => {
			const prefix = showLineNumbers
				? `${styleText(
						String(startLine + index).padStart(gutterWidth),
						{
							fg: this.options.lineNumberColor ?? gruvbox.gray,
							theme: this.options.theme,
						},
					)} │ `
				: "";
			return fillAnsiLine(
				`${prefix}${truncateToWidth(line, contentWidth, "")}`,
				width,
				bg,
			);
		});

		if (rawLines.length > visibleLines.length) {
			lines.push(
				fillAnsiLine(
					styleText(
						`… ${rawLines.length - visibleLines.length} more lines`,
						{
							fg: gruvbox.gray,
							theme: this.options.theme,
						},
					),
					width,
					bg,
				),
			);
		}
		return lines;
	}

	private getHighlighted(code: string): string[] {
		const language =
			this.options.language ??
			(this.options.path
				? getLanguageFromPath(this.options.path)
				: undefined);
		if (
			this.highlightedCache &&
			this.highlightedCache.code === code &&
			this.highlightedCache.language === language
		) {
			return this.highlightedCache.result;
		}
		try {
			const result = highlightCode(code, language);
			this.highlightedCache = { code, language, result };
			return result;
		} catch {
			const result = splitLines(code);
			this.highlightedCache = { code, language, result };
			return result;
		}
	}
}

export type TerminalPaneOptions = {
	command?: string;
	output?: string;
	prompt?: string;
	maxLines?: number;
	expansionLimit?: number;
	accent?: ColorSpec;
	background?: ColorSpec;
	theme?: PiThemeLike;
};

export class TerminalPane
	extends CachedComponent
	implements ExpansionAwareComponent
{
	private outputLines: string[] = [];

	constructor(private options: TerminalPaneOptions) {
		super();
		this.outputLines = splitLines(this.options.output ?? "");
	}

	setOptions(options: TerminalPaneOptions): void {
		this.options = options;
		this.outputLines = splitLines(this.options.output ?? "");
		this.invalidate();
	}

	hasExpandableContent(): boolean {
		const limit = this.options.expansionLimit ?? this.options.maxLines;
		return limit !== undefined && this.outputLines.length > limit;
	}

	protected doRender(width: number): string[] {
		if (width <= 0) return [];
		const bg = this.options.background
			? paintBackground(this.options.background, this.options.theme)
			: undefined;
		const lines: string[] = [];
		if (this.options.command) {
			const prompt = styleText(this.options.prompt ?? "❯", {
				fg: this.options.accent ?? gruvbox.orange,
				theme: this.options.theme,
			});
			lines.push(`${prompt} ${this.options.command}`);
		}

		const maxLines = Math.max(
			0,
			this.options.maxLines ?? this.outputLines.length,
		);
		if (this.outputLines.length > maxLines) {
			lines.push(
				styleText(
					`… ${this.outputLines.length - maxLines} previous output lines`,
					{
						fg: gruvbox.gray,
						theme: this.options.theme,
					},
				),
			);
			if (maxLines > 0) lines.push(...this.outputLines.slice(-maxLines));
		} else {
			lines.push(...this.outputLines);
		}

		return lines.map((line) => fillAnsiLine(line, width, bg));
	}
}

export type KeyHint = {
	key: string;
	label: string;
};

export class KeyHintLine extends CachedComponent {
	constructor(
		private hints: KeyHint[],
		private options: { theme?: PiThemeLike; accent?: ColorSpec } = {},
	) {
		super();
	}

	setHints(hints: KeyHint[]): void {
		this.hints = hints;
		this.invalidate();
	}

	protected doRender(width: number): string[] {
		const line = this.hints
			.map(
				(hint) =>
					`${renderPill({
						text: hint.key,
						fg: gruvbox.bg,
						bg: this.options.accent ?? gruvbox.yellow,
						theme: this.options.theme,
						paddingX: 1,
					})} ${styleText(hint.label, {
						fg: gruvbox.gray,
						theme: this.options.theme,
					})}`,
			)
			.join(
				styleText("  •  ", {
					fg: gruvbox.bg3,
					theme: this.options.theme,
				}),
			);
		return [truncateToWidth(line, width, "…")];
	}
}

export type MeterOptions = {
	value: number | undefined;
	width?: number;
	filled?: string;
	empty?: string;
	fg?: ColorSpec;
	emptyFg?: ColorSpec;
	label?: string;
	theme?: PiThemeLike;
};

export function renderMeter(options: MeterOptions): string {
	const width = Math.max(1, options.width ?? 10);
	if (options.value === undefined || !Number.isFinite(options.value)) {
		return styleText((options.empty ?? "·").repeat(width), {
			fg: options.emptyFg ?? gruvbox.gray,
			theme: options.theme,
		});
	}
	const value = Math.max(0, Math.min(1, options.value));
	const filled = Math.round(value * width);
	const filledText = (options.filled ?? "█").repeat(filled);
	const emptyText = (options.empty ?? "░").repeat(width - filled);
	const meter = `${styleText(filledText, {
		fg: options.fg ?? gruvbox.green,
		theme: options.theme,
	})}${styleText(emptyText, {
		fg: options.emptyFg ?? gruvbox.bg3,
		theme: options.theme,
	})}`;
	return options.label ? `${meter} ${options.label}` : meter;
}

export class Meter extends CachedComponent {
	constructor(private options: MeterOptions) {
		super();
	}

	setOptions(options: MeterOptions): void {
		this.options = options;
		this.invalidate();
	}

	protected doRender(width: number): string[] {
		return [truncateToWidth(renderMeter(this.options), width, "")];
	}
}

function isComponent(value: unknown): value is Component {
	return (
		typeof value === "object" &&
		value !== null &&
		"render" in value &&
		typeof (value as Component).render === "function"
	);
}

function isExpansionAwareComponent(
	value: Component,
): value is ExpansionAwareComponent {
	return (
		"hasExpandableContent" in value &&
		typeof (value as ExpansionAwareComponent).hasExpandableContent ===
			"function"
	);
}

function hasExpandableContent(children: Component[]): boolean {
	return children.some(
		(child) =>
			isExpansionAwareComponent(child) && child.hasExpandableContent(),
	);
}

function normalizeInvocationArguments(
	args: InvocationArgument[] | undefined,
): NormalizedInvocationArgument[] {
	return (args ?? [])
		.map((arg): NormalizedInvocationArgument | undefined => {
			if (arg.value === undefined || arg.value === null) return undefined;
			const value = formatInvocationArgumentValue(arg.value);
			if (!value) return undefined;
			return { ...arg, value };
		})
		.filter((arg): arg is NormalizedInvocationArgument => Boolean(arg));
}

function formatInvocationArgumentValue(value: unknown): string {
	if (Array.isArray(value))
		return value.map(formatInvocationArgumentValue).join(", ");
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\n/g, " ↵ ");
}

function normalizeChildren(
	children: ToolShellOptions["children"],
): Component[] {
	if (!children) return [];
	return Array.isArray(children) ? children : [children];
}

function stateAccent(
	state: ToolShellState | undefined,
	accent?: ColorSpec,
): ColorSpec {
	if (state === "error") return gruvbox.red;
	if (state === "pending") return gruvbox.yellow;
	if (state === "success") return gruvbox.green;
	return accent ?? gruvbox.yellow;
}

function defaultBlockBackground(): ColorSpec {
	return gruvbox.bg1;
}

function splitLines(text: string): string[] {
	if (!text) return [];
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}
