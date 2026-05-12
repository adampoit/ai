import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder, keyHint } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const diagnosticSchema = Type.Object({
	files: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"Files to check. Defaults to files changed in git.",
			}),
		),
	),
	scope: Type.Optional(
		StringEnum(["changed", "all"] as const, {
			description:
				"Use changed files or all tracked files when files is omitted.",
		}),
	),
});

const symbolPositionSchema = Type.Object({
	file: Type.String({ description: "File to query." }),
	symbol: Type.Optional(
		Type.String({ description: "Symbol name to resolve in the file." }),
	),
	line: Type.Optional(Type.Number({ description: "1-based line number." })),
	character: Type.Optional(
		Type.Number({ description: "1-based character/column number." }),
	),
});

const searchSchema = Type.Object({
	query: Type.String({ description: "Workspace symbol search query." }),
});

type DiagnosticParams = {
	files?: string[];
	scope?: "changed" | "all";
};

type SymbolPositionParams = {
	file: string;
	symbol?: string;
	line?: number;
	character?: number;
};

type Diagnostic = {
	file: string;
	line: number;
	character: number;
	severity: string;
	source?: string;
	message: string;
};

type ServerConfig = {
	languages: string[];
	command: string;
	args: string[];
};

type RpcMessage = {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
};

const servers: ServerConfig[] = [
	{ languages: ["nix"], command: "nixd", args: [] },
	{ languages: ["lua"], command: "lua-language-server", args: [] },
	{
		languages: [
			"typescript",
			"javascript",
			"typescriptreact",
			"javascriptreact",
		],
		command: "vtsls",
		args: ["--stdio"],
	},
	{ languages: ["python"], command: "ruff", args: ["server"] },
	{
		languages: ["csharp"],
		command: "Microsoft.CodeAnalysis.LanguageServer",
		args: ["--stdio"],
	},
];

