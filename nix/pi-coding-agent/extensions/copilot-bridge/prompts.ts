import { readdir, readFile, realpath, stat } from "node:fs/promises";
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

type PromptFile = {
	path: string;
	realPath: string;
};

function isWithinDirectory(directory: string, filePath: string): boolean {
	const relativePath = path.relative(directory, filePath);
	return (
		relativePath !== "" &&
		!relativePath.startsWith(`..${path.sep}`) &&
		relativePath !== ".." &&
		!path.isAbsolute(relativePath)
	);
}

async function findPromptFiles(
	dir: string,
	promptRoot: string,
): Promise<PromptFile[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: PromptFile[] = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await findPromptFiles(entryPath, promptRoot)));
		} else if (
			(entry.isFile() || entry.isSymbolicLink()) &&
			entry.name.endsWith(".prompt.md")
		) {
			try {
				const realPath = await realpath(entryPath);
				const target = await stat(realPath);
				if (
					target.isFile() &&
					isWithinDirectory(promptRoot, realPath)
				) {
					files.push({ path: entryPath, realPath });
				}
			} catch {
				// Ignore files that disappear or cannot be resolved during discovery.
			}
		}
	}
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function discoverPrompts(cwd: string): Promise<CopilotPrompt[]> {
	const promptDir = path.join(cwd, ".github", "prompts");
	let promptRoot: string;
	try {
		promptRoot = await realpath(promptDir);
	} catch {
		return [];
	}
	const files = await findPromptFiles(promptDir, promptRoot);

	return Promise.all(
		files.map(async ({ path: filePath, realPath }) => {
			const raw = await readFile(realPath, "utf8");
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
