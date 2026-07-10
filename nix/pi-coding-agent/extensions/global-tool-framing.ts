import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	asToolPresentation,
	StaticLines,
	ToolShell,
	type InvocationArgument,
	type ToolShellOptions,
} from "../components/index.ts";

/** Pi 0.80.5 is pinned in package.json and is the implementation validated here. */
export const SUPPORTED_PI_TOOL_FRAME_VERSION = "0.80.5";

const PATCH = Symbol.for("adam.poit.pi.global-tool-framing.patch.v1");
const FRAME = Symbol.for("adam.poit.pi.global-tool-framing.frame.v1");

type ToolExecutionInternals = {
	contentBox: ContainerLike;
	contentText: Component;
	selfRenderContainer: ContainerLike;
	callRendererComponent?: Component;
	resultRendererComponent?: Component;
	imageComponents: Component[];
	imageSpacers: Component[];
	toolName: string;
	args: Record<string, unknown> | undefined;
	expanded: boolean;
	isPartial: boolean;
	toolDefinition?: { label?: string };
	builtInToolDefinition?: { label?: string };
	executionStarted: boolean;
	result?: { isError: boolean };
	hideComponent: boolean;
	getRenderShell(): "default" | "self";
	updateDisplay(): void;
	[FRAME]?: ToolShell;
};

type ContainerLike = Component & {
	children: Component[];
	clear(): void;
	addChild(component: Component): void;
};

type PatchRecord = {
	originalUpdateDisplay: (this: ToolExecutionInternals) => void;
	originalRender: (this: ToolExecutionInternals, width: number) => string[];
	apply: (instance: ToolExecutionInternals) => void;
};

export function installGlobalToolFraming(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as {
		updateDisplay?: (this: ToolExecutionInternals) => void;
		render?: (this: ToolExecutionInternals, width: number) => string[];
		[PATCH]?: PatchRecord;
	};

	const existing = prototype[PATCH];
	if (existing) {
		existing.apply = applyFrame;
		return;
	}
	if (
		typeof prototype.updateDisplay !== "function" ||
		typeof prototype.render !== "function"
	) {
		throw compatibilityError(
			"expected updateDisplay() and render() methods",
		);
	}

	const record: PatchRecord = {
		originalUpdateDisplay: prototype.updateDisplay,
		originalRender: prototype.render,
		apply: applyFrame,
	};
	Object.defineProperty(prototype, PATCH, { value: record });

	prototype.updateDisplay = function () {
		assertCompatibleInstance(this);
		record.originalUpdateDisplay.call(this);
		record.apply(this);
	};
	prototype.render = function (width) {
		if (this.getRenderShell() === "default" && this[FRAME]) {
			if (this.hideComponent) return [];
			const lines = ["", ...this[FRAME].render(width)];
			for (let index = 0; index < this.imageComponents.length; index++) {
				const spacer = this.imageSpacers[index];
				if (spacer) lines.push(...spacer.render(width));
				const image = this.imageComponents[index];
				if (image) lines.push(...image.render(width));
			}
			return lines;
		}
		return record.originalRender.call(this, width);
	};
}

function applyFrame(instance: ToolExecutionInternals): void {
	if (instance.getRenderShell() !== "default") {
		instance[FRAME] = undefined;
		return;
	}
	assertCompatibleInstance(instance);

	const presentation = asToolPresentation(instance.callRendererComponent);
	const options = presentation
		? presentation.getOptions()
		: buildGenericOptions(instance);
	const shell = instance[FRAME] ?? new ToolShell(options);
	shell.setOptions(options);
	instance[FRAME] = shell;
}

function buildGenericOptions(
	instance: ToolExecutionInternals,
): ToolShellOptions {
	const isError = instance.result?.isError ?? false;
	const isPending = instance.isPartial;
	const state = isError ? "error" : isPending ? "pending" : "success";
	const status = isError
		? "error"
		: isPending
			? instance.executionStarted
				? "running"
				: "queued"
			: "done";
	const children = genericBody(instance);
	return {
		title:
			instance.toolDefinition?.label ??
			instance.builtInToolDefinition?.label ??
			instance.toolName,
		state,
		status,
		invocation: {
			args: genericInvocationArguments(instance.args),
		},
		children,
	};
}

export function genericInvocationArguments(
	args: Record<string, unknown> | undefined,
): InvocationArgument[] {
	return Object.entries(args ?? {})
		.filter(([, value]) => isVisibleArgument(value))
		.map(([label, value]) => ({ label, value: compactValue(value) }));
}

function genericBody(instance: ToolExecutionInternals): Component[] {
	const components = [
		instance.callRendererComponent,
		instance.resultRendererComponent,
	].filter((component): component is Component => Boolean(component));
	if (components.length > 0) return components;
	return instance.contentText
		? [instance.contentText]
		: [new StaticLines([])];
}

function isVisibleArgument(value: unknown): boolean {
	return !(
		value === undefined ||
		value === null ||
		value === "" ||
		(Array.isArray(value) && value.length === 0) ||
		(typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			Object.keys(value).length === 0)
	);
}

function compactValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(compactValue).join(", ");
	if (typeof value !== "object" || value === null) return value;
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		return "[object]";
	}
	return json.length <= 240 ? json : `${json.slice(0, 239)}…`;
}

function assertCompatibleInstance(instance: ToolExecutionInternals): void {
	const missing = [
		"contentBox",
		"contentText",
		"selfRenderContainer",
		"imageComponents",
		"imageSpacers",
		"toolName",
		"isPartial",
		"executionStarted",
	].filter((field) => !(field in instance));
	if (missing.length > 0) {
		throw compatibilityError(
			`missing instance fields: ${missing.join(", ")}`,
		);
	}
	if (typeof instance.getRenderShell !== "function") {
		throw compatibilityError("missing getRenderShell()");
	}
}

function compatibilityError(reason: string): Error {
	return new Error(
		`Global tool framing is incompatible with this Pi build (${reason}). ` +
			`Supported Pi version: ${SUPPORTED_PI_TOOL_FRAME_VERSION}.`,
	);
}

installGlobalToolFraming();

export default function (_pi: ExtensionAPI) {
	installGlobalToolFraming();
}
