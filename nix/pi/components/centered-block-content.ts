import {
	truncateToWidth,
	type Component,
	visibleWidth,
} from "@mariozechner/pi-tui";

export type BackgroundFn = (value: string) => string;

export class CenteredBlockContent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly child: Component,
		private readonly gutterBackground: BackgroundFn,
		private readonly widthRatio = 0.95,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.child.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const contentWidth = Math.max(1, Math.floor(width * this.widthRatio));
		const gutterWidth = Math.max(0, width - contentWidth);
		const leftGutterWidth = Math.floor(gutterWidth / 2);
		const rightGutterWidth = gutterWidth - leftGutterWidth;
		const leftGutter =
			leftGutterWidth > 0
				? this.gutterBackground(" ".repeat(leftGutterWidth))
				: "";
		const rightGutter =
			rightGutterWidth > 0
				? this.gutterBackground(" ".repeat(rightGutterWidth))
				: "";

		this.cachedWidth = width;
		this.cachedLines = this.child.render(contentWidth).map((line) => {
			const paddedLine = padAnsiLine(line, contentWidth);
			return `${leftGutter}${paddedLine}${rightGutter}`;
		});
		return this.cachedLines;
	}
}

function padAnsiLine(line: string, width: number): string {
	const text = truncateToWidth(line, width, "");
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
