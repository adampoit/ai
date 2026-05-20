import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type ColorHex = `#${string}`;
export type BackgroundFn = (value: string) => string;

export const RESET = "\x1b[0m";

export function hexToRgb(hex: string): [number, number, number] {
	const value = hex.replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(value)) {
		throw new Error(`Expected a 6-digit hex color, got ${hex}`);
	}
	return [
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
	];
}

export function sgrFg(hex: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

export function sgrBg(hex: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[48;2;${r};${g};${b}m`;
}

export function fg(hex: string, text: string): string {
	return `${sgrFg(hex)}${text}${RESET}`;
}

export function bg(hex: string, text: string): string {
	return `${sgrBg(hex)}${text}\x1b[49m`;
}

export function style(
	text: string,
	foreground: string,
	background?: string,
): string {
	return `${background ? sgrBg(background) : ""}${sgrFg(foreground)}${text}${RESET}`;
}

export function background(hex: string): BackgroundFn {
	return (value: string) => bg(hex, value);
}

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function expandTabs(text: string, tabWidth = 8): string {
	if (!text.includes("\t")) return text;
	let result = "";
	for (const char of text) {
		if (char === "\t") {
			const col = visibleWidth(result);
			const spaces = tabWidth - (col % tabWidth);
			result += " ".repeat(spaces);
		} else {
			result += char;
		}
	}
	return result;
}

export function padAnsiLine(
	line: string,
	width: number,
	padStyle?: BackgroundFn,
): string {
	const expanded = expandTabs(line);
	const text = truncateToWidth(expanded, width, "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
	return `${text}${padStyle ? padStyle(padding) : padding}`;
}

export function fillAnsiLine(
	line: string,
	width: number,
	backgroundFn?: BackgroundFn,
): string {
	const expanded = expandTabs(line);
	const text = truncateToWidth(expanded, width, "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
	const padded = `${text}${padding}`;
	return backgroundFn
		? reapplyBackgroundAfterAnsiResets(padded, backgroundFn)
		: padded;
}

export function reapplyBackgroundAfterAnsiResets(
	text: string,
	backgroundFn: BackgroundFn,
): string {
	const marker = "__PI_BACKGROUND_MARKER__";
	const styledMarker = backgroundFn(marker);
	const markerIndex = styledMarker.indexOf(marker);
	if (markerIndex === -1) return text;

	const backgroundPrefix = styledMarker.slice(0, markerIndex);
	if (!text.includes("\x1b")) {
		if (!text.includes("\n")) return backgroundPrefix + text;
		return text
			.split("\n")
			.map((line) => backgroundPrefix + line)
			.join("\n");
	}

	const resetPattern = /\x1b\[(?:0|39|49)m/g;
	if (!text.includes("\n")) {
		return (
			backgroundPrefix +
			text.replace(resetPattern, (match) => `${match}${backgroundPrefix}`)
		);
	}
	return text
		.split("\n")
		.map(
			(line) =>
				backgroundPrefix +
				line.replace(
					resetPattern,
					(match) => `${match}${backgroundPrefix}`,
				),
		)
		.join("\n");
}
