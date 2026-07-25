import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Command = {
	description?: string;
	getArgumentCompletions?: (
		prefix: string,
	) => Array<{ value: string; label?: string }> | null;
	handler?: (args: string, ctx: TestExtensionContext) => unknown;
};

export type Shortcut = {
	description?: string;
	handler?: (ctx: TestExtensionContext) => unknown;
};

export type RegisteredTool = {
	name: string;
	description?: string;
	execute?: (...args: any[]) => unknown;
	renderShell?: unknown;
	renderCall?: (...args: any[]) => unknown;
	renderResult?: (...args: any[]) => unknown;
};

export type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

export type ExecCall = {
	command: string;
	args: string[];
	options?: unknown;
};

export type ExecHandler = (
	command: string,
	args: string[],
	options: unknown,
) => ExecResult | Promise<ExecResult>;

export type Notification = {
	message: string;
	level?: string;
};

export type TestExtensionContext = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	model?: { provider: string; id: string };
	modelRegistry: {
		find: (provider: string, model: string) => unknown;
		getAll: () => Array<{ provider: string }>;
		getApiKeyForProvider: (provider: string) => Promise<string | undefined>;
		authStorage: {
			list: () => string[];
			get: (key: string) => unknown;
		};
	};
	sessionManager: {
		getEntries: () => unknown[];
		getBranch: () => unknown[];
		getLeafId: () => string;
		getSessionFile: () => string;
		getEntry: (id: string) => unknown;
	};
	getContextUsage: () => {
		tokens?: number;
		percent: number;
		contextWindow: number;
	};
	getSystemPrompt: () => string;
	getSystemPromptOptions: () => unknown;
	navigateTree: (
		entryId: string,
		options: unknown,
	) => Promise<{ cancelled: boolean }>;
	isProjectTrusted: () => boolean;
	ui: {
		theme: { fg: (_token: string, text: string) => string };
		setStatus: (key: string, value?: string) => void;
		setWidget: (key: string, widget?: unknown, options?: unknown) => void;
		setFooter: (footer: unknown) => void;
		notify: (message: string, level?: string) => void;
		custom: <T>(factory: unknown, options?: unknown) => Promise<T>;
		confirm: () => Promise<boolean>;
		input: () => Promise<string | undefined>;
		getEditorText: () => string;
		setEditorText: (text: string) => void;
	};
	statuses: Array<[string, string | undefined]>;
	widgets: Array<[string, unknown | undefined, unknown | undefined]>;
	footers: unknown[];
	notifications: Notification[];
	editorText: string | undefined;
};

export class FakePi {
	constructor(private readonly execHandler?: ExecHandler) {}

	readonly tools = new Map<string, RegisteredTool>();
	readonly commands = new Map<string, Command>();
	readonly shortcuts = new Map<string, Shortcut>();
	readonly renderers = new Map<string, unknown>();
	readonly handlers = new Map<
		string,
		Array<(event: unknown, ctx: TestExtensionContext) => unknown>
	>();
	readonly execCalls: ExecCall[] = [];
	readonly selectedModels: unknown[] = [];
	readonly selectedThinkingLevels: string[] = [];
	readonly sentMessages: unknown[] = [];
	readonly sentUserMessages: unknown[] = [];
	thinkingLevel = "off";

	registerTool(tool: RegisteredTool) {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, command: Command) {
		this.commands.set(name, command);
	}

	registerShortcut(shortcut: string, options: Shortcut) {
		this.shortcuts.set(shortcut, options);
	}

	registerMessageRenderer(customType: string, renderer: unknown) {
		this.renderers.set(customType, renderer);
	}

	on(
		eventName: string,
		handler: (event: unknown, ctx: TestExtensionContext) => unknown,
	) {
		const handlers = this.handlers.get(eventName) ?? [];
		handlers.push(handler);
		this.handlers.set(eventName, handlers);
	}

