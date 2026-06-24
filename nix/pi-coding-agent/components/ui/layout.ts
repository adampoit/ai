import type { Component } from "@earendil-works/pi-tui";
import { Spacer, truncateToWidth } from "@earendil-works/pi-tui";

export abstract class CachedComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines = this.doRender(width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	protected abstract doRender(width: number): string[];
}

export type StackOptions = {
	gap?: number;
	separator?: Component;
};

export class Stack implements Component {
	constructor(
		private children: Component[] = [],
		private readonly options: StackOptions = {},
	) {}

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index >= 0) this.children.splice(index, 1);
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
		this.options.separator?.invalidate();
	}

	render(width: number): string[] {
		if (this.children.length === 0) return [];

		const lines: string[] = [];
		for (let index = 0; index < this.children.length; index++) {
			lines.push(...this.children[index]!.render(width));
			if (index === this.children.length - 1) continue;

			if (this.options.separator) {
				lines.push(...this.options.separator.render(width));
			} else if (this.options.gap && this.options.gap > 0) {
				lines.push(...new Spacer(this.options.gap).render(width));
			}
		}
		return lines;
	}
}

export type InsetOptions = {
	paddingX?: number;
	paddingY?: number;
	paddingTop?: number;
	paddingBottom?: number;
};

export class Inset implements Component {
	constructor(
		private child: Component,
		private options: InsetOptions = {},
	) {}

	setChild(child: Component): void {
		this.child = child;
	}

	setOptions(options: InsetOptions): void {
		this.options = options;
	}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const paddingX = Math.max(0, this.options.paddingX ?? 0);
		const paddingTop = Math.max(
			0,
			this.options.paddingTop ?? this.options.paddingY ?? 0,
		);
		const paddingBottom = Math.max(
			0,
			this.options.paddingBottom ?? this.options.paddingY ?? 0,
		);
		const contentWidth = Math.max(0, width - paddingX * 2);
		const prefix = " ".repeat(paddingX);
		const lines: string[] = [];

		for (let index = 0; index < paddingTop; index++) lines.push("");
		for (const childLine of this.child.render(contentWidth)) {
			const content = truncateToWidth(childLine, contentWidth, "");
			lines.push(truncateToWidth(`${prefix}${content}`, width, ""));
		}
		for (let index = 0; index < paddingBottom; index++) lines.push("");
		return lines;
	}
}

export class StaticLines implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}
