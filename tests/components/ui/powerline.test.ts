import assert from "node:assert/strict";
import test from "node:test";
import {
	PowerlineStatusLine,
	gruvbox,
	stripAnsi,
} from "../../../nix/pi-coding-agent/components/ui/index.ts";

test("status line drops lower-priority right segments first", () => {
	const output = new PowerlineStatusLine({
		right: [
			{
				text: "cost",
				fg: gruvbox.fg,
				bg: gruvbox.bg2,
				priority: 40,
			},
			{
				text: "low",
				fg: gruvbox.fg,
				bg: gruvbox.bg2,
				priority: 10,
			},
			{
				text: "model",
				fg: gruvbox.fg0,
				bg: gruvbox.orange,
				priority: 100,
			},
		],
	}).render(16)[0];
	const plainOutput = stripAnsi(output);

	assert.ok(!plainOutput.includes("low"), plainOutput);
	assert.ok(plainOutput.includes("cost"), plainOutput);
	assert.ok(plainOutput.includes("model"), plainOutput);
});

test("status line applies segment priorities to the left side", () => {
	const output = new PowerlineStatusLine({
		left: [
			{
				text: "diagnostics",
				fg: gruvbox.fg3,
				bg: gruvbox.bg1,
				priority: 10,
			},
			{
				text: "project",
				fg: gruvbox.fg0,
				bg: gruvbox.blue,
				priority: 90,
			},
		],
		right: [
			{
				text: "model",
				fg: gruvbox.fg0,
				bg: gruvbox.orange,
				priority: 100,
			},
		],
	}).render(20)[0];
	const plainOutput = stripAnsi(output);

	assert.ok(!plainOutput.includes("diagnostics"), plainOutput);
	assert.ok(plainOutput.includes("project"), plainOutput);
	assert.ok(plainOutput.includes("model"), plainOutput);
});
