import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	DefaultResourceLoader,
	type ExtensionAPI,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	normalizeRelativePath,
	parseFrontmatter,
	pathExists,
} from "./shared.ts";

type CopilotFile = {
	path: string;
	relativePath: string;
	kind: "repository instructions" | "path instructions";
	applyTo?: string;
	excludeAgent?: string;
	content: string;
	truncated: boolean;
};

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 192 * 1024;
const RESOURCE_LOADER_PATCH = Symbol.for(
	"pi-copilot-bridge.resource-loader-patch",
);
const SUPPORTED_PI_VERSION_PREFIX = "0.80.";
const PATH_INSTRUCTIONS_HEADER = "GitHub Copilot path-specific instructions";

async function findInstructionFiles(dir: string): Promise<string[]> {
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
			files.push(...(await findInstructionFiles(entryPath)));
		else if (entry.isFile() && entry.name.endsWith(".instructions.md")) {
			files.push(entryPath);
		}
	}
	return files.sort();
}

function copilotFileFromContent(
	cwd: string,
	filePath: string,
	kind: CopilotFile["kind"],
	raw: string,
): CopilotFile {
	const truncated = Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES;
	const limited = truncated
		? raw.slice(0, MAX_FILE_BYTES) + "\n\n[Truncated by pi Copilot bridge.]"
		: raw;
	const { metadata, body } = parseFrontmatter(limited);

	return {
		path: filePath,
		relativePath: path.relative(cwd, filePath),
		kind,
		applyTo: metadata.applyTo,
		excludeAgent: metadata.excludeAgent,
		content: body.trim(),
		truncated,
	};
}

function readCopilotFileSync(
	cwd: string,
	filePath: string,
	kind: CopilotFile["kind"],
): CopilotFile {
	return copilotFileFromContent(
		cwd,
		filePath,
		kind,
		readFileSync(filePath, "utf8"),
	);
}

async function readCopilotFile(
	cwd: string,
	filePath: string,
	kind: CopilotFile["kind"],
): Promise<CopilotFile> {
	return copilotFileFromContent(
		cwd,
		filePath,
		kind,
		await readFile(filePath, "utf8"),
	);
}

async function discoverCopilotFiles(cwd: string): Promise<CopilotFile[]> {
	const githubDir = path.join(cwd, ".github");
	const files: CopilotFile[] = [];
	const rootInstructions = path.join(githubDir, "copilot-instructions.md");

	if (await pathExists(rootInstructions)) {
		files.push(
			await readCopilotFile(
				cwd,
				rootInstructions,
				"repository instructions",
			),
		);
	}

	for (const filePath of await findInstructionFiles(
		path.join(githubDir, "instructions"),
	)) {
		const file = await readCopilotFile(cwd, filePath, "path instructions");
		if (file.excludeAgent !== "cloud-agent") files.push(file);
	}

	return files;
}