	async emit(eventName: string, event: unknown, ctx: TestExtensionContext) {
		const results = [];
		for (const handler of this.handlers.get(eventName) ?? []) {
			const result = await handler(event, ctx);
			results.push(result);
			if (
				result &&
				typeof result === "object" &&
				event &&
				typeof event === "object"
			) {
				if (
					"systemPrompt" in result &&
					typeof result.systemPrompt === "string"
				) {
					(event as { systemPrompt?: string }).systemPrompt =
						result.systemPrompt;
				}
				if ("messages" in result && Array.isArray(result.messages)) {
					(event as { messages?: unknown[] }).messages =
						result.messages;
				}
			}
		}
		return results;
	}

	async exec(command: string, args: string[] = [], options?: unknown) {
		this.execCalls.push({ command, args, options });
		return (
			(await this.execHandler?.(command, args, options)) ?? {
				code: 127,
				stdout: "",
				stderr: `${command} not found`,
			}
		);
	}

	getActiveTools() {
		return [...this.tools.keys()];
	}

	getAllTools() {
		return [...this.tools.values()];
	}

	getThinkingLevel() {
		return this.thinkingLevel;
	}

	setThinkingLevel(level: string) {
		this.thinkingLevel = level;
		this.selectedThinkingLevels.push(level);
	}

	async setModel(model: unknown) {
		this.selectedModels.push(model);
		return true;
	}

	sendMessage(message: unknown, options?: unknown) {
		this.sentMessages.push({ message, options });
	}

	sendUserMessage(content: unknown, options?: unknown) {
		this.sentUserMessages.push({ content, options });
	}
}

export function loadExtension(
	extension: (pi: ExtensionAPI) => unknown,
	execHandler?: ExecHandler,
) {
	const pi = new FakePi(execHandler);
	extension(pi as unknown as ExtensionAPI);
	return pi;
}

export async function createContext(
	overrides: Partial<TestExtensionContext> = {},
) {
	const cwd =
		overrides.cwd ?? (await mkdtemp(path.join(tmpdir(), "pi-ext-test-")));
	const statuses: Array<[string, string | undefined]> = [];
	const widgets: Array<[string, unknown | undefined, unknown | undefined]> =
		[];
	const footers: unknown[] = [];
	const notifications: Notification[] = [];
	const ctx: TestExtensionContext = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKeyForProvider: async () => undefined,
			authStorage: {
				list: () => [],
				get: () => undefined,
			},
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getLeafId: () => "leaf-1",
			getSessionFile: () => path.join(cwd, "session.json"),
			getEntry: () => undefined,
		},
		getContextUsage: () => ({
			tokens: 24_000,
			percent: 12,
			contextWindow: 200_000,
		}),
		getSystemPrompt: () => "You are a test agent.",
		getSystemPromptOptions: () => ({ cwd }),
		navigateTree: async () => ({ cancelled: false }),
		isProjectTrusted: () => true,
		ui: {
			theme: { fg: (_token, text) => text },
			setStatus: (key, value) => statuses.push([key, value]),
			setWidget: (key, widget, options) =>
				widgets.push([key, widget, options]),
			setFooter: (footer) => footers.push(footer),
			notify: (message, level) => notifications.push({ message, level }),
			custom: async () => undefined as never,
			confirm: async () => false,
			input: async () => undefined,
			getEditorText: () => ctx.editorText ?? "",
			setEditorText: (text) => {
				ctx.editorText = text;
			},
		},
		statuses,
		widgets,
		footers,
		notifications,
		editorText: undefined,
		...overrides,
	};
	return ctx;
}

export async function runCommand(
	pi: FakePi,
	name: string,
	args: string,
	ctx: TestExtensionContext,
) {
	const command = pi.commands.get(name);
	assert.ok(command, `Expected /${name} to be registered`);
	assert.ok(command.handler, `Expected /${name} to have a handler`);
	await command.handler(args, ctx);
}

export function assertPublicSurface(
	pi: FakePi,
	expected: {
		tools?: string[];
		commands?: string[];
		shortcuts?: string[];
		handlers?: string[];
	},
) {
	assert.deepEqual([...pi.tools.keys()].sort(), expected.tools ?? []);
	assert.deepEqual([...pi.commands.keys()].sort(), expected.commands ?? []);
	assert.deepEqual([...pi.shortcuts.keys()].sort(), expected.shortcuts ?? []);
	assert.deepEqual([...pi.handlers.keys()].sort(), expected.handlers ?? []);
}
