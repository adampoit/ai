import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { gruvbox } from "./gruvbox.ts";
import { RESET, sgrBg, sgrFg, style } from "./ansi.ts";

export const LEFT_POWERLINE_SEPARATOR = "";
export const RIGHT_POWERLINE_SEPARATOR = "";
export const THIN_RIGHT_SEPARATOR = "";

export type PowerlineTextSpan = {
	text: string;
	fg: string;
};

export type PowerlineSegment = {
	text: string;
	fg: string;
	bg: string;
	spans?: PowerlineTextSpan[];
};

export type PlainStatusPart = string | PowerlineSegment;

export type PowerlineStatusLineOptions = {
	left?: string | PowerlineSegment[];
	right?: string | PowerlineSegment[];
	rightPrefix?: string | PowerlineSegment[];
	rightPrefixSeparator?: string;
	ellipsis?: string;
};

export class PowerlineStatusLine implements Component {
	constructor(private readonly options: PowerlineStatusLineOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		const left = renderSide(this.options.left, "left");
		const importantRight = renderSide(this.options.right, "right");
		const rightPrefixSegments = Array.isArray(this.options.rightPrefix)
			? this.options.rightPrefix
			: undefined;
		const rightSegments = Array.isArray(this.options.right)
			? this.options.right
			: undefined;
		const right =
			rightPrefixSegments && rightSegments
				? renderPowerlineRight([
						...rightPrefixSegments,
						...rightSegments,
					])
				: [
						typeof this.options.rightPrefix === "string"
							? this.options.rightPrefix
							: "",
						importantRight,
					]
						.filter((part): part is string => Boolean(part))
						.join(this.options.rightPrefixSeparator ?? " ");
		const ellipsis = this.options.ellipsis ?? "…";

		if (!left && !right) return ["".padEnd(width)];
		if (!right) return [truncateToWidth(left, width, ellipsis)];
		if (!left) {
			const pad = " ".repeat(Math.max(0, width - visibleWidth(right)));
			return [truncateToWidth(pad + right, width, ellipsis)];
		}

		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap >= 1) return [left + " ".repeat(gap) + right];

		const availableLeft = Math.max(
			0,
			width - visibleWidth(importantRight || right) - 1,
		);
		if (availableLeft >= 12) {
			return [
				truncateToWidth(left, availableLeft, ellipsis) +
					" " +
					(importantRight || right),
			];
		}

		return [truncateToWidth(importantRight || right, width, ellipsis)];
	}
}

export function renderPowerlineLeft(blocks: PowerlineSegment[]): string {
	const items = nonEmptySegments(blocks);
	return items
		.map((item, index) => {
			const next = items[index + 1];
			const separator = next
				? style(LEFT_POWERLINE_SEPARATOR, item.bg, next.bg)
				: style(LEFT_POWERLINE_SEPARATOR, item.bg);
			return renderPowerlineBlock(item) + separator;
		})
		.join("");
}

export function renderPowerlineRight(blocks: PowerlineSegment[]): string {
	const items = nonEmptySegments(blocks);
	return items
		.map((item, index) => {
			const previous = items[index - 1];
			const separator = previous
				? previous.bg === item.bg
					? style(THIN_RIGHT_SEPARATOR, item.fg, previous.bg)
					: style(RIGHT_POWERLINE_SEPARATOR, item.bg, previous.bg)
				: style(RIGHT_POWERLINE_SEPARATOR, item.bg);
			return separator + renderPowerlineBlock(item);
		})
		.join("");
}

export function renderPlainStatusParts(
	parts: PlainStatusPart[],
	options: { separator?: string; defaultFg?: string } = {},
): string {
	const separator = options.separator ?? ` ${THIN_RIGHT_SEPARATOR} `;
	const defaultFg = options.defaultFg ?? gruvbox.gray;
	return parts
		.filter((part) =>
			typeof part === "string" ? part.length > 0 : part.text.length > 0,
		)
		.map((part) =>
			typeof part === "string"
				? style(part, defaultFg)
				: style(part.text, part.fg, part.bg),
		)
		.join(style(separator, defaultFg));
}

function renderSide(
	side: string | PowerlineSegment[] | undefined,
	direction: "left" | "right",
): string {
	if (!side) return "";
	return typeof side === "string"
		? side
		: direction === "left"
			? renderPowerlineLeft(side)
			: renderPowerlineRight(side);
}

function nonEmptySegments(blocks: PowerlineSegment[]): PowerlineSegment[] {
	return blocks.filter((item) => item.text.length > 0);
}

function renderPowerlineBlock(item: PowerlineSegment): string {
	if (!item.spans) return style(` ${item.text} `, item.fg, item.bg);

	const background = sgrBg(item.bg);
	const text = item.spans
		.map(
			(span, index) =>
				`${index > 0 ? `${sgrFg(gruvbox.fg3)} · ${RESET}${background}` : ""}${sgrFg(span.fg)}${span.text}${RESET}${background}`,
		)
		.join("");
	return `${background} ${text} ${RESET}`;
}
