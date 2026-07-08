import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	estimateTokens,
	formatSkillsForPrompt,
	type BeforeAgentStartEvent,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	BlockFrame,
	gruvbox,
	KeyHintLine,
	styleText,
} from "../components/ui/index.ts";

type PromptSnapshot = {
	at: number;
	prompt: string;
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	providerPayloadAt?: number;
	providerPayloadText?: string;
};

type ContextSnapshot = {
	at: number;
	source: "current session" | "last live request";
	messages: AgentMessage[];
	thinkingLevel?: string;
	model?: { provider: string; modelId: string } | null;
};

type Section = {
	title: string;
	lines: string[];
	list?: boolean;
};

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
	return structuredClone(messages) as AgentMessage[];
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function formatCount(value: number | null | undefined): string {
	if (value === null || value === undefined) return "?";
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatAge(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function oneLine(text: string, max = 180): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function jsonPreview(value: unknown, max = 180): string {
	try {
		return oneLine(JSON.stringify(value), max);
	} catch {
		return String(value);
	}
}

function jsonPrettyPreview(value: unknown, max = 50_000): string {
	try {
		return JSON.stringify(value, null, 2).slice(0, max);
	} catch {
		return String(value).slice(0, max);
	}
}

function sourcePath(path: string, cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	return path;
}

function contentBlocks(
	content: string | Array<TextContent | ImageContent | ToolCall>,
): string[] {
	if (typeof content === "string") {
		return [
			`text ${formatCount(estimateTextTokens(content))} tok · ${formatCount(content.length)} chars · ${oneLine(content)}`,
		];
	}

	return content.map((block) => {
		if (block.type === "text") {
			return `text ${formatCount(estimateTextTokens(block.text))} tok · ${formatCount(block.text.length)} chars · ${oneLine(block.text)}`;
		}
		if (block.type === "image") {
			return `image ${block.mimeType} · ${formatCount(block.data.length)} base64 chars`;
		}
		return `toolCall ${block.name} · ${block.id} · ${jsonPreview(block.arguments)}`;
	});
}

function messageTextLength(message: AgentMessage): number {
	const role = message.role;
	if (role === "user") {
		const content = (message as UserMessage).content;
		return typeof content === "string"
			? content.length
			: content.reduce(
					(total, block) =>
						total +
						(block.type === "text"
							? block.text.length
							: block.data.length),
					0,
				);
	}
	if (role === "assistant") {
		return (message as AssistantMessage).content.reduce((total, block) => {
			if (block.type === "text") return total + block.text.length;
			if (block.type === "thinking") return total + block.thinking.length;
			return total + JSON.stringify(block.arguments).length;
		}, 0);
	}
	if (role === "toolResult") {
		return (message as ToolResultMessage).content.reduce(
			(total, block) =>
				total +
				(block.type === "text" ? block.text.length : block.data.length),
			0,
		);
	}
	if (role === "bashExecution") {
		const bash = message as AgentMessage & {
			command: string;
			output: string;
		};
		return bash.command.length + bash.output.length;
	}
	if (role === "custom") {
		const custom = message as AgentMessage & {
			content: string | Array<TextContent | ImageContent>;
		};
		return typeof custom.content === "string"
			? custom.content.length
			: custom.content.reduce(
					(total, block) =>
						total +
						(block.type === "text"
							? block.text.length
							: block.data.length),
					0,
				);
	}
	if (role === "branchSummary") {
		return (message as AgentMessage & { summary: string }).summary.length;
	}
	if (role === "compactionSummary") {
		return (message as AgentMessage & { summary: string }).summary.length;
	}
	return 0;
}

function messageTitle(message: AgentMessage, index: number): string {
	const tokens = estimateTokens(message);
	const chars = messageTextLength(message);
	const base = `#${index + 1} ${message.role} · ~${formatCount(tokens)} tok · ${formatCount(chars)} chars`;
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		return `${base} · ${assistant.provider}/${assistant.responseModel ?? assistant.model} · ${assistant.stopReason}`;
	}
	if (message.role === "toolResult") {
		const result = message as ToolResultMessage;
		return `${base} · ${result.toolName} · ${result.isError ? "error" : "ok"}`;
	}
	if (message.role === "custom") {
		const custom = message as AgentMessage & {
			customType: string;
			display: boolean;
		};
		return `${base} · ${custom.customType} · ${custom.display ? "visible" : "hidden"}`;
	}
	if (message.role === "bashExecution") {
		const bash = message as AgentMessage & {
			exitCode: number | undefined;
			excludeFromContext?: boolean;
		};
		return `${base} · exit ${bash.exitCode ?? "?"}${bash.excludeFromContext ? " · excluded" : ""}`;
	}
	return base;
}

function messageDetails(message: AgentMessage): string[] {
	if (message.role === "user")
		return contentBlocks((message as UserMessage).content);
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		return assistant.content.map((block) => {
			if (block.type === "text") {
				return `text ${formatCount(estimateTextTokens(block.text))} tok · ${oneLine(block.text)}`;
			}
			if (block.type === "thinking") {
				return `thinking ${formatCount(estimateTextTokens(block.thinking))} tok · ${block.redacted ? "redacted" : oneLine(block.thinking)}`;
			}
			return `toolCall ${block.name} · ${block.id} · ${jsonPreview(block.arguments)}`;
		});
	}
	if (message.role === "toolResult") {
		const result = message as ToolResultMessage;
		return [
			`call ${result.toolCallId}`,
			...result.content.map((block) =>
				block.type === "text"
					? `text ${formatCount(estimateTextTokens(block.text))} tok · ${oneLine(block.text)}`
					: `image ${block.mimeType} · ${formatCount(block.data.length)} base64 chars`,
			),
			result.details === undefined
				? undefined
				: `details ${jsonPreview(result.details)}`,
		].filter((line): line is string => Boolean(line));
	}
	if (message.role === "bashExecution") {
		const bash = message as AgentMessage & {
			command: string;
			output: string;
			truncated: boolean;
			fullOutputPath?: string;
		};
		return [
			`command ${oneLine(bash.command)}`,
			`output ${formatCount(estimateTextTokens(bash.output))} tok · ${formatCount(bash.output.length)} chars${bash.truncated ? " · truncated" : ""}`,
			bash.fullOutputPath
				? `full output ${bash.fullOutputPath}`
				: undefined,
		].filter((line): line is string => Boolean(line));
	}
	if (message.role === "custom") {
		const custom = message as AgentMessage & {
			content: string | Array<TextContent | ImageContent>;
			details?: unknown;
		};
		return [
			...contentBlocks(custom.content),
			custom.details === undefined
				? undefined
				: `details ${jsonPreview(custom.details)}`,
		].filter((line): line is string => Boolean(line));
	}
	if (message.role === "branchSummary") {
		return [
			`summary ${oneLine((message as AgentMessage & { summary: string }).summary)}`,
		];
	}
	if (message.role === "compactionSummary") {
		const compaction = message as AgentMessage & {
			summary: string;
			tokensBefore: number;
		};
		return [
			`summarized ${formatCount(compaction.tokensBefore)} tokens before this point`,
			`summary ${oneLine(compaction.summary)}`,
		];
	}
	return [];
}

