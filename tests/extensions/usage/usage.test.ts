import assert from "node:assert/strict";
import test from "node:test";
import usageExtension from "../../../nix/pi-coding-agent/extensions/usage.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	runCommand,
} from "../helpers.ts";

test("usage extension registers its public surface", () => {
	const pi = loadExtension(usageExtension);

	assertPublicSurface(pi, { commands: ["usage"] });
});

test("usage command renders subscription and local session usage", async () => {
	const pi = loadExtension(usageExtension);
	const rendered: string[] = [];
	const ctx = await createContext();
	ctx.sessionManager.getEntries = () => [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 1000,
					output: 2000,
					cacheRead: 300,
					cacheWrite: 400,
					cost: { total: 0.0456 },
				},
			},
		},
	];
	ctx.ui.custom = async (factory: any, options?: unknown) => {
		assert.deepEqual(options, { overlay: false });
		const view = factory(
			{ requestRender() {} },
			ctx.ui.theme,
			{ matches: () => false },
			() => {},
		);
		rendered.push(...view.render(120));
		return undefined as never;
	};

	await runCommand(pi, "usage", "", ctx);

	const output = rendered.join("\n");
	assert.ok(output.includes("Subscription quotas"), output);
	assert.ok(output.includes("OpenAI"), output);
	assert.ok(output.includes("GitHub Copilot"), output);
	assert.ok(output.includes("Local Pi session usage"), output);
	assert.ok(output.includes("3.7k tokens"), output);
	assert.ok(output.includes("$0.05"), output);
});

test("usage command exposes expected completions", () => {
	const pi = loadExtension(usageExtension);
	const command = pi.commands.get("usage");

	assert.deepEqual(command?.getArgumentCompletions?.("auth"), [
		{ value: "auth opencode-go", label: "auth opencode-go" },
	]);
});
