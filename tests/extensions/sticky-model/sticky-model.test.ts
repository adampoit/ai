import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
		ctx.model = { provider: "openai", id: "gpt-test" };
		await pi.emit("thinking_level_select", { level: "medium" }, ctx);

		const store = JSON.parse(
			await readFile(
				path.join(home, ".pi/agent/sticky-models.json"),
				"utf8",
			),
		);
		assert.deepEqual(store, {
			version: 2,
			directories: {
				[ctx.cwd]: {
					provider: "openai",
					model: "gpt-test",
				},
			},
			modelPreferences: {
				"openai/gpt-test": { thinkingLevel: "medium" },
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

test("sticky-model restores thinking levels globally per selected model", async () => {
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
		ctx.model = { provider: "openai", id: "gpt-a" };
		await pi.emit("thinking_level_select", { level: "medium" }, ctx);

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

		const otherCtx = await createContext({ cwd: "/tmp/project-b" });
		pi.thinkingLevel = "max";
		await pi.emit(
			"model_select",
			{
				source: "set",
				model: { provider: "openai", id: "gpt-a" },
			},
			otherCtx,
		);

		assert.equal(pi.thinkingLevel, "medium");

		const store = JSON.parse(
			await readFile(
				path.join(home, ".pi/agent/sticky-models.json"),
				"utf8",
			),
		);
		assert.deepEqual(store, {
			version: 2,
			directories: {
				"/tmp/project-a": {
					provider: "openai",
					model: "gpt-a",
				},
				"/tmp/project-b": {
					provider: "openai",
					model: "gpt-a",
				},
			},
			modelPreferences: {
				"openai/gpt-a": { thinkingLevel: "medium" },
				"anthropic/claude-b": { thinkingLevel: "low" },
			},
		});
	} finally {
		process.env.HOME = oldHome;
	}
});

test("sticky-model migrates legacy directory-scoped thinking levels", async () => {
	const oldHome = process.env.HOME;
	const home = await mkdtemp(path.join(tmpdir(), "pi-sticky-home-"));
	try {
		const storeDirectory = path.join(home, ".pi/agent");
		await mkdir(storeDirectory, { recursive: true });
		await writeFile(
			path.join(storeDirectory, "sticky-models.json"),
			JSON.stringify({
				"/tmp/project-a": {
					provider: "openai",
					model: "gpt-test",
					thinkingLevels: { "openai/gpt-test": "medium" },
				},
			}),
		);

		const stickyModelExtension = await importStickyModelExtension(home);
		const pi = loadExtension(stickyModelExtension);
		const ctx = await createContext({ cwd: "/tmp/project-a" });
		const restoredModel = { provider: "openai", id: "gpt-test" };
		ctx.model = { provider: "other", id: "current" };
		ctx.modelRegistry.find = () => restoredModel;

		await pi.emit("session_start", { reason: "startup" }, ctx);

		assert.deepEqual(pi.selectedModels, [restoredModel]);
		assert.deepEqual(pi.selectedThinkingLevels, ["medium"]);
		assert.deepEqual(
			JSON.parse(
				await readFile(
					path.join(home, ".pi/agent/sticky-models.json"),
					"utf8",
				),
			),
			{
				version: 2,
				directories: {
					"/tmp/project-a": {
						provider: "openai",
						model: "gpt-test",
					},
				},
				modelPreferences: {
					"openai/gpt-test": { thinkingLevel: "medium" },
				},
			},
		);
	} finally {
		process.env.HOME = oldHome;
	}
});
