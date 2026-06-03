import { background, type BackgroundFn } from "./ansi.ts";

export const gruvbox = {
	bg0Hard: "#1d2021",
	bg: "#282828",
	bg0Soft: "#32302f",
	bg1: "#3c3836",
	bg2: "#504945",
	bg3: "#665c54",
	bg4: "#7c6f64",
	fg0: "#fbf1c7",
	fg: "#ebdbb2",
	fg2: "#d5c4a1",
	fg3: "#bdae93",
	fg4: "#a89984",
	red: "#cc241d",
	green: "#98971a",
	yellow: "#d79921",
	blue: "#458588",
	purple: "#b16286",
	aqua: "#689d6a",
	orange: "#d65d0e",
	gray: "#a89984",
	brightRed: "#fb4934",
	brightGreen: "#b8bb26",
	brightYellow: "#fabd2f",
	brightBlue: "#83a598",
	brightPurple: "#d3869b",
	brightAqua: "#8ec07c",
	brightGray: "#928374",
} as const;

export type GruvboxColor = keyof typeof gruvbox;

export function gruvboxHex(color: GruvboxColor | string): string {
	return color in gruvbox ? gruvbox[color as GruvboxColor] : color;
}

export function gruvboxBackground(color: GruvboxColor | string): BackgroundFn {
	return background(gruvboxHex(color));
}
