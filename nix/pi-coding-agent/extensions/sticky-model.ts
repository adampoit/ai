import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ModelReference = {
	provider: string;
	model: string;
};

type ModelPreference = {
	thinkingLevel: ThinkingLevel;
};

type Store = {
	version: 2;
	directories: Record<string, ModelReference>;
	modelPreferences: Record<string, ModelPreference>;
};

const storeVersion = 2;
const storePath = join(homedir(), ".pi", "agent", "sticky-models.json");

function modelKey(provider: string, model: string) {
	return `${provider}/${model}`;
}

function createStore(): Store {
	return {
		version: storeVersion,
		directories: {},
		modelPreferences: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isModelReference(value: unknown): value is ModelReference {
	return (
		isRecord(value) &&
		typeof value.provider === "string" &&
		typeof value.model === "string"
	);
}

function isModelPreference(value: unknown): value is ModelPreference {
	return isRecord(value) && isThinkingLevel(value.thinkingLevel);
}

function isCurrentStore(value: unknown): value is Store {
	if (
		!isRecord(value) ||
		value.version !== storeVersion ||
		!isRecord(value.directories) ||
		!isRecord(value.modelPreferences)
	) {
		return false;
	}

	return (
		Object.values(value.directories).every(isModelReference) &&
		Object.values(value.modelPreferences).every(isModelPreference)
	);
}

function migrateLegacyStore(value: Record<string, unknown>): Store {
	const store = createStore();

	for (const [cwd, saved] of Object.entries(value)) {
		if (!isRecord(saved)) continue;
		const thinkingLevels = saved.thinkingLevels;
		if (!isModelReference(saved)) continue;

		store.directories[cwd] = {
			provider: saved.provider,
			model: saved.model,
		};

		if (!isRecord(thinkingLevels)) continue;
		for (const [key, level] of Object.entries(thinkingLevels)) {
			if (isThinkingLevel(level)) {
				store.modelPreferences[key] = { thinkingLevel: level };
			}
		}
	}

	return store;
}

async function writeStore(store: Store) {
	await mkdir(dirname(storePath), { recursive: true });
	const tempPath = `${storePath}.${randomUUID()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`);
	try {
		await rename(tempPath, storePath);
	} catch (err) {
		await unlink(tempPath).catch(() => {});
		throw err;
	}
}

async function readStore(): Promise<Store> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(storePath, "utf8"));
	} catch {
		return createStore();
	}

	if (isCurrentStore(value)) return value;
	if (!isRecord(value) || "version" in value) return createStore();

	const migrated = migrateLegacyStore(value);
	try {
		await writeStore(migrated);
	} catch {
		// Keep using the migrated in-memory store if the legacy file is read-only.
	}
	return migrated;
}

function getSavedThinkingLevel(
	store: Store,
	model: ModelReference | undefined,
) {
	if (!model) return undefined;
	return store.modelPreferences[modelKey(model.provider, model.model)]
		?.thinkingLevel;
}

// Serialize all updates so concurrent handlers can't race.
let lock: Promise<void> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		lock = lock.then(fn).then(resolve, reject);
	});
}

// Load the store once into memory; all reads and writes use this cache.
let storeCache: Store | null = null;

async function getStore(): Promise<Store> {
	if (!storeCache) storeCache = await readStore();
	return storeCache;
}

async function updateStore(fn: (store: Store) => void) {
	await serialize(async () => {
		const store = await getStore();
		fn(store);
		await writeStore(store);
	});
}

export default function (pi: ExtensionAPI) {
	let applyingStickyModel = false;

	pi.on("session_start", async (_event, ctx) => {
		const store = await getStore();
		const saved = store.directories[ctx.cwd];
		if (!saved) return;
		const modelAlreadySelected =
			ctx.model?.provider === saved.provider &&
			ctx.model.id === saved.model;
		if (modelAlreadySelected) {
			const thinkingLevel = getSavedThinkingLevel(store, saved);
			if (thinkingLevel) pi.setThinkingLevel(thinkingLevel);
			return;
		}

		const model = ctx.modelRegistry.find(saved.provider, saved.model);
		if (!model) {
			ctx.ui.notify(
				`Sticky model not found: ${saved.provider}/${saved.model}`,
				"warning",
			);
			return;
		}

		applyingStickyModel = true;
		try {
			const success = await pi.setModel(model);
			if (!success) {
				ctx.ui.notify(
					`Sticky model unavailable: ${saved.provider}/${saved.model}`,
					"warning",
				);
				return;
			}
			const thinkingLevel = getSavedThinkingLevel(store, saved);
			if (thinkingLevel) pi.setThinkingLevel(thinkingLevel);
		} finally {
			queueMicrotask(() => {
				applyingStickyModel = false;
			});
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (applyingStickyModel) return;
		if (event.source !== "set" && event.source !== "cycle") return;

		let thinkingLevelToRestore: ThinkingLevel | undefined;
		await updateStore((store) => {
			const key = modelKey(event.model.provider, event.model.id);
			thinkingLevelToRestore = store.modelPreferences[key]?.thinkingLevel;

			store.directories[ctx.cwd] = {
				provider: event.model.provider,
				model: event.model.id,
			};
		});

		if (thinkingLevelToRestore) {
			pi.setThinkingLevel(thinkingLevelToRestore);
		}
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		await updateStore((store) => {
			const current = store.directories[ctx.cwd];
			const provider = ctx.model?.provider ?? current?.provider;
			const model = ctx.model?.id ?? current?.model;
			if (!provider || !model) return;

			store.directories[ctx.cwd] = { provider, model };
			store.modelPreferences[modelKey(provider, model)] = {
				thinkingLevel: event.level,
			};
		});
	});
}