function roleCounts(messages: AgentMessage[]): string {
	const counts = new Map<string, number>();
	for (const message of messages) {
		counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([role, count]) => `${role} ${count}`)
		.join(" · ");
}

function tokenSum(messages: AgentMessage[]): number {
	return messages.reduce(
		(total, message) => total + estimateTokens(message),
		0,
	);
}

function latestCompaction(entries: SessionEntry[]): SessionEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction") return entry;
	}
}

function buildCurrentSnapshot(ctx: ExtensionCommandContext): ContextSnapshot {
	const sessionContext = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	return {
		at: Date.now(),
		source: "current session",
		messages: sessionContext.messages,
		thinkingLevel: sessionContext.thinkingLevel,
		model: sessionContext.model,
	};
}

type ContextSlice = {
	label: string;
	tokens: number;
	color: string;
	detail?: string;
};

type ViewerTab = {
	title: string;
	badge?: string;
	sections: Section[];
};

type ContextFileInfo = {
	path: string;
	content: string;
};

type SkillInfo = {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation: boolean;
	baseDir?: string;
};

function activeToolInfos(pi: ExtensionAPI) {
	const activeTools = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => activeTools.has(tool.name))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function promptText(lastPrompt: PromptSnapshot | undefined): string {
	return lastPrompt?.systemPrompt ?? "";
}

