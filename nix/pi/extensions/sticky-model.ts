import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type StickyModel = {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
};

const storePath = join(homedir(), ".pi", "agent", "sticky-models.json");

async function readStore(): Promise<Record<string, StickyModel>> {
	try {
		return JSON.parse(await readFile(storePath, "utf8"));
	} catch {
		return {};
	}
}

async function writeStore(store: Record<string, StickyModel>) {
	await mkdir(dirname(storePath), { recursive: true });
	const tempPath = `${storePath}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`);
	await rename(tempPath, storePath);
}

export default function (pi: ExtensionAPI) {
	let applyingStickyModel = false;

	pi.on("session_start", async (_event, ctx) => {
		const saved = (await readStore())[ctx.cwd];
		if (!saved) return;
		const modelAlreadySelected =
			ctx.model?.provider === saved.provider && ctx.model.id === saved.model;
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

		const store = await readStore();
		store[ctx.cwd] = {
			provider: event.model.provider,
			model: event.model.id,
			thinkingLevel: pi.getThinkingLevel(),
		};
		await writeStore(store);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		const store = await readStore();
		const provider = ctx.model?.provider ?? store[ctx.cwd]?.provider;
		const model = ctx.model?.id ?? store[ctx.cwd]?.model;
		if (!provider || !model) return;

		store[ctx.cwd] = {
			provider,
			model,
			thinkingLevel: event.level,
		};
		await writeStore(store);
	});
}