const languageByExtension = new Map<string, string>([
	[".nix", "nix"],
	[".lua", "lua"],
	[".ts", "typescript"],
	[".tsx", "typescriptreact"],
	[".js", "javascript"],
	[".jsx", "javascriptreact"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
	[".cs", "csharp"],
]);

export default function (pi: ExtensionAPI) {
	let injectedForTurn = false;
	let lastInjectedSignature = "";
	let manager: LspManager | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const renderStatus = (status: string) =>
			ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", status));
		manager = new LspManager(ctx.cwd, renderStatus);
		renderStatus("lsp: 󰔟 warming");
		manager.prewarm().catch((error) => {
			renderStatus("lsp:  error");
			ctx.ui.notify(
				`LSP prewarm failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await manager?.stop();
		ctx.ui.setStatus("lsp", "");
		manager = undefined;
	});

	pi.on("agent_start", () => {
		injectedForTurn = false;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (injectedForTurn) return;

		const diagnostics = await getManager(
			ctx.cwd,
			manager,
		).collectDiagnostics({ scope: "changed" }, ctx.signal);
		if (diagnostics.length === 0) return;

		const signature = JSON.stringify(diagnostics);
		if (signature === lastInjectedSignature) return;

		injectedForTurn = true;
		lastInjectedSignature = signature;
		pi.sendMessage(
			{
				customType: "lsp-diagnostics",
				content: formatDiagnostics(
					diagnostics,
					"LSP diagnostics found after your last response",
				),
				display: true,
				details: { diagnostics },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description:
			"Run language-server diagnostics for specific files or changed files.",
		promptSnippet:
			"Run project LSP diagnostics directly against configured language servers",
		promptGuidelines: [
			"Use lsp_diagnostics after editing code or configuration files to catch language-server errors and warnings before reporting completion.",
		],
		parameters: diagnosticSchema,
		renderResult: renderTextToolResult,
		async execute(
			_toolCallId,
			params: DiagnosticParams,
			signal,
			onUpdate,
			ctx,
		) {
			onUpdate?.({
				content: [
					{ type: "text", text: "Collecting LSP diagnostics..." },
				],
				details: {},
			});
			const diagnostics = await getManager(
				ctx.cwd,
				manager,
			).collectDiagnostics(params, signal);
			return {
				content: [
					{
						type: "text",
						text: formatDiagnostics(diagnostics, "LSP diagnostics"),
					},
				],
				details: { diagnostics, count: diagnostics.length },
			};
		},
	});

	pi.registerTool({
		name: "lsp_inspect",
		label: "LSP Inspect",
		description:
			"Inspect a symbol using its definition, hover/type info, and reference locations.",
		promptSnippet:
			"Inspect a symbol semantically using definition, type/docs, and usages",
		promptGuidelines: [
			"Use lsp_inspect when you need to understand a symbol's type, docs, definition, or role before modifying code that uses it.",
		],
		parameters: symbolPositionSchema,
		renderResult: renderTextToolResult,
		async execute(
			_toolCallId,
			params: SymbolPositionParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const activeManager = getManager(ctx.cwd, manager);
			const position = await resolveSymbolPosition(
				activeManager,
				params,
				signal,
			);
			if ("error" in position)
				return jsonToolResult({ ok: false, error: position.error });

			const definition = await activeManager.requestAtPosition(
				position,
				"textDocument/definition",
				undefined,
				signal,
			);
			const hover = await activeManager.requestAtPosition(
				position,
				"textDocument/hover",
				undefined,
				signal,
			);
			const usages = await activeManager.requestAtPosition(
				position,
				"textDocument/references",
				{ context: { includeDeclaration: true } },
				signal,
			);
			return jsonToolResult({
				ok: true,
				result: { position, definition, hover, usages },
			});
		},
	});

	pi.registerTool({
		name: "lsp_usages",
		label: "LSP Usages",
		description: "Find usages/references of a symbol.",
		promptSnippet: "Find usages of a symbol before changing or removing it",
		promptGuidelines: [
			"Use lsp_usages before renaming, deleting, changing signatures, or changing exported/public symbols.",
		],
		parameters: symbolPositionSchema,
		renderResult: renderTextToolResult,
		async execute(
			_toolCallId,
			params: SymbolPositionParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const activeManager = getManager(ctx.cwd, manager);
			const position = await resolveSymbolPosition(
				activeManager,
				params,
				signal,
			);
			if ("error" in position)
				return jsonToolResult({ ok: false, error: position.error });
			const result = await activeManager.requestAtPosition(
				position,
				"textDocument/references",
				{ context: { includeDeclaration: true } },
				signal,
			);
			return "error" in result
				? jsonToolResult({ ok: false, error: result.error })
				: jsonToolResult({
						ok: true,
						result: { position, usages: result.result },
					});
		},
	});

	pi.registerTool({
		name: "lsp_search",
		label: "LSP Search",
		description: "Search symbols semantically across the workspace.",
		promptSnippet: "Search workspace symbols by name or concept",
		promptGuidelines: [
			"Use lsp_search when you know a symbol or concept name but not the file where it is defined.",
		],
		parameters: searchSchema,
		renderResult: renderTextToolResult,
		async execute(
			_toolCallId,
			params: { query: string },
			signal,
			_onUpdate,
			ctx,
		) {
			const result = await getManager(
				ctx.cwd,
				manager,
			).requestWorkspaceSymbols(params.query, signal);
			return jsonToolResult(result);
		},
	});

	pi.registerCommand("lsp-diagnostics", {
		description: "Show LSP diagnostics for changed files",
		handler: async (_args, ctx) => {
			const diagnostics = await getManager(
				ctx.cwd,
				manager,
			).collectDiagnostics({ scope: "changed" }, ctx.signal);
			ctx.ui.notify(
				formatDiagnostics(diagnostics, "LSP diagnostics"),
				diagnostics.length ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("lsp", {
		description: "Show running language servers",
		handler: async (_args, ctx) => {
			await getManager(ctx.cwd, manager).show(ctx);
		},
	});
}

async function resolveSymbolPosition(
	manager: LspManager,
	params: SymbolPositionParams,
	signal: AbortSignal | undefined,
): Promise<PositionParams | { error: string }> {
	if (params.line !== undefined && params.character !== undefined) {
		return {
			file: params.file,
			line: params.line,
			character: params.character,
		};
	}
	if (!params.symbol) {
		return { error: "Provide either symbol or both line and character." };
	}

	const result = await manager.requestDocumentSymbols(params.file, signal);
	if ("error" in result) return result;
	const match = findDocumentSymbol(result.symbols, params.symbol);
	if (!match) {
		return {
			error: `Could not find symbol ${params.symbol} in ${params.file}.`,
		};
	}
	const position = match.selectionRange?.start ?? match.range?.start;
	if (!position) {
		return { error: `Symbol ${params.symbol} did not include a position.` };
	}
	return {
		file: params.file,
		line: position.line + 1,
		character: position.character + 1,
	};
}

type PositionParams = {
	file: string;
	line: number;
	character: number;
};

function findDocumentSymbol(symbols: unknown, name: string): any | undefined {
	if (!Array.isArray(symbols)) return undefined;
	for (const symbol of symbols) {
		if (!symbol || typeof symbol !== "object") continue;
		const candidate = symbol as any;
		if (candidate.name === name) return candidate;
		const childMatch = findDocumentSymbol(candidate.children, name);
		if (childMatch) return childMatch;
	}
	return undefined;
}

function getManager(cwd: string, manager: LspManager | undefined) {
	return manager && manager.cwd === cwd ? manager : new LspManager(cwd);
}

function formatOnOffSections(
	title: string,
	entries: Array<{ on: boolean; text: string }>,
	includeOff = false,
): string {
	const on = entries.filter((entry) => entry.on).map((entry) => entry.text);
	const off = entries.filter((entry) => !entry.on).map((entry) => entry.text);
	const lines = [
		`${title}:`,
		"",
		`On (${on.length}):`,
		on.length ? on.join("\n") : "- none",
	];
	if (includeOff) {
		lines.push(
			"",
			`Off (${off.length}):`,
			off.length ? off.join("\n") : "- none",
		);
	} else if (off.length) {
		lines.push("", `${off.length} off/configured entries hidden.`);
	}
	return lines.join("\n");
}

async function showToggleView(
	ctx: ExtensionCommandContext,
	title: string,
	entries: Array<{ on: boolean; text: string }>,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, kb, done) => {
			let showAll = false;
			const border = new DynamicBorder((text) =>
				theme.fg("border", text),
			);
			return {
				render(width: number) {
					const lines = [
						theme.fg(
							"dim",
							`t: ${showAll ? "show on only" : "show all configured"} • esc: close`,
						),
						"",
						...formatOnOffSections(title, entries, showAll).split(
							"\n",
						),
						"",
						border.render(width)[0] ?? "",
					];
					return lines.map((line) => truncateToWidth(line, width));
				},
				invalidate() {},
				handleInput(data: string) {
					if (kb.matches(data, "tui.select.cancel")) {
						done();
						return;
					}
					if (data === "t") showAll = !showAll;
					tui.requestRender();
				},
			};
		},
		{ overlay: false },
	);
}

class LspManager {
	private clients = new Map<string, LspClient>();
	private diagnostics = new Map<string, Diagnostic[]>();
	private openedDocuments = new Map<string, number>();
	private mode: "warming" | "ready" | "checking" = "warming";
	private prewarmed = false;

	constructor(
		readonly cwd: string,
		private setStatus: (status: string) => void = () => {},
	) {}

	async prewarm(signal?: AbortSignal) {
		this.mode = "warming";
		this.updateStatus();
		const files = await discoverFiles(this.cwd, "all", signal);
		const languages = new Set(
			files
				.map((file) => languageByExtension.get(path.extname(file)))
				.filter((language): language is string => Boolean(language)),
		);
		await Promise.all(
			[...languages].map(async (language) => {
				const config = servers.find((server) =>
					server.languages.includes(language),
				);
				if (!config) return;
				await this.getClient(config, signal).catch(() => undefined);
			}),
		);
		this.prewarmed = true;
		this.mode = "ready";
		this.updateStatus();
	}

	async stop() {
		this.setStatus("lsp: stopping");
		await Promise.all(
			[...this.clients.values()].map((client) => client.stop()),
		);
		this.clients.clear();
		this.setStatus("");
	}

	async collectDiagnostics(params: DiagnosticParams, signal?: AbortSignal) {
		this.mode = "checking";
		this.updateStatus();
		try {
			const requestedFiles = params.files?.length
				? params.files
				: await discoverFiles(
						this.cwd,
						params.scope ?? "changed",
						signal,
					);
			const files = requestedFiles.filter((file) =>
				languageByExtension.has(path.extname(file)),
			);
			if (files.length === 0) return [];

			for (const file of files) {
				this.diagnostics.delete(path.normalize(file));
			}
			await Promise.all(
				files.map(async (file) => {
					await this.openDocument(file, signal);
				}),
			);
			await delay(1500, signal);
			return files
				.flatMap(
					(file) => this.diagnostics.get(path.normalize(file)) ?? [],
				)
				.sort((a, b) =>
					`${a.file}:${a.line}:${a.character}`.localeCompare(
						`${b.file}:${b.line}:${b.character}`,
					),
				);
		} finally {
			this.mode = "ready";
			this.updateStatus();
		}
	}

	async requestAtPosition(
		params: PositionParams,
		method: string,
		extraParams: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
		return await this.withOpenDocument(
			params.file,
			signal,
			async (client, textDocument) => {
				const result = await client.request(method, {
					textDocument: { uri: textDocument.uri },
					position: {
						line: params.line - 1,
						character: params.character - 1,
					},
					...extraParams,
				});
				return { ok: true, result };
			},
		);
	}

	async requestDocumentSymbols(
		file: string,
		signal?: AbortSignal,
	): Promise<{ ok: true; symbols: unknown } | { ok: false; error: string }> {
		return await this.withOpenDocument(
			file,
			signal,
			async (client, textDocument) => {
				const symbols = await client.request(
					"textDocument/documentSymbol",
					{
						textDocument: { uri: textDocument.uri },
					},
				);
				return { ok: true, symbols };
			},
		);
	}

	async requestWorkspaceSymbols(
		query: string,
		signal?: AbortSignal,
	): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
		const results: unknown[] = [];
		const errors: string[] = [];
		for (const config of servers) {
			try {
				const client = await this.getClient(config, signal);
				results.push(
					await client.request("workspace/symbol", { query }),
				);
			} catch (error) {
				errors.push(
					`${config.command}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (results.length === 0 && errors.length > 0)
			return { ok: false, error: errors.join("\n") };
		return { ok: true, result: results.flat() };
	}

	async getEntries(
		signal?: AbortSignal,
	): Promise<Array<{ on: boolean; text: string }>> {
		const files = await discoverFiles(this.cwd, "all", signal);
		const projectLanguages = new Set(
			files
				.map((file) => languageByExtension.get(path.extname(file)))
				.filter((language): language is string => Boolean(language)),
		);
		const entries = await Promise.all(
			servers.map(async (server) => {
				const key = `${server.command}\0${server.args.join("\0")}`;
				const executablePath = await commandPath(
					server.command,
					this.cwd,
					signal,
				);
				const running = this.clients.get(key)?.started ?? false;
				const detectedLanguages = server.languages.filter((language) =>
					projectLanguages.has(language),
				);
				const command = [server.command, ...server.args].join(" ");
				const lines = [
					`- ${server.languages.join(", ")}`,
					`  project: ${detectedLanguages.length ? detectedLanguages.join(", ") : "not detected"}`,
					`  command: ${command}`,
					`  path: ${executablePath ?? "unavailable"}`,
				];
				if (executablePath)
					lines.push(
						`  version: ${await commandVersion(executablePath, this.cwd, signal)}`,
					);
				lines.push(`  state: ${running ? "running" : "not running"}`);
				return { on: running, text: lines.join("\n") };
			}),
		);
		return entries;
	}

	async show(ctx: ExtensionCommandContext): Promise<void> {
		await showToggleView(ctx, "lsp", await this.getEntries(ctx.signal));
	}

	private async withOpenDocument<T>(
		file: string,
		signal: AbortSignal | undefined,
		callback: (
			client: LspClient,
			textDocument: {
				uri: string;
				languageId: string;
				version: number;
				text: string;
			},
		) => Promise<T>,
	): Promise<T | { ok: false; error: string }> {
		try {
			const { client, textDocument } = await this.openDocument(
				file,
				signal,
			);
			return await callback(client, textDocument);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async openDocument(file: string, signal?: AbortSignal) {
		const language = languageByExtension.get(path.extname(file));
		if (!language)
			throw new Error(`No language server configured for ${file}`);
		const config = servers.find((server) =>
			server.languages.includes(language),
		);
		if (!config)
			throw new Error(`No language server configured for ${language}`);
		const client = await this.getClient(config, signal);
		const absolutePath = path.resolve(this.cwd, file);
		const uri = pathToFileURL(absolutePath).toString();
		const version = (this.openedDocuments.get(uri) ?? 0) + 1;
		this.openedDocuments.set(uri, version);
		const textDocument = {
			uri,
			languageId: language,
			version,
			text: await readFile(absolutePath, "utf8"),
		};
		if (version > 1) {
			client.notify("textDocument/didClose", {
				textDocument: { uri },
			});
		}
		client.notify("textDocument/didOpen", { textDocument });
		return { client, textDocument };
	}

	private async getClient(config: ServerConfig, signal?: AbortSignal) {
		const key = `${config.command}\0${config.args.join("\0")}`;
		const existing = this.clients.get(key);
		if (existing?.started) return existing;
		if (!(await commandExists(config.command, this.cwd, signal)))
			throw new Error(`${config.command} is not available on PATH`);
		const client = new LspClient(this.cwd, config, signal);
		client.onNotification = (method, params) => {
			if (method !== "textDocument/publishDiagnostics") return;
			const value = params as {
				uri: string;
				diagnostics?: Array<{
					range: { start: { line: number; character: number } };
					severity?: number;
					source?: string;
					message: string;
				}>;
			};
			const file = path.normalize(
				path.relative(this.cwd, fileURLToPath(value.uri)),
			);
			this.diagnostics.set(
				file,
				(value.diagnostics ?? []).map((diagnostic) => ({
					file,
					line: diagnostic.range.start.line + 1,
					character: diagnostic.range.start.character + 1,
					severity: severityName(diagnostic.severity),
					source: diagnostic.source,
					message: diagnostic.message,
				})),
			);
		};
		await initializeClient(this.cwd, client, defaultCapabilities());
		this.clients.set(key, client);
		this.updateStatus();
		return client;
	}

	private updateStatus() {
		const running = [...this.clients.values()].filter(
			(client) => client.started,
		);
		if (running.length === 0) {
			this.setStatus(this.prewarmed ? "lsp: none" : "lsp: 󰔟 warming");
			return;
		}
		const icon = this.mode === "checking" ? "" : "";
		this.setStatus(
			`lsp: ${running.map((client) => `${icon} ${client.name}`).join("  ")}`,
		);
	}
}

function defaultCapabilities() {
	return {
		textDocument: {
			publishDiagnostics: { relatedInformation: true },
			documentSymbol: { hierarchicalDocumentSymbolSupport: true },
			definition: { linkSupport: true },
			references: {},
			hover: { contentFormat: ["markdown", "plaintext"] },
			signatureHelp: {},
		},
		workspace: { symbol: { dynamicRegistration: false } },
	};
}

async function initializeClient(
	cwd: string,
	client: LspClient,
	capabilities: Record<string, unknown>,
) {
	await client.start();
	await client.request("initialize", {
		processId: process.pid,
		rootUri: pathToFileURL(cwd).toString(),
		capabilities,
		workspaceFolders: [
			{ uri: pathToFileURL(cwd).toString(), name: path.basename(cwd) },
		],
	});
	client.notify("initialized", {});
}

function jsonToolResult(
	result: { ok: true; result: unknown } | { ok: false; error: string },
) {
	return {
		content: [
			{
				type: "text" as const,
				text:
					"error" in result
						? result.error
						: JSON.stringify(result.result, null, 2),
			},
		],
		details: result,
		isError: !result.ok,
	};
}

const collapsedResultLines = 12;

function renderTextToolResult(
	result: { content?: Array<{ type: string; text?: string }> },
	{ expanded, isPartial }: { expanded?: boolean; isPartial?: boolean },
	theme: any,
) {
	const textContent = result.content?.find(
		(content) =>
			content.type === "text" && typeof content.text === "string",
	)?.text;
	if (!textContent) {
		return new Text(
			theme.fg("dim", isPartial ? "Working..." : "No output"),
			0,
			0,
		);
	}

	const lines = textContent.split("\n");
	if (expanded || lines.length <= collapsedResultLines) {
		return new Text(textContent, 0, 0);
	}

	const hidden = lines.length - collapsedResultLines;
	const preview = lines.slice(0, collapsedResultLines).join("\n");
	return new Text(
		`${preview}\n${theme.fg(
			"muted",
			`... ${hidden} more line${hidden === 1 ? "" : "s"} hidden (${keyHint("app.tools.expand", "to expand")})`,
		)}`,
		0,
		0,
	);
}

class LspClient {
	onNotification?: (method: string, params: unknown) => void;
	started = false;
	readonly name: string;
	private proc?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(
		private cwd: string,
		private config: ServerConfig,
		private signal?: AbortSignal,
	) {
		this.name = config.command;
	}

	async start() {
		if (this.started) return;
		this.started = true;
		this.proc = spawn(this.config.command, this.config.args, {
			cwd: this.cwd,
			signal: this.signal,
		});
		this.proc.stdout.on("data", (chunk: Buffer) => this.read(chunk));
		this.proc.stderr.on("data", () => {});
		this.proc.on("error", (error) => this.rejectAll(error));
		this.proc.on("exit", (code) =>
			this.rejectAll(
				new Error(`${this.config.command} exited with ${code}`),
			),
		);
	}

	async request(method: string, params: unknown) {
		const id = this.nextId++;
		this.send({ jsonrpc: "2.0", id, method, params });
		return await new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(
					new Error(`${method} timed out for ${this.config.command}`),
				);
			}, 10_000);
		});
	}

	notify(method: string, params: unknown) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	async stop() {
		if (!this.proc) return;
		try {
			this.notify("shutdown", null);
			this.notify("exit", null);
		} catch {}
		this.proc.kill("SIGTERM");
		this.started = false;
	}

	private send(message: RpcMessage) {
		if (!this.proc)
			throw new Error(`${this.config.command} is not running`);
		const body = Buffer.from(JSON.stringify(message), "utf8");
		this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		this.proc.stdin.write(body);
	}

	private read(chunk: Buffer) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = this.buffer.subarray(0, headerEnd).toString("utf8");
			const match = /Content-Length: (\d+)/i.exec(header);
			if (!match)
				throw new Error(
					`Invalid LSP header from ${this.config.command}`,
				);
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (this.buffer.length < bodyEnd) return;
			const message = JSON.parse(
				this.buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
			) as RpcMessage;
			this.buffer = this.buffer.subarray(bodyEnd);
			this.handle(message);
		}
	}

	private handle(message: RpcMessage) {
		if (
			message.id !== undefined &&
			(message.result !== undefined || message.error !== undefined)
		) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error)
				pending.reject(new Error(JSON.stringify(message.error)));
			else pending.resolve(message.result);
			return;
		}
		if (message.method)
			this.onNotification?.(message.method, message.params);
	}

	private rejectAll(error: Error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

async function discoverFiles(
	cwd: string,
	scope: "changed" | "all",
	signal?: AbortSignal,
): Promise<string[]> {
	const jjFiles = await discoverJjFiles(cwd, scope, signal);
	if (jjFiles) return jjFiles;

	const command =
		scope === "all"
			? "git ls-files"
			: "git diff --name-only --diff-filter=ACMR HEAD && git ls-files --others --exclude-standard";
	const result = await runShell(cwd, command, signal);
	if (result.exitCode !== 0) return [];
	return uniqueLines(result.stdout);
}

async function discoverJjFiles(
	cwd: string,
	scope: "changed" | "all",
	signal?: AbortSignal,
): Promise<string[] | undefined> {
	const root = await runShell(cwd, "jj root --ignore-working-copy", signal);
	if (root.exitCode !== 0) return undefined;

	const command =
		scope === "all"
			? "jj file list --ignore-working-copy"
			: "jj diff --name-only --ignore-working-copy -r @";
	const result = await runShell(cwd, command, signal);
	return result.exitCode === 0 ? uniqueLines(result.stdout) : undefined;
}

function uniqueLines(value: string): string[] {
	return [
		...new Set(
			value
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
}

async function commandPath(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await runShell(
		cwd,
		`command -v ${shellQuote(command)}`,
		signal,
	);
	const path = result.stdout.trim();
	return result.exitCode === 0 && path ? path : undefined;
}

async function commandExists(
	command: string,
	cwd: string,
	signal?: AbortSignal,
) {
	return Boolean(await commandPath(command, cwd, signal));
}

async function commandVersion(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const quoted = shellQuote(command);
	const result = await runShell(
		cwd,
		`${quoted} --version 2>&1 | head -n 1 || ${quoted} version 2>&1 | head -n 1`,
		signal,
	);
	const version = result.stdout.trim();
	return result.exitCode === 0 && version ? version : "unknown";
}

async function runShell(cwd: string, command: string, signal?: AbortSignal) {
	return await new Promise<{ stdout: string; exitCode: number }>(
		(resolve) => {
			const proc = spawn("/bin/sh", ["-lc", command], { cwd, signal });
			let stdout = "";
			proc.stdout.on("data", (data) => (stdout += data));
			proc.on("error", () => resolve({ stdout, exitCode: 1 }));
			proc.on("close", (code) =>
				resolve({ stdout, exitCode: code ?? 1 }),
			);
		},
	);
}

function severityName(severity?: number) {
	if (severity === 1) return "error";
	if (severity === 2) return "warning";
	if (severity === 3) return "info";
	if (severity === 4) return "hint";
	return "unknown";
}

function formatDiagnostics(diagnostics: Diagnostic[], title: string) {
	if (diagnostics.length === 0) return `${title}: none.`;
	const shown = diagnostics.slice(0, 80).map((diagnostic) => {
		const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
		return `- ${diagnostic.file}:${diagnostic.line}:${diagnostic.character}: ${diagnostic.severity}${source}: ${diagnostic.message}`;
	});
	const suffix =
		diagnostics.length > shown.length
			? `\n... ${diagnostics.length - shown.length} more diagnostics omitted.`
			: "";
	return `${title} (${diagnostics.length}):\n${shown.join("\n")}${suffix}`;
}

async function delay(ms: number, signal?: AbortSignal) {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		});
	});
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
