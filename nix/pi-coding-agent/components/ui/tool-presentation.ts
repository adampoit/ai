import type { Component } from "@earendil-works/pi-tui";
import type { ToolShellOptions } from "./blocks.ts";

export const TOOL_PRESENTATION = Symbol.for(
	"adam.poit.pi.global-tool-framing.presentation.v1",
);

export type ToolPresentationModel = ToolShellOptions;

export interface ToolPresentationMarked extends Component {
	readonly [TOOL_PRESENTATION]: true;
	getOptions(): ToolPresentationModel;
}

/** Declarative tool presentation. The global adapter supplies its frame. */
export class ToolPresentation implements ToolPresentationMarked {
	readonly [TOOL_PRESENTATION] = true as const;

	constructor(private options: ToolPresentationModel) {}

	setOptions(options: ToolPresentationModel): void {
		this.options = options;
		this.invalidate();
	}

	getOptions(): ToolPresentationModel {
		return this.options;
	}

	render(width: number): string[] {
		const children = normalizeChildren(this.options.children);
		return children.flatMap((child) => child.render(width));
	}

	invalidate(): void {
		for (const child of normalizeChildren(this.options.children)) {
			child.invalidate();
		}
		if (isComponent(this.options.invocation)) {
			this.options.invocation.invalidate();
		}
	}
}

export function asToolPresentation(
	value: unknown,
): ToolPresentationMarked | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<ToolPresentationMarked>;
	return candidate[TOOL_PRESENTATION] === true &&
		typeof candidate.getOptions === "function"
		? (candidate as ToolPresentationMarked)
		: undefined;
}

function normalizeChildren(
	children: ToolShellOptions["children"],
): Component[] {
	if (!children) return [];
	return Array.isArray(children) ? children : [children];
}

function isComponent(value: unknown): value is Component {
	return (
		typeof value === "object" &&
		value !== null &&
		"render" in value &&
		typeof (value as Component).render === "function"
	);
}
