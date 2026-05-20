import {
	bg as ansiBg,
	fg as ansiFg,
	style as ansiStyle,
	type BackgroundFn,
	type ColorHex,
} from "./ansi.ts";
import { gruvbox, type GruvboxColor } from "./gruvbox.ts";

export type PiThemeLike = {
	fg: (color: any, text: string) => string;
	bg: (color: any, text: string) => string;
	bold?: (text: string) => string;
	italic?: (text: string) => string;
	underline?: (text: string) => string;
};

export type ColorSpec =
	| GruvboxColor
	| ColorHex
	| string
	| ((text: string) => string)
	| undefined;

export type StyleOptions = {
	fg?: ColorSpec;
	bg?: ColorSpec;
	theme?: PiThemeLike;
};

export function isGruvboxColor(value: string): value is GruvboxColor {
	return Object.prototype.hasOwnProperty.call(gruvbox, value);
}

export function isHexColor(value: string): value is ColorHex {
	return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function resolveRawColor(color: ColorSpec): string | undefined {
	if (typeof color !== "string") return undefined;
	if (isGruvboxColor(color)) return gruvbox[color];
	if (isHexColor(color)) return color;
	return undefined;
}

export function paintForeground(
	color: ColorSpec,
	theme?: PiThemeLike,
): (text: string) => string {
	if (!color) return (text) => text;
	if (typeof color === "function") return color;

	const raw = resolveRawColor(color);
	if (raw) return (text) => ansiFg(raw, text);
	if (theme) return (text) => theme.fg(color, text);
	return (text) => text;
}

export function paintBackground(
	color: ColorSpec,
	theme?: PiThemeLike,
): BackgroundFn {
	if (!color) return (text) => text;
	if (typeof color === "function") return color;

	const raw = resolveRawColor(color);
	if (raw) return (text) => ansiBg(raw, text);
	if (theme) return (text) => theme.bg(color, text);
	return (text) => text;
}

export function styleText(text: string, options: StyleOptions = {}): string {
	const fgRaw = resolveRawColor(options.fg);
	const bgRaw = resolveRawColor(options.bg);
	if (fgRaw && bgRaw) return ansiStyle(text, fgRaw, bgRaw);
	if (fgRaw) return ansiFg(fgRaw, text);
	if (bgRaw) return ansiBg(bgRaw, text);

	let value = text;
	if (options.fg) value = paintForeground(options.fg, options.theme)(value);
	if (options.bg) value = paintBackground(options.bg, options.theme)(value);
	return value;
}