function splitApplyToPatterns(applyTo: string | undefined): string[] {
	return (applyTo ?? "")
		.split(",")
		.map((pattern) => pattern.trim().replace(/^['"]|['"]$/g, ""))
		.filter(Boolean);
}

function escapeRegex(text: string): string {
	return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globSegmentToRegex(segment: string): string {
	let regex = "";
	for (const char of segment) {
		if (char === "*") regex += "[^/]*";
		else if (char === "?") regex += "[^/]";
		else regex += escapeRegex(char);
	}
	return regex;
}

function globToRegex(pattern: string): RegExp {
	const normalized = pattern.replace(/^\.\//, "").replaceAll(path.sep, "/");
	if (normalized === "**" || normalized === "**/*") return /^.*$/;

	const segments = normalized.split("/");
	let regex = "^";
	segments.forEach((segment, index) => {
		if (segment === "**") {
			regex += "(?:[^/]+/)*";
			return;
		}

		regex += globSegmentToRegex(segment);
		if (index < segments.length - 1) regex += "/";
	});
	return new RegExp(`${regex}$`);
}

function matchesApplyTo(
	file: CopilotFile,
	relativePaths: Set<string>,
): boolean {
	const patterns = splitApplyToPatterns(file.applyTo);
	if (patterns.length === 0) return false;

	const regexes = patterns.map(globToRegex);
	return [...relativePaths].some((relativePath) =>
		regexes.some((regex) => regex.test(relativePath)),
	);
}

function extractPromptPaths(cwd: string, prompt: string): string[] {
	const candidates = new Set<string>();
	const pathLike =
		/(?:`([^`]+)`)|(?:\b[\w.@-]+(?:\/[\w.@-]+)+(?:\.[\w-]+)?\b)|(?:\b[\w.@-]+\.[A-Za-z][\w-]*\b)/g;
	for (const match of prompt.matchAll(pathLike)) {
		const value = (match[1] ?? match[0]).trim();
		if (value.includes(" ")) continue;
		candidates.add(normalizeRelativePath(cwd, value));
	}
	return [...candidates];
}

function addToolPaths(
	cwd: string,
	toolName: string,
	input: unknown,
	paths: Set<string>,
) {
	if (!input || typeof input !== "object") return;
	const pathValue = (input as Record<string, unknown>).path;
	if (typeof pathValue !== "string") return;

	if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) {
		paths.add(normalizeRelativePath(cwd, pathValue));
	}
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderInstructionFile(file: CopilotFile): string {
	return [
		`GitHub Copilot ${file.kind}.`,
		file.applyTo ? `Applies to: ${file.applyTo}` : undefined,
		file.content,
	]
		.filter(Boolean)
		.join("\n\n");
}

function patchResourceLoaderContextFiles() {
	/*
	 * COMPATIBILITY PATCH: Pi's extension API cannot register context files.
	 * before_agent_start/context injection is insufficient because startup UI and
	 * context viewers read DefaultResourceLoader before the first prompt. Pi's SDK
	 * offers agentsFilesOverride only when constructing the loader, which an
	 * extension cannot control. Keep this patch in sync with Pi 0.80.x's
	 * DefaultResourceLoader#getAgentsFiles() contract and fail loudly if it changes.
	 */
	const prototype = DefaultResourceLoader.prototype as unknown as Record<
		PropertyKey,
		unknown
	>;
	if (prototype[RESOURCE_LOADER_PATCH]) return;

	if (!VERSION.startsWith(SUPPORTED_PI_VERSION_PREFIX)) {
		console.warn(
			`Copilot bridge resource-loader patch was written for Pi ${SUPPORTED_PI_VERSION_PREFIX}x; running ${VERSION}. Verifying compatibility at runtime.`,
		);
	}

	const original = prototype.getAgentsFiles;
	if (typeof original !== "function") {
		throw new Error(
			"Copilot bridge requires DefaultResourceLoader#getAgentsFiles(); Pi's resource-loader API is incompatible.",
		);
	}

	prototype.getAgentsFiles = function patchedGetAgentsFiles(this: {
		cwd?: string;
	}) {
		const result: unknown = original.call(this);
		if (
			!result ||
			typeof result !== "object" ||
			!Array.isArray((result as { agentsFiles?: unknown }).agentsFiles)
		) {
			throw new Error(
				"Copilot bridge expected DefaultResourceLoader#getAgentsFiles() to return { agentsFiles: [] }; Pi's resource-loader API is incompatible.",
			);
		}

		const typedResult = result as {
			agentsFiles: Array<{ path: string; content: string }>;
		};
		const cwd = this.cwd ?? process.cwd();
		const filePath = path.join(cwd, ".github", "copilot-instructions.md");
		if (!existsSync(filePath)) return typedResult;
		if (typedResult.agentsFiles.some((file) => file.path === filePath)) {
			return typedResult;
		}

		const file = readCopilotFileSync(
			cwd,
			filePath,
			"repository instructions",
		);
		return {
			agentsFiles: [
				...typedResult.agentsFiles,
				{ path: file.path, content: renderInstructionFile(file) },
			],
		};
	};
	prototype[RESOURCE_LOADER_PATCH] = true;
}

function renderInstructions(title: string, files: CopilotFile[]): string {
	let totalBytes = 0;
	const sections: string[] = [];

	for (const file of files) {
		const content = renderInstructionFile(file);
		const section = `<project_instructions path="${escapeXmlAttribute(file.relativePath)}">\n${content}\n</project_instructions>`;
		const sectionBytes = Buffer.byteLength(section, "utf8");

		if (totalBytes + sectionBytes > MAX_TOTAL_BYTES) {
			sections.push(
				"[Additional Copilot instruction files omitted by pi Copilot bridge due to size limits.]",
			);
			break;
		}

		sections.push(section);
		totalBytes += sectionBytes;
	}

	return `## ${title}\n\n${sections.join("\n\n")}`;
}

function createPathInstructionMessage(content: string): AgentMessage {
	return {
		role: "custom",
		customType: "copilot-bridge",
		content,
		display: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

export function registerInstructionBridge(pi: ExtensionAPI) {
	patchResourceLoaderContextFiles();
	let activePaths = new Set<string>();

	pi.registerCommand("copilot-bridge", {
		description:
			"Show GitHub Copilot bridge files discovered in this repository",
		async handler(_args, ctx) {
			const files = await discoverCopilotFiles(ctx.cwd);
			if (files.length === 0) {
				ctx.ui.notify("No Copilot instruction files found.", "info");
				return;
			}

			ctx.ui.notify(
				`Copilot bridge found ${files.length} instruction file${files.length === 1 ? "" : "s"}: ${files.map((file) => file.relativePath).join(", ")}`,
				"info",
			);
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		activePaths = new Set(extractPromptPaths(ctx.cwd, event.prompt));
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		addToolPaths(ctx.cwd, event.toolName, event.input, activePaths);
	});

	pi.on("context", async (event, ctx) => {
		if (activePaths.size === 0) return undefined;

		const files = await discoverCopilotFiles(ctx.cwd);
		const pathInstructions = files.filter(
			(file) =>
				file.kind === "path instructions" &&
				matchesApplyTo(file, activePaths),
		);
		if (pathInstructions.length === 0) return undefined;

		return {
			messages: [
				createPathInstructionMessage(
					renderInstructions(
						PATH_INSTRUCTIONS_HEADER,
						pathInstructions,
					),
				),
				...event.messages,
			],
		};
	});
}
