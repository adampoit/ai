import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
} from "../helpers.ts";

async function importStickyModelExtension(home: string) {
	process.env.HOME = home;
	const module = await import(
		`../../../nix/pi-coding-agent/extensions/sticky-model.ts?home=${encodeURIComponent(home)}&t=${Date.now()}`
	);
	return module.default;
}

test("sticky-model extension registers its public surface", async () => {
	const oldHome = process.env.HOME;
	const home = await mkdtemp(path.join(tmpdir(), "pi-sticky-home-"));
	try {
		const stickyModelExtension = await importStickyModelExtension(home);
		const pi = loadExtension(stickyModelExtension);

		assertPublicSurface(pi, {
			handlers: [
				"model_select",
				"session_start",
				"thinking_level_select",
			],
		});
	} finally {
		process.env.HOME = oldHome;
	}
});

test("sticky-model persists selected model and reapplies it on session start", async () => {
	const oldHome = process.env.HOME;
	const home = await mkdtemp(path.join(tmpdir(), "pi-sticky-home-"));
	try {
		const stickyModelExtension = await importStickyModelExtension(home);
		const pi = loadExtension(stickyModelExtension);
		pi.thinkingLevel = "medium";
		const ctx = await createContext({ cwd: "/tmp/project-a" });

		await pi.emit(
			"model_select",
			{
				source: "set",
				model: { provider: "openai", id: "gpt-test" },
			},
			ctx,
		);

		const store = JSON.parse(
			await readFile(
				path.join(home, ".pi/agent/sticky-models.json"),
				"utf8",
			),
		);
		assert.deepEqual(store[ctx.cwd], {
			provider: "openai",
			model: "gpt-test",
			thinkingLevels: {
				"openai/gpt-test": "medium",
			},
		});

		const restoredModel = { provider: "openai", id: "gpt-test" };
		const restorePi = loadExtension(stickyModelExtension);
		const restoreCtx = await createContext({ cwd: ctx.cwd });
		restoreCtx.model = { provider: "other", id: "current" };
		restoreCtx.modelRegistry.find = (provider, model) => {
			assert.equal(provider, "openai");
			assert.equal(model, "gpt-test");
			return restoredModel;
		};

		await restorePi.emit(
			"session_start",
			{ reason: "startup" },
			restoreCtx,
		);

		assert.deepEqual(restorePi.selectedModels, [restoredModel]);
		assert.deepEqual(restorePi.selectedThinkingLevels, ["medium"]);
	} finally {
		process.env.HOME = oldHome;
	}
});

test("sticky-model restores thinking levels per selected model", async () => {
	const oldHome = process.env.HOME;
	const home = await mkdtemp(path.join(tmpdir(), "pi-sticky-home-"));
	try {
		const stickyModelExtension = await importStickyModelExtension(home);
		const pi = loadExtension(stickyModelExtension);
		const ctx = await createContext({ cwd: "/tmp/project-a" });

		pi.thinkingLevel = "medium";
		await pi.emit(
			"model_select",
			{
				source: "set",
				model: { provider: "openai", id: "gpt-a" },
			},
			ctx,
		);

		pi.thinkingLevel = "high";
		await pi.emit(
			"model_select",
			{
				source: "set",
				model: { provider: "anthropic", id: "claude-b" },
			},
			ctx,
		);
		ctx.model = { provider: "anthropic", id: "claude-b" };
		await pi.emit("thinking_level_select", { level: "low" }, ctx);

		pi.thinkingLevel = "low";
		await pi.emit(
			"model_select",
			{
				source: "set",
				model: { provider: "openai", id: "gpt-a" },
			},
			ctx,
		);

		assert.equal(pi.thinkingLevel, "medium");
		assert.deepEqual(pi.selectedThinkingLevels, ["medium"]);

		const store = JSON.parse(
			await readFile(
				path.join(home, ".pi/agent/sticky-models.json"),
				"utf8",
			),
		);
		assert.deepEqual(store[ctx.cwd], {
			provider: "openai",
			model: "gpt-a",
			thinkingLevels: {
				"openai/gpt-a": "medium",
				"anthropic/claude-b": "low",
			},
		});
	} finally {
		process.env.HOME = oldHome;
	}
});