function xmlDecode(value: string): string {
	return value
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

function parseContextFilesFromPrompt(prompt: string): ContextFileInfo[] {
	const xmlFiles = Array.from(
		prompt.matchAll(
			/<project_instructions\s+path=(?:"([^"]+)"|'([^']+)')[^>]*>\s*([\s\S]*?)\s*<\/project_instructions>/g,
		),
	).map((match) => ({
		path: xmlDecode((match[1] ?? match[2] ?? "").trim()),
		content: match[3].trimEnd(),
	}));
	if (xmlFiles.length > 0) return xmlFiles;

	const markerIndex = prompt.indexOf("# Project Context");
	if (markerIndex < 0) return [];
	const sectionStart = prompt.indexOf("\n## ", markerIndex);
	if (sectionStart < 0) return [];
	const sectionEndCandidates = [
		"\n\nThe following skills provide specialized instructions",
		"\nCurrent date:",
	]
		.map((candidate) => prompt.indexOf(candidate, sectionStart + 1))
		.filter((index) => index >= 0);
	const sectionEnd =
		sectionEndCandidates.length > 0
			? Math.min(...sectionEndCandidates)
			: prompt.length;
	const section = prompt.slice(sectionStart, sectionEnd);
	const matches = Array.from(section.matchAll(/(?:^|\n)## ([^\n]+)\n\n/g));
	return matches.map((match, index) => {
		const contentStart = (match.index ?? 0) + match[0].length;
		const next = matches[index + 1];
		const contentEnd = next?.index ?? section.length;
		return {
			path: match[1].trim(),
			content: section.slice(contentStart, contentEnd).trimEnd(),
		};
	});
}

function contextFiles(
	lastPrompt: PromptSnapshot | undefined,
	messages: AgentMessage[] = [],
): ContextFileInfo[] {
	const merged = new Map<string, ContextFileInfo>();
	for (const file of lastPrompt?.options.contextFiles ?? []) {
		merged.set(file.path, file);
	}
	for (const file of parseContextFilesFromPrompt(promptText(lastPrompt))) {
		merged.set(file.path, file);
	}
	for (const message of messages) {
		if (message.role !== "custom") continue;
		const custom = message as AgentMessage & { content?: unknown };
		if (typeof custom.content !== "string") continue;
		for (const file of parseContextFilesFromPrompt(custom.content)) {
			merged.set(file.path, file);
		}
	}
	return Array.from(merged.values());
}

function parseSkillsFromPrompt(prompt: string): SkillInfo[] {
	return Array.from(
		prompt.matchAll(
			/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g,
		),
	).map((match) => ({
		name: xmlDecode(match[1].trim()),
		description: xmlDecode(match[2].trim()),
		filePath: xmlDecode(match[3].trim()),
		disableModelInvocation: false,
	}));
}

function promptSkills(lastPrompt: PromptSnapshot | undefined): SkillInfo[] {
	const skills = lastPrompt?.options.skills;
	return skills?.length
		? skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
				baseDir: skill.baseDir,
				disableModelInvocation: skill.disableModelInvocation,
			}))
		: parseSkillsFromPrompt(promptText(lastPrompt));
}

function contextFileTokens(
	lastPrompt: PromptSnapshot | undefined,
	messages: AgentMessage[] = [],
): number {
	return contextFiles(lastPrompt, messages).reduce(
		(total, file) => total + estimateTextTokens(file.content),
		0,
	);
}

function skillPromptTokens(lastPrompt: PromptSnapshot | undefined): number {
	if (lastPrompt?.options.skills?.length) {
		return estimateTextTokens(
			formatSkillsForPrompt(lastPrompt.options.skills),
		);
	}
	const skills = promptSkills(lastPrompt);
	return estimateTextTokens(
		skills
			.map(
				(skill) =>
					`${skill.name}\n${skill.description}\n${skill.filePath}`,
			)
			.join("\n"),
	);
}

function toolPromptTokens(
	pi: ExtensionAPI,
	lastPrompt: PromptSnapshot | undefined,
): number {
	const snippets = lastPrompt?.options.toolSnippets ?? {};
	return activeToolInfos(pi).reduce((total, tool) => {
		const text = snippets[tool.name] ?? tool.description;
		return total + estimateTextTokens(`${tool.name}: ${text}`);
	}, 0);
}

function toolSchemaTokens(pi: ExtensionAPI): number {
	return activeToolInfos(pi).reduce(
		(total, tool) =>
			total + estimateTextTokens(jsonPreview(tool.parameters, 50_000)),
		0,
	);
}

function promptExtrasTokens(lastPrompt: PromptSnapshot | undefined): number {
	const options = lastPrompt?.options;
	return estimateTextTokens(
		[options?.appendSystemPrompt, ...(options?.promptGuidelines ?? [])]
			.filter((text): text is string => Boolean(text))
			.join("\n"),
	);
}

