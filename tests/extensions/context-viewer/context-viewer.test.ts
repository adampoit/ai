import assert from "node:assert/strict";
import test from "node:test";
import contextViewerExtension from "../../../nix/pi-coding-agent/extensions/context-viewer.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	runCommand,
} from "../helpers.ts";

test("context-viewer extension registers its public surface", () => {
	const pi = loadExtension(contextViewerExtension);

	assertPublicSurface(pi, {
		commands: ["context"],
		handlers: ["before_agent_start", "context"],
	});
});

test("context-viewer captures prompt and live context for rendering", async () => {
	const pi = loadExtension(contextViewerExtension);
	const rendered: string[] = [];
	const ctx = await createContext();
	ctx.ui.custom = async (factory: any, options?: unknown) => {
		assert.deepEqual(options, {
			overlay: true,
			overlayOptions: {
				width: "90%",
				minWidth: 70,
				maxHeight: "90%",
				anchor: "center",
			},
		});
		const view = factory(
			{ requestRender() {} },
			ctx.ui.theme,
			{ matches: () => false },
			() => {},
		);
		rendered.push(...view.render(100));
		view.handleInput("6");
		rendered.push(...view.render(100));
		return undefined as never;
	};

	await pi.emit(
		"before_agent_start",
		{
			prompt: "Inspect the project",
			systemPrompt: "System prompt with AGENTS.md and skill details",
			systemPromptOptions: {
				cwd: ctx.cwd,
				contextFiles: [
					{
						path: "AGENTS.md",
						content: "Repository instructions",
					},
				],
				skills: [
					{
						name: "testing",
						description: "Testing skill",
						filePath: `${ctx.cwd}/skills/testing/SKILL.md`,
						baseDir: `${ctx.cwd}/skills/testing`,
						sourceInfo: { source: "test" },
						disableModelInvocation: false,
					},
				],
				toolSnippets: { read: "Read files" },
			},
		},
		ctx,
	);
	await pi.emit(
		"context",
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			],
		},
		ctx,
	);

	await runCommand(pi, "context", "last live", ctx);

	const output = rendered.join("\n");
	assert.ok(output.includes("Context Viewer"), output);
	assert.ok(output.includes("last live"), output);
	assert.ok(output.includes("2 messages"), output);
	assert.ok(output.includes("Inspect the project"), output);
});

test("context-viewer command exposes expected completions", () => {
	const pi = loadExtension(contextViewerExtension);
	const command = pi.commands.get("context");

	assert.deepEqual(command?.getArgumentCompletions?.("c"), [
		{ value: "current", label: "current" },
	]);
	assert.deepEqual(command?.getArgumentCompletions?.("last"), [
		{ value: "last live", label: "last live" },
	]);
});
