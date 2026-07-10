import assert from "node:assert/strict";
import test from "node:test";
import {
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	asToolPresentation,
	ToolPresentation,
} from "../../../nix/pi-coding-agent/components/index.ts";
import {
	genericInvocationArguments,
	installGlobalToolFraming,
} from "../../../nix/pi-coding-agent/extensions/global-tool-framing.ts";

initTheme(undefined, false);

const ui = { requestRender() {} } as any;

function plain(lines: string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function definition(overrides: Record<string, unknown> = {}) {
	return {
		name: "fixture_tool",
		label: "Fixture Tool",
		description: "fixture",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [], details: {} }),
		renderCall: () => new Text("plugin progress", 0, 0),
		renderResult: () => new Text("plugin result", 0, 0),
		...overrides,
	} as any;
}

test("ordinary third-party renderers receive one global frame", () => {
	const component = new ToolExecutionComponent(
		"fixture_tool",
		"call-1",
		{ query: "hello", count: 0, enabled: false, omitted: undefined },
		{},
		definition(),
		ui,
		process.cwd(),
	);
	component.markExecutionStarted();
	let rendered = plain(component.render(72));
	assert.match(rendered, /Fixture Tool.*running/);
	assert.match(rendered, /query.*hello/);
	assert.match(rendered, /count.*0/);
	assert.match(rendered, /enabled.*false/);
	assert.match(rendered, /plugin progress/);
	assert.equal((rendered.match(/╭/g) ?? []).length, 1);

	component.updateResult(
		{ content: [{ type: "text", text: "done" }], isError: false },
		false,
	);
	rendered = plain(component.render(72));
	assert.match(rendered, /Fixture Tool.*done/);
	assert.match(rendered, /plugin result/);
	assert.ok(
		component.render(34).every((line) => visibleWidth(line) <= 34),
		"narrow rendering must respect terminal width",
	);
});

test("generic framing preserves plugin errors and expansion state", () => {
	const expandedValues: boolean[] = [];
	const component = new ToolExecutionComponent(
		"fixture_tool",
		"call-2",
		{ nested: { one: 1 } },
		{},
		definition({
			renderResult: (
				_result: unknown,
				options: { expanded: boolean },
			) => {
				expandedValues.push(options.expanded);
				return new Text("plugin failure details", 0, 0);
			},
		}),
		ui,
		process.cwd(),
	);
	component.setExpanded(true);
	component.updateResult(
		{ content: [{ type: "text", text: "failed" }], isError: true },
		false,
	);
	const rendered = plain(component.render(60));
	assert.match(rendered, /error/);
	assert.match(rendered, /plugin failure details/);
	assert.equal(expandedValues.at(-1), true);
	assert.doesNotMatch(rendered, /ctrl\+o/);
});

test("ToolPresentation exposes its model by a cross-module symbol", () => {
	let invalidations = 0;
	const body = {
		render: () => ["rich body"],
		invalidate: () => invalidations++,
	};
	const presentation = new ToolPresentation({
		title: "specialized",
		children: body,
	});
	assert.equal(asToolPresentation(presentation), presentation);
	assert.deepEqual(presentation.render(20), ["rich body"]);
	presentation.setOptions({ title: "updated", children: body });
	assert.equal(presentation.getOptions().title, "updated");
	assert.equal(invalidations, 1);
});

test("specialized presentations retain rich framing metadata", () => {
	const component = new ToolExecutionComponent(
		"fixture_tool",
		"call-3",
		{},
		{},
		definition({
			renderCall: () =>
				new ToolPresentation({
					title: "specialized",
					icon: "*",
					state: "success",
					status: "found",
					telemetry: ["2 matches"],
					children: new Text("highlighted matches", 0, 0),
				}),
			renderResult: () => new Text("", 0, 0),
		}),
		ui,
		process.cwd(),
	);
	const rendered = plain(component.render(60));
	assert.match(rendered, /specialized.*found/);
	assert.match(rendered, /highlighted matches/);
	assert.match(rendered, /2 matches/);
});

test("patch installation is idempotent and generic values are conservative", () => {
	installGlobalToolFraming();
	installGlobalToolFraming();
	const args = genericInvocationArguments({
		missing: undefined,
		empty: "",
		zero: 0,
		flag: false,
		array: ["a", "b"],
		nested: { value: "x" },
		long: { value: "x".repeat(300) },
	});
	assert.deepEqual(
		args.map((arg) => arg.label),
		["zero", "flag", "array", "nested", "long"],
	);
	assert.equal(args[0]?.value, 0);
	assert.equal(args[1]?.value, false);
	assert.equal(args[2]?.value, "a, b");
	assert.equal(String(args[4]?.value).length, 240);
});