function contextSlices(
	pi: ExtensionAPI,
	snapshot: ContextSnapshot,
	lastPrompt: PromptSnapshot | undefined,
): ContextSlice[] {
	const prompt = lastPrompt?.systemPrompt;
	const promptTokens = prompt ? estimateTextTokens(prompt) : 0;
	const fileInfos = contextFiles(lastPrompt, snapshot.messages);
	const skillInfos = promptSkills(lastPrompt);
	const files = contextFileTokens(lastPrompt, snapshot.messages);
	const skills = skillPromptTokens(lastPrompt);
	const toolPrompt = toolPromptTokens(pi, lastPrompt);
	const extras = promptExtrasTokens(lastPrompt);
	const schemas = toolSchemaTokens(pi);
	const messages = tokenSum(snapshot.messages);
	const knownPromptPieces = files + skills + toolPrompt + extras;
	const basePrompt = Math.max(0, promptTokens - knownPromptPieces);

	return [
		{
			label: "conversation messages",
			tokens: messages,
			color: gruvbox.green,
			detail: `${snapshot.messages.length} agent message(s)`,
		},
		{
			label: "AGENTS.md / context files",
			tokens: files,
			color: gruvbox.aqua,
			detail: `${fileInfos.length} file(s)`,
		},
		{
			label: "skills in prompt",
			tokens: skills,
			color: gruvbox.purple,
			detail: `${skillInfos.length} skill(s)`,
		},
		{
			label: "tool prompt entries",
			tokens: toolPrompt,
			color: gruvbox.orange,
			detail: `${activeToolInfos(pi).length} active tool(s)`,
		},
		{
			label: "tool schemas",
			tokens: schemas,
			color: gruvbox.yellow,
			detail: "provider tool definition estimate",
		},
		{
			label: "extra guidelines / appended prompt",
			tokens: extras,
			color: gruvbox.blue,
		},
		{
			label: lastPrompt?.options.customPrompt
				? "custom/base system prompt"
				: "Pi base system prompt",
			tokens: basePrompt,
			color: gruvbox.gray,
		},
	].filter((slice) => slice.tokens > 0);
}

function renderTokenBar(
	slices: ContextSlice[],
	denominator: number,
	width: number,
	theme: any,
): string {
	const barWidth = Math.max(8, Math.min(72, width));
	if (denominator <= 0) {
		return styleText("·".repeat(barWidth), { fg: gruvbox.bg3, theme });
	}

	let remaining = barWidth;
	const parts: string[] = [];
	for (const slice of slices) {
		const rawWidth = (slice.tokens / denominator) * barWidth;
		const segmentWidth = Math.min(
			remaining,
			Math.max(slice.tokens > 0 ? 1 : 0, Math.round(rawWidth)),
		);
		if (segmentWidth <= 0 || remaining <= 0) continue;
		const actualWidth = Math.min(segmentWidth, remaining);
		parts.push(
			styleText("█".repeat(actualWidth), {
				fg: slice.color,
				theme,
			}),
		);
		remaining -= actualWidth;
	}
	if (remaining > 0) {
		parts.push(
			styleText("░".repeat(remaining), { fg: gruvbox.bg3, theme }),
		);
	}
	return parts.join("");
}

function visualBreakdownSection(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	snapshot: ContextSnapshot,
	lastPrompt: PromptSnapshot | undefined,
): Section {
	const usage = ctx.getContextUsage();
	const slices = contextSlices(pi, snapshot, lastPrompt);
	const estimatedUsed = slices.reduce(
		(total, slice) => total + slice.tokens,
		0,
	);
	const denominator = usage?.contextWindow ?? Math.max(1, estimatedUsed);
	return {
		title: "Context window by category",
		lines: [
			renderTokenBar(slices, denominator, 72, ctx.ui.theme),
			...slices.map((slice) => {
				const windowPct = denominator
					? ((slice.tokens / denominator) * 100).toFixed(1)
					: "?";
				return `${styleText("●", { fg: slice.color, theme: ctx.ui.theme })} ${slice.label}: ~${formatCount(slice.tokens)} tok · ${windowPct}% window${slice.detail ? ` · ${slice.detail}` : ""}`;
			}),
		],
	};
}

