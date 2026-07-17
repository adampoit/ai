import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BlockFrame, gruvbox, KeyHintLine } from "../../components/index.ts";
import { lspServers } from "./registry.ts";
import {
	defaultCapabilities,
	initializeClient,
	LspClient,
	type ServerConfig,
} from "./client.ts";
import { lspDiagnosticsToDiagnostics } from "./diagnostics.ts";
import type {
	Diagnostic,
	DiagnosticParams,
	Notify,
	PositionParams,
	SymbolPositionParams,
} from "./types.ts";
import {
	commandPaths,
	commandVersion,
	delay,
	discoverFiles,
	fileExists,
	formatLanguageDetectionReason,
	languageForFile,
	languageReasonsForFiles,
	languagesForFiles,
	mapWithConcurrency,
} from "./workspace.ts";

export async function resolveSymbolPosition(
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
	const position =
		match.selectionRange?.start ??
		match.range?.start ??
		match.location?.range?.start;
	if (!position) {
		return { error: `Symbol ${params.symbol} did not include a position.` };
	}
	return {
		file: params.file,
		line: position.line + 1,
		character: position.character + 1,
	};
}

function findDocumentSymbol(symbols: unknown, name: string): any | undefined {
	if (!Array.isArray(symbols)) return undefined;
	for (const symbol of symbols) {
		if (!symbol || typeof symbol !== "object") continue;
		const candidate = symbol as any;
		if (matchesDocumentSymbolName(candidate.name, name)) return candidate;
		const childMatch = findDocumentSymbol(candidate.children, name);
		if (childMatch) return childMatch;
	}
	return undefined;
}

function matchesDocumentSymbolName(candidate: unknown, name: string) {
	if (typeof candidate !== "string") return false;
	if (candidate === name) return true;
	const next = candidate[name.length];
	return (
		candidate.startsWith(name) &&
		next !== undefined &&
		!/[A-Za-z0-9_]/.test(next)
	);
}

function summarizeServerFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const lines = [
		...new Set(
			message
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
	const summary = lines.slice(0, 6).join("; ");
	return lines.length > 6 ? `${summary}; …` : summary;
}

export function getManager(
	cwd: string,
	manager: LspManager | undefined,
	notify: Notify = () => {},
) {
	return manager && manager.cwd === cwd
		? manager
		: new LspManager(cwd, undefined, notify);
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
			return {
				render(width: number) {
					const running = entries.filter((entry) => entry.on).length;
					const stopped = entries.length - running;
					return new BlockFrame(
						{
							invalidate() {},
							render(contentWidth: number) {
								const help = new KeyHintLine(
									[
										{
											key: "t",
											label: showAll
												? "show running only"
												: "show all configured",
										},
										{ key: "esc", label: "close" },
									],
									{ theme, accent: gruvbox.blue },
								).render(contentWidth);
								return [
									...help,
									"",
									...formatOnOffSections(
										title,
										entries,
										showAll,
									).split("\n"),
								].map((line) =>
									truncateToWidth(line, contentWidth),
								);
							},
						},
						{
							title: {
								title,
								icon: "",
								accent: gruvbox.blue,
								badges: [
									{
										text: `${running} running`,
										bg: gruvbox.bg2,
									},
									{
										text: `${stopped} stopped`,
										bg: gruvbox.bg2,
									},
								],
								theme,
							},
							borderColor: gruvbox.blue,
							background: gruvbox.bg1,
							theme,
							paddingX: 1,
							paddingY: 1,
						},
					).render(width);
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

const lspStartupConcurrency = 2;
const lspDocumentConcurrency = 4;
const lspNotificationBatchDelayMs = 25;

export class LspManager {
	private clients = new Map<string, LspClient>();
	private diagnostics = new Map<string, Diagnostic[]>();
	private openedDocuments = new Map<string, number>();
	private failedServerNotifications = new Set<string>();
	private mode: "warming" | "ready" | "checking" = "warming";
	private prewarmed = false;

	constructor(
		readonly cwd: string,
		private setStatus: (status: string) => void = () => {},
		private notify: Notify = () => {},
	) {}

	async prewarm(signal?: AbortSignal) {
		this.mode = "warming";
		this.updateStatus();
		const files = await discoverFiles(this.cwd, "all", signal);
		const languages = languagesForFiles(files);
		await mapWithConcurrency(
			[...languages],
			lspStartupConcurrency,
			async (language) => {
				const config = lspServers.find((server) =>
					server.languages.includes(language),
				);
				if (!config) return;
				await this.getClient(config, signal).catch(() => undefined);
			},
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
		this.diagnostics.clear();
		this.openedDocuments.clear();
		this.setStatus("");
	}

	async refresh(signal?: AbortSignal) {
		this.setStatus("lsp: refreshing");
		await this.stop();
		this.prewarmed = false;
		await this.prewarm(signal);
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
			const candidateFiles = requestedFiles.filter((file) =>
				Boolean(languageForFile(file)),
			);
			if (candidateFiles.length === 0) return [];

			for (const file of candidateFiles) {
				this.diagnostics.delete(path.normalize(file));
			}
			const existingFiles = new Array<string | undefined>(
				candidateFiles.length,
			);
			await mapWithConcurrency(
				candidateFiles,
				lspDocumentConcurrency,
				async (file, index) => {
					existingFiles[index] = (await fileExists(
						path.resolve(this.cwd, file),
					))
						? file
						: undefined;
				},
			);
			const files = existingFiles.filter((file): file is string =>
				Boolean(file),
			);
			if (files.length === 0) return [];

			await mapWithConcurrency(
				files,
				lspDocumentConcurrency,
				async (file) => {
					const { client, textDocument } = await this.openDocument(
						file,
						signal,
					);
					if (client.supportsDocumentDiagnostics()) {
						await this.pullDiagnostics(client, textDocument).catch(
							() => undefined,
						);
						return;
					}
					await delay(lspNotificationBatchDelayMs, signal);
				},
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
				await client.waitForProjectInitialization();
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
				await client.waitForProjectInitialization();
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
		let skippedUnsupported = false;
		const projectLanguages = languagesForFiles(
			await discoverFiles(this.cwd, "all", signal),
		);
		const candidateServers = projectLanguages.size
			? lspServers.filter((server) =>
					server.languages.some((language) =>
						projectLanguages.has(language),
					),
				)
			: lspServers;
		for (const config of candidateServers) {
			try {
				const client = await this.getClient(config, signal);
				if (!client.supportsWorkspaceSymbols()) {
					skippedUnsupported = true;
					continue;
				}
				await client.waitForProjectInitialization();
				results.push(
					await client.request("workspace/symbol", { query }),
				);
			} catch (error) {
				errors.push(
					`${config.command}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (results.length === 0 && errors.length > 0 && !skippedUnsupported)
			return { ok: false, error: errors.join("\n") };
		return { ok: true, result: results.flat() };
	}

	async getEntries(
		signal?: AbortSignal,
	): Promise<Array<{ on: boolean; text: string }>> {
		const files = await discoverFiles(this.cwd, "all", signal);
		const languageReasons = languageReasonsForFiles(files);
		const projectLanguages = new Set(languageReasons.keys());
		const entries = await Promise.all(
			lspServers.map(async (server) => {
				const key = `${server.command}\0${server.args.join("\0")}`;
				const runningClient = this.clients.get(key);
				const executablePath =
					runningClient?.executablePath ??
					(
						await commandPaths(server.command, {
							...process.env,
						})
					)[0];
				const running = runningClient?.started ?? false;
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
				const reason = formatLanguageDetectionReason(
					detectedLanguages,
					languageReasons,
				);
				if (reason) lines.push(`  reason: ${reason}`);
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
		const language = languageForFile(file);
		if (!language)
			throw new Error(`No language server configured for ${file}`);
		const configs = lspServers.filter((server) =>
			server.languages.includes(language),
		);
		if (configs.length === 0)
			throw new Error(`No language server configured for ${language}`);

		const errors: string[] = [];
		for (const config of configs) {
			try {
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
			} catch (error) {
				errors.push(
					`${config.command}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		throw new Error(errors.join("\n"));
	}

	private async pullDiagnostics(
		client: LspClient,
		textDocument: { uri: string },
	) {
		const result = (await client.request("textDocument/diagnostic", {
			textDocument: { uri: textDocument.uri },
		})) as { items?: unknown };
		if (!Array.isArray(result.items)) return;
		const file = path.normalize(
			path.relative(this.cwd, fileURLToPath(textDocument.uri)),
		);
		this.diagnostics.set(
			file,
			lspDiagnosticsToDiagnostics(file, result.items),
		);
	}

	private async getClient(config: ServerConfig, signal?: AbortSignal) {
		const key = `${config.command}\0${config.args.join("\0")}`;
		const existing = this.clients.get(key);
		if (existing?.started) return existing;

		const executablePaths = await commandPaths(config.command, {
			...process.env,
		});
		if (executablePaths.length === 0) {
			const error = new Error(
				`${config.command} is not available on PATH`,
			);
			this.notifyServerFailure(config, error);
			throw error;
		}

		const failures: string[] = [];
		for (const executablePath of executablePaths) {
			const client = new LspClient(
				this.cwd,
				config,
				signal,
				executablePath,
			);
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
					lspDiagnosticsToDiagnostics(file, value.diagnostics ?? []),
				);
			};
			try {
				await initializeClient(
					this.cwd,
					client,
					config,
					defaultCapabilities(),
				);
				this.clients.set(key, client);
				this.updateStatus();
				return client;
			} catch (error) {
				await client.stop().catch(() => undefined);
				if (signal?.aborted) throw error;
				failures.push(
					`${executablePath}: ${summarizeServerFailure(error)}`,
				);
			}
		}

		const error = new Error(failures.join("\n"));
		this.notifyServerFailure(config, error);
		throw error;
	}

	private notifyServerFailure(config: ServerConfig, error: unknown) {
		const message = `${config.command} failed to initialize: ${error instanceof Error ? error.message : String(error)}`;
		if (this.failedServerNotifications.has(message)) return;
		this.failedServerNotifications.add(message);
		this.notify(`LSP server ${message}`, "warning");
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
