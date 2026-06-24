import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type StickyModel = {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
};

type Store = Record<string, StickyModel>;

const storePath = join(homedir(), ".pi", "agent", "sticky-models.json");

async function readStore(): Promise<Store> {
	try {
		return JSON.parse(await readFile(storePath, "utf8"));
	} catch {
		return {};
	}
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
		const saved = (await getStore())[ctx.cwd];
		if (!saved) return;
		const modelAlreadySelected =
			ctx.model?.provider === saved.provider &&
			ctx.model.id === saved.model;
		if (modelAlreadySelected) {
			if (saved.thinkingLevel) pi.setThinkingLevel(saved.thinkingLevel);
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
			if (saved.thinkingLevel) pi.setThinkingLevel(saved.thinkingLevel);
		} finally {
			queueMicrotask(() => {
				applyingStickyModel = false;
			});
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (applyingStickyModel) return;
		if (event.source !== "set" && event.source !== "cycle") return;

		await updateStore((store) => {
			store[ctx.cwd] = {
				provider: event.model.provider,
				model: event.model.id,
				thinkingLevel: pi.getThinkingLevel(),
			};
		});
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		await updateStore((store) => {
			const provider = ctx.model?.provider ?? store[ctx.cwd]?.provider;
			const model = ctx.model?.id ?? store[ctx.cwd]?.model;
			if (!provider || !model) return;

			store[ctx.cwd] = {
				provider,
				model,
				thinkingLevel: event.level,
			};
		});
	});
}
