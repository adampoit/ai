import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "./shared.ts";

type CopilotPrompt = {
	name: string;
	path: string;
	relativePath: string;
	description?: string;
	content: string;
};

async function findPromptFiles(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory())
			files.push(...(await findPromptFiles(entryPath)));
		else if (entry.isFile() && entry.name.endsWith(".prompt.md")) {
			files.push(entryPath);
		}
	}
	return files.sort();
}

async function discoverPrompts(cwd: string): Promise<CopilotPrompt[]> {
	const promptDir = path.join(cwd, ".github", "prompts");
	const files = await findPromptFiles(promptDir);

	return Promise.all(
		files.map(async (filePath) => {
			const raw = await readFile(filePath, "utf8");
			const { metadata, body } = parseFrontmatter(raw);
			const relativePath = path.relative(cwd, filePath);
			const name = path
				.relative(promptDir, filePath)
				.replace(/\.prompt\.md$/, "")
				.replaceAll(path.sep, "/");

			return {
				name,
				path: filePath,
				relativePath,
				description: metadata.description,
				content: body.trim(),
			};
		}),
	);
}

function promptSummary(prompt: CopilotPrompt): string {
	return prompt.description
		? `${prompt.name} — ${prompt.description}`
		: prompt.name;
}

export function registerPromptBridge(pi: ExtensionAPI) {
	pi.registerCommand("copilot-prompts", {
		description:
			"List GitHub Copilot prompt files available in this repository",
		async handler(_args, ctx) {
			const prompts = await discoverPrompts(ctx.cwd);
			if (prompts.length === 0) {
				ctx.ui.notify("No Copilot prompt files found.", "info");
				return;
			}

			ctx.ui.notify(
				`Copilot prompts: ${prompts.map(promptSummary).join(", ")}`,
				"info",
			);
		},
	});

	pi.registerCommand("copilot-prompt", {
		description: "Load a GitHub Copilot prompt file into the editor",
		async handler(args, ctx) {
			const promptName = args.trim();
			const prompts = await discoverPrompts(ctx.cwd);
			const prompt = prompts.find(
				(candidate) => candidate.name === promptName,
			);

			if (!promptName) {
				ctx.ui.notify(
					prompts.length === 0
						? "No Copilot prompt files found."
						: `Usage: /copilot-prompt <name>. Available: ${prompts.map((item) => item.name).join(", ")}`,
					"info",
				);
				return;
			}

			if (!prompt) {
				ctx.ui.notify(
					`Copilot prompt not found: ${promptName}`,
					"error",
				);
				return;
			}

			ctx.ui.setEditorText(prompt.content);
			ctx.ui.notify(
				`Loaded ${prompt.relativePath} into the editor.`,
				"info",
			);
		},
	});
}
