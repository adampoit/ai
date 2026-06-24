import assert from "node:assert/strict";
import test from "node:test";
import renderStatsExtension from "../../../nix/pi-coding-agent/extensions/render-stats.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	runCommand,
} from "../helpers.ts";

test("render-stats extension registers its public surface", () => {
	const pi = loadExtension(renderStatsExtension);

	assertPublicSurface(pi, { commands: ["renderstats"] });
});

test("render-stats command toggles its widget", async () => {
	const pi = loadExtension(renderStatsExtension);
	const ctx = await createContext();

	await runCommand(pi, "renderstats", "", ctx);
	assert.equal(ctx.widgets.length, 1);
	assert.equal(ctx.widgets[0][0], "render-stats");
	assert.equal(typeof ctx.widgets[0][1], "function");

	await runCommand(pi, "renderstats", "", ctx);
	assert.equal(ctx.widgets.length, 2);
	assert.deepEqual(ctx.widgets[1], ["render-stats", undefined, undefined]);
	assert.deepEqual(ctx.notifications.at(-1), {
		message: "Render stats disabled",
		level: "info",
	});
});

test("render-stats widget records lifecycle events and render metrics", async () => {
	const pi = loadExtension(renderStatsExtension);
	const ctx = await createContext();

	await runCommand(pi, "renderstats", "", ctx);
	const widgetFactory = ctx.widgets[0][1] as any;
	let renderRequests = 0;
	const widget = widgetFactory(
		{
			fullRedraws: 3,
			requestRender: () => {
				renderRequests++;
			},
		},
		ctx.ui.theme,
	);

	try {
		await pi.emit("input", { text: "hello" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 2));
		const first = widget.render(120).join("\n");
		await pi.emit("tool_execution_start", { toolName: "read" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 2));
		const second = widget.render(120).join("\n");

		assert.ok(first.includes("#1"), first);
		assert.ok(first.includes("120 cols"), first);
		assert.ok(first.includes("input→render"), first);
		assert.ok(second.includes("#2"), second);
		assert.ok(second.includes("tool_start→render"), second);
		assert.equal(typeof renderRequests, "number");
	} finally {
		widget.dispose();
	}
});