function overviewSections(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	snapshot: ContextSnapshot,
	lastPrompt: PromptSnapshot | undefined,
): Section[] {
	const usage = ctx.getContextUsage();
	const entries = ctx.sessionManager.getEntries();
	const branch = ctx.sessionManager.getBranch();
	const llmMessages = convertToLlm(snapshot.messages);
	const compaction = latestCompaction(branch);
	const sessionFile = ctx.sessionManager.getSessionFile();
	const model = snapshot.model
		? `${snapshot.model.provider}/${snapshot.model.modelId}`
		: ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "none";

	return [
		{
			title: "Summary",
			lines: [
				`source ${snapshot.source} · captured ${formatAge(snapshot.at)}`,
				`model ${model} · thinking ${snapshot.thinkingLevel ?? "?"}`,
				usage
					? `context ${formatCount(usage.tokens)} / ${formatCount(usage.contextWindow)} tokens${usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`}`
					: "context usage unavailable",
				`agent messages ${snapshot.messages.length} (${roleCounts(snapshot.messages) || "none"})`,
				`LLM messages after conversion ${llmMessages.length} · approx message tokens ${formatCount(tokenSum(snapshot.messages))}`,
				`session entries ${entries.length} · branch entries ${branch.length} · leaf ${ctx.sessionManager.getLeafId() ?? "root"}`,
				sessionFile ? `session ${sessionFile}` : "session in memory",
				compaction && compaction.type === "compaction"
					? `latest compaction ${compaction.id} · summarized ${formatCount(compaction.tokensBefore)} tokens · kept from ${compaction.firstKeptEntryId}`
					: "no compaction on current branch",
			],
		},
		visualBreakdownSection(ctx, pi, snapshot, lastPrompt),
	];
}

function messageSections(snapshot: ContextSnapshot): Section[] {
	return [
		{
			title: "Messages in agent context",
			lines:
				snapshot.messages.length === 0
					? ["No messages are currently in context."]
					: snapshot.messages.flatMap((message, index) => [
							messageTitle(message, index),
							...messageDetails(message).map(
								(line) => `  ${line}`,
							),
						]),
		},
	];
}

function contentPreviewLines(content: string, maxLines = 12): string[] {
	const lines = content
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n");
	const visible = lines.slice(0, maxLines).map((line) => `  ${line}`);
	if (lines.length > maxLines) {
		visible.push(`  … ${lines.length - maxLines} more line(s)`);
	}
	return visible;
}

function fileSections(
	ctx: ExtensionCommandContext,
	lastPrompt: PromptSnapshot | undefined,
	messages: AgentMessage[] = [],
): Section[] {
	const files = contextFiles(lastPrompt, messages);
	const agentsFiles = files.filter((file) =>
		/(^|\/)AGENTS\.md$/.test(file.path),
	);
	return [
		{
			title: "AGENTS.md and loaded context files",
			lines: [
				lastPrompt
					? `${files.length} context file(s), including ${agentsFiles.length} AGENTS.md file(s)`
					: "Structured context file details have not been captured yet. Send one prompt, then reopen /context.",
				...files.flatMap((file, index) => [
					`${index + 1}. ${sourcePath(file.path, ctx.cwd)}${/(^|\/)AGENTS\.md$/.test(file.path) ? " · AGENTS.md" : ""} · ~${formatCount(estimateTextTokens(file.content))} tok · ${formatCount(file.content.length)} chars`,
					...contentPreviewLines(file.content),
				]),
			],
		},
	];
}

function skillSections(
	ctx: ExtensionCommandContext,
	lastPrompt: PromptSnapshot | undefined,
): Section[] {
	const skills = promptSkills(lastPrompt);
	return [
		{
			title: "Skills in system prompt",
			lines: [
				lastPrompt
					? `${skills.length} skill(s) advertised to the model · ~${formatCount(skillPromptTokens(lastPrompt))} tok`
					: "Structured skill details have not been captured yet. Send one prompt, then reopen /context.",
				...skills.map((skill) => {
					const baseDir = skill.baseDir ?? ctx.cwd;
					return `${skill.name}${skill.disableModelInvocation ? " · command-only" : ""} — ${skill.description} · ${sourcePath(skill.filePath, baseDir)}`;
				}),
			],
		},
	];
}

function toolSections(
	pi: ExtensionAPI,
	lastPrompt: PromptSnapshot | undefined,
): Section[] {
	const activeTools = activeToolInfos(pi);
	const snippets = lastPrompt?.options.toolSnippets ?? {};
	return [
		{
			title: "Active tools and provider schemas",
			lines: [
				`${activeTools.length} active tool(s) · ~${formatCount(toolPromptTokens(pi, lastPrompt))} prompt tok · ~${formatCount(toolSchemaTokens(pi))} schema tok`,
				...activeTools.flatMap((tool) => [
					`${tool.name} — ${tool.description}`,
					`  prompt snippet: ${snippets[tool.name] ?? tool.description}`,
					`  schema estimate: ~${formatCount(estimateTextTokens(jsonPreview(tool.parameters, 50_000)))} tok`,
				]),
			],
		},
	];
}

function promptSections(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	lastPrompt: PromptSnapshot | undefined,
	snapshot: ContextSnapshot,
): Section[] {
	const prompt = lastPrompt?.systemPrompt ?? ctx.getSystemPrompt();
	const options = lastPrompt?.options;
	const files = contextFiles(lastPrompt, snapshot.messages);
	const skills = promptSkills(lastPrompt);
	const sections: Section[] = [
		{
			title: "System prompt components",
			lines: [
				`${formatCount(estimateTextTokens(prompt))} estimated tokens · ${formatCount(prompt.length)} chars`,
				lastPrompt
					? `captured ${formatAge(lastPrompt.at)} for prompt: ${oneLine(lastPrompt.prompt, 120)}`
					: "structured prompt details have not been captured in this session yet",
				options?.customPrompt
					? `custom prompt ${formatCount(estimateTextTokens(options.customPrompt))} tok`
					: "default Pi prompt",
				`${files.length} context file(s) · ~${formatCount(contextFileTokens(lastPrompt, snapshot.messages))} tok`,
				`${skills.length} skill(s) · ~${formatCount(skillPromptTokens(lastPrompt))} tok`,
				`${activeToolInfos(pi).length} active tool prompt entries · ~${formatCount(toolPromptTokens(pi, lastPrompt))} tok`,
				options?.appendSystemPrompt
					? `appendSystemPrompt ~${formatCount(estimateTextTokens(options.appendSystemPrompt))} tok`
					: undefined,
				options?.promptGuidelines?.length
					? `${options.promptGuidelines.length} extra guideline(s)`
					: undefined,
			].filter((line): line is string => Boolean(line)),
		},
		{
			title: "Raw system prompt",
			lines: prompt.split("\n"),
			list: false,
		},
	];

	if (lastPrompt?.providerPayloadText) {
		sections.push({
			title: `Final provider payload captured ${formatAge(lastPrompt.providerPayloadAt)}`,
			lines: lastPrompt.providerPayloadText.split("\n"),
			list: false,
		});
	}

	return sections;
}

function buildTabs(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	snapshot: ContextSnapshot,
	lastPrompt: PromptSnapshot | undefined,
): ViewerTab[] {
	return [
		{
			title: "Overview",
			badge: "usage",
			sections: overviewSections(ctx, pi, snapshot, lastPrompt),
		},
		{
			title: "Messages",
			badge: String(snapshot.messages.length),
			sections: messageSections(snapshot),
		},
		{
			title: "Files",
			badge: String(contextFiles(lastPrompt, snapshot.messages).length),
			sections: fileSections(ctx, lastPrompt, snapshot.messages),
		},
		{
			title: "Skills",
			badge: String(promptSkills(lastPrompt).length),
			sections: skillSections(ctx, lastPrompt),
		},
		{
			title: "Tools",
			badge: String(activeToolInfos(pi).length),
			sections: toolSections(pi, lastPrompt),
		},
		{
			title: "Prompt",
			badge: `${formatCount(estimateTextTokens(lastPrompt?.systemPrompt ?? ctx.getSystemPrompt()))} tok`,
			sections: promptSections(ctx, pi, lastPrompt, snapshot),
		},
	];
}

function renderSections(
	sections: Section[],
	width: number,
	theme: any,
): string[] {
	const lines: string[] = [];
	for (const section of sections) {
		if (lines.length > 0) lines.push("");
		lines.push(
			styleText(section.title, {
				fg: gruvbox.yellow,
				theme,
			}),
		);
		for (const rawLine of section.lines) {
			const asList = section.list ?? true;
			const bullet = asList
				? styleText("• ", { fg: gruvbox.bg3, theme })
				: "";
			const indent = asList ? "  " : "";
			const wrapped = wrapTextWithAnsi(
				rawLine,
				Math.max(10, width - (asList ? 2 : 0)),
			);
			if (wrapped.length === 0) {
				lines.push(bullet);
				continue;
			}
			lines.push(`${bullet}${wrapped[0]}`);
			for (const continuation of wrapped.slice(1)) {
				lines.push(`${indent}${continuation}`);
			}
		}
	}
	return lines.map((line) => truncateToWidth(line, width, ""));
}

function renderTabBar(
	tabs: ViewerTab[],
	activeIndex: number,
	width: number,
	theme: any,
): string[] {
	const labels = tabs.map((tab, index) => {
		const label = `${index + 1}:${tab.title}${tab.badge ? ` ${tab.badge}` : ""}`;
		return index === activeIndex
			? styleText(` ${label} `, {
					fg: gruvbox.bg,
					bg: gruvbox.aqua,
					theme,
				})
			: styleText(` ${label} `, {
					fg: gruvbox.fg0,
					bg: gruvbox.bg2,
					theme,
				});
	});
	return wrapTextWithAnsi(labels.join(" "), width).map((line) =>
		truncateToWidth(line, width, ""),
	);
}

const VIEW_BODY_HEIGHT = 26;

class ContextViewer implements Component {
	private activeIndex = 0;
	private scrollByTab: number[];
	private lastBodyHeight = VIEW_BODY_HEIGHT;
	private lastBodyLines = 0;

	constructor(
		private readonly tabs: ViewerTab[],
		private readonly options: {
			title: string;
			badges: string[];
			theme: any;
			onClose: () => void;
			onRenderNeeded: () => void;
		},
	) {
		this.scrollByTab = tabs.map(() => 0);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.options.onClose();
			return;
		}
		if (
			matchesKey(data, Key.right) ||
			matchesKey(data, Key.tab) ||
			data === "l"
		) {
			this.switchTab(1);
			return;
		}
		if (
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.shift(Key.tab)) ||
			data === "h"
		) {
			this.switchTab(-1);
			return;
		}
		const numeric = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
		if (numeric >= 0 && numeric < this.tabs.length) {
			this.activeIndex = numeric;
			this.options.onRenderNeeded();
			return;
		}

		const page = Math.max(1, VIEW_BODY_HEIGHT - 3);
		let scroll = this.currentScroll();
		if (matchesKey(data, Key.up) || data === "k") scroll -= 1;
		else if (matchesKey(data, Key.down) || data === "j") scroll += 1;
		else if (
			matchesKey(data, Key.pageUp) ||
			matchesKey(data, Key.ctrl("u"))
		)
			scroll -= page;
		else if (
			matchesKey(data, Key.pageDown) ||
			matchesKey(data, Key.ctrl("d")) ||
			data === " "
		)
			scroll += page;
		else if (matchesKey(data, Key.home)) scroll = 0;
		else if (matchesKey(data, Key.end)) scroll = Number.MAX_SAFE_INTEGER;
		else return;
		this.setCurrentScroll(scroll);
		this.clampScroll();
		this.options.onRenderNeeded();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.options.theme;
		const frame = new BlockFrame(
			{
				invalidate() {},
				render: (contentWidth: number) => {
					const help = new KeyHintLine(
						[
							{ key: "←→/tab", label: "tabs" },
							{ key: `1-${this.tabs.length}`, label: "jump" },
							{ key: "↑↓/jk", label: "scroll" },
							{ key: "ctrl+u/d", label: "page" },
							{ key: "q/esc", label: "close" },
						],
						{ theme, accent: gruvbox.aqua },
					).render(contentWidth);
					const tabBar = renderTabBar(
						this.tabs,
						this.activeIndex,
						contentWidth,
						theme,
					);
					const active = this.tabs[this.activeIndex] ?? this.tabs[0];
					const body = renderSections(
						active.sections,
						contentWidth,
						theme,
					);
					this.lastBodyHeight = VIEW_BODY_HEIGHT;
					this.lastBodyLines = body.length;
					this.clampScroll();
					const scroll = this.currentScroll();
					const visible = body.slice(
						scroll,
						scroll + this.lastBodyHeight,
					);
					while (visible.length < this.lastBodyHeight)
						visible.push("");
					const scrollInfo =
						this.lastBodyLines > this.lastBodyHeight
							? `${scroll + 1}-${Math.min(scroll + this.lastBodyHeight, this.lastBodyLines)} / ${this.lastBodyLines}`
							: `${this.lastBodyLines} lines`;
					return [
						...help,
						"",
						...tabBar,
						truncateToWidth(
							styleText(scrollInfo, { fg: gruvbox.gray, theme }),
							contentWidth,
						),
						"",
						...visible,
					];
				},
			},
			{
				title: {
					title: this.options.title,
					icon: "󰮍",
					accent: gruvbox.aqua,
					badges: this.options.badges.map((text) => ({ text })),
					theme,
				},
				borderColor: gruvbox.aqua,
				background: gruvbox.bg1,
				theme,
				paddingX: 1,
				paddingY: 1,
			},
		);
		return frame.render(width);
	}

	private switchTab(delta: number): void {
		this.activeIndex =
			(this.activeIndex + delta + this.tabs.length) % this.tabs.length;
		this.options.onRenderNeeded();
	}

	private currentScroll(): number {
		return this.scrollByTab[this.activeIndex] ?? 0;
	}

	private setCurrentScroll(value: number): void {
		this.scrollByTab[this.activeIndex] = value;
	}

	private clampScroll(): void {
		const maxScroll = Math.max(0, this.lastBodyLines - this.lastBodyHeight);
		this.setCurrentScroll(
			Math.max(0, Math.min(this.currentScroll(), maxScroll)),
		);
	}
}

async function showContextViewer(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	lastPrompt: PromptSnapshot | undefined,
	lastContext: ContextSnapshot | undefined,
): Promise<void> {
	const useLast = /\b(last|live)\b/i.test(args);
	const snapshot =
		useLast && lastContext ? lastContext : buildCurrentSnapshot(ctx);
	const promptSnapshot =
		lastPrompt ??
		({
			at: Date.now(),
			prompt: "current system prompt",
			systemPrompt: ctx.getSystemPrompt(),
			options: ctx.getSystemPromptOptions?.() ?? { cwd: ctx.cwd },
		} satisfies PromptSnapshot);
	const tabs = buildTabs(ctx, pi, snapshot, promptSnapshot);
	const tokenBadge = ctx.getContextUsage()?.tokens;
	const messageBadge = `${snapshot.messages.length} messages`;
	const badges = [
		messageBadge,
		tokenBadge === undefined || tokenBadge === null
			? "tokens ?"
			: `${formatCount(tokenBadge)} ctx tok`,
		snapshot.source === "last live request" ? "last live" : "current",
	];

	if (useLast && !lastContext) {
		ctx.ui.notify(
			"No live context has been captured yet; showing current session context.",
			"warning",
		);
	}

	await ctx.ui.custom<void>(
		(tui, theme, kb, done) => {
			const viewer = new ContextViewer(tabs, {
				title: "Context Viewer",
				badges,
				theme,
				onClose: done,
				onRenderNeeded: () => tui.requestRender(),
			});
			return {
				render(width: number) {
					return viewer.render(width);
				},
				invalidate() {
					viewer.invalidate();
				},
				handleInput(data: string) {
					if (kb.matches(data, "tui.select.cancel")) {
						done();
						return;
					}
					viewer.handleInput(data);
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "90%",
				minWidth: 70,
				maxHeight: "90%",
				anchor: "center",
			},
		},
	);
}

export default function contextViewerExtension(pi: ExtensionAPI) {
	let lastPrompt: PromptSnapshot | undefined;
	let lastContext: ContextSnapshot | undefined;

	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		lastPrompt = {
			at: Date.now(),
			prompt: event.prompt,
			systemPrompt: event.systemPrompt,
			options: event.systemPromptOptions,
		};
	});

	pi.on("context", (event, ctx) => {
		lastContext = {
			at: Date.now(),
			source: "last live request",
			messages: cloneMessages(event.messages),
			thinkingLevel: pi.getThinkingLevel(),
			model: ctx.model
				? { provider: ctx.model.provider, modelId: ctx.model.id }
				: null,
		};
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!lastPrompt) return undefined;

		lastPrompt = {
			...lastPrompt,
			systemPrompt: ctx.getSystemPrompt(),
			providerPayloadAt: Date.now(),
			providerPayloadText: jsonPrettyPreview(event.payload),
		};
		return undefined;
	});

	const command = {
		description:
			"Inspect current Pi context, prompt inputs, tools, and message token estimates",
		getArgumentCompletions: (prefix: string) => {
			const options = ["current", "last live"];
			const matches = options.filter((option) =>
				option.startsWith(prefix),
			);
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await showContextViewer(pi, ctx, args, lastPrompt, lastContext);
		},
	};

	pi.registerCommand("context", command);
}
