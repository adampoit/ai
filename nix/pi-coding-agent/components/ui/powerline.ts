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
	priority?: number;
	spans?: PowerlineTextSpan[];
};

export type PlainStatusPart = string | PowerlineSegment;

type PowerlineSide = string | PowerlineSegment[] | undefined;
type SegmentSide = "left" | "right";
type SegmentCandidate = {
	side: SegmentSide;
	index: number;
	priority: number;
};

export type PowerlineStatusLineOptions = {
	left?: string | PowerlineSegment[];
	right?: string | PowerlineSegment[];
	ellipsis?: string;
};

export class PowerlineStatusLine implements Component {
	constructor(private readonly options: PowerlineStatusLineOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		let left: PowerlineSide = this.options.left;
		let right: PowerlineSide = this.options.right;
		let renderedLeft = renderSide(left, "left");
		let renderedRight = renderSide(right, "right");
		const ellipsis = this.options.ellipsis ?? "…";

		while (hasOverflow(renderedLeft, renderedRight, width)) {
			const candidate = lowestPrioritySegment(
				Array.isArray(left) ? left : undefined,
				Array.isArray(right) ? right : undefined,
			);
			if (!candidate) break;

			if (candidate.side === "left") {
				left = removeSegment(left, candidate.index);
			} else {
				right = removeSegment(right, candidate.index);
			}
			renderedLeft = renderSide(left, "left");
			renderedRight = renderSide(right, "right");
		}

		if (!renderedLeft && !renderedRight) return ["".padEnd(width)];
		if (!renderedRight)
			return [truncateToWidth(renderedLeft, width, ellipsis)];
		if (!renderedLeft) {
			const pad = " ".repeat(
				Math.max(0, width - visibleWidth(renderedRight)),
			);
			return [truncateToWidth(pad + renderedRight, width, ellipsis)];
		}

		const gap =
			width - visibleWidth(renderedLeft) - visibleWidth(renderedRight);
		if (gap >= 1) return [renderedLeft + " ".repeat(gap) + renderedRight];

		const availableLeft = Math.max(
			0,
			width - visibleWidth(renderedRight) - 1,
		);
		if (availableLeft >= 12) {
			return [
				truncateToWidth(renderedLeft, availableLeft, ellipsis) +
					" " +
					renderedRight,
			];
		}

		return [truncateToWidth(renderedRight, width, ellipsis)];
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

function hasOverflow(left: string, right: string, width: number): boolean {
	const gap = left && right ? 1 : 0;
	return visibleWidth(left) + visibleWidth(right) + gap > width;
}

function lowestPrioritySegment(
	left: PowerlineSegment[] | undefined,
	right: PowerlineSegment[] | undefined,
): SegmentCandidate | undefined {
	const candidates: SegmentCandidate[] = [];
	for (const [index, segment] of left?.entries() ?? []) {
		if (segment.text.length > 0) {
			candidates.push({
				side: "left",
				index,
				priority: segment.priority ?? Number.POSITIVE_INFINITY,
			});
		}
	}
	for (const [index, segment] of right?.entries() ?? []) {
		if (segment.text.length > 0) {
			candidates.push({
				side: "right",
				index,
				priority: segment.priority ?? Number.POSITIVE_INFINITY,
			});
		}
	}
	if (candidates.length === 0) return undefined;

	const highestPriority = Math.max(
		...candidates.map((candidate) => candidate.priority),
	);
	const lowerPriority = candidates.filter(
		(candidate) => candidate.priority < highestPriority,
	);
	if (lowerPriority.length === 0) return undefined;
	return lowerPriority.reduce((lowest, candidate) =>
		candidate.priority < lowest.priority ? candidate : lowest,
	);
}

function removeSegment(side: PowerlineSide, index: number): PowerlineSide {
	return Array.isArray(side)
		? side.filter((_segment, segmentIndex) => segmentIndex !== index)
		: side;
}

function renderSide(side: PowerlineSide, direction: SegmentSide): string {
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
