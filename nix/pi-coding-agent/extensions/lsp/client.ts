import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LspServerImplementation } from "./types.ts";

export type ServerConfig = LspServerImplementation;

type RpcMessage = {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
};

export class LspClient {
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
	private projectInitialized: boolean;
	private projectInitializationWaiters = new Set<() => void>();
	private serverCapabilities: unknown;
	private stderr = "";

	constructor(
		private cwd: string,
		private config: ServerConfig,
		private signal?: AbortSignal,
	) {
		this.name = config.command;
		this.projectInitialized = config.isProjectInitialized ?? true;
	}

	async start() {
		if (this.started) return;
		this.started = true;
		const processCwd = await lspProcessDirectory(this.config, this.cwd);
		const env = await lspProcessEnvironment(
			this.config,
			this.cwd,
			processCwd,
			this.signal,
		);
		this.proc = spawn(this.config.command, this.config.args, {
			cwd: processCwd,
			detached: process.platform !== "win32",
			signal: this.signal,
			env,
		});
		this.proc.stdout.on("data", (chunk: Buffer) => this.read(chunk));
		this.proc.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(
				-4000,
			);
		});
		this.proc.on("error", (error) => this.rejectAll(error));
		this.proc.on("exit", (code) => {
			const details = this.stderr.trim();
			this.rejectAll(
				new Error(
					`${this.config.command} exited with ${code}${details ? `: ${details}` : ""}`,
				),
			);
		});
	}

	async request(
		method: string,
		params: unknown,
		timeoutMs: number | null = 10_000,
	) {
		const id = this.nextId++;
		this.send({ jsonrpc: "2.0", id, method, params });
		return await new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			if (timeoutMs === null) return;
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(
					new Error(`${method} timed out for ${this.config.command}`),
				);
			}, timeoutMs);
			timer.unref?.();
		});
	}

	notify(method: string, params?: unknown) {
		this.send(
			params === undefined
				? { jsonrpc: "2.0", method }
				: { jsonrpc: "2.0", method, params },
		);
	}

	async stop() {
		const proc = this.proc;
		if (!proc) return;
		try {
			await this.request("shutdown", null, 1000).catch(() => undefined);
			this.notify("exit");
		} catch {}
		killProcessGroup(proc, "SIGTERM");
		if (!(await waitForProcessExit(proc, 1000))) {
			killProcessGroup(proc, "SIGKILL");
			await waitForProcessExit(proc, 1000);
		}
		this.proc = undefined;
		this.started = false;
	}

	setServerCapabilities(capabilities: unknown) {
		this.serverCapabilities = capabilities;
	}

	supportsWorkspaceSymbols() {
		return Boolean(
			this.serverCapabilities &&
			typeof this.serverCapabilities === "object" &&
			(this.serverCapabilities as { workspaceSymbolProvider?: unknown })
				.workspaceSymbolProvider,
		);
	}

	supportsDocumentDiagnostics() {
		return Boolean(
			this.serverCapabilities &&
			typeof this.serverCapabilities === "object" &&
			(this.serverCapabilities as { diagnosticProvider?: unknown })
				.diagnosticProvider,
		);
	}

	async waitForProjectInitialization(timeoutMs = 10_000) {
		if (this.projectInitialized) return;
		await new Promise<void>((resolve) => {
			const resolveOnce = () => {
				clearTimeout(timer);
				this.projectInitializationWaiters.delete(resolveOnce);
				resolve();
			};
			const timer = setTimeout(resolveOnce, timeoutMs);
			this.projectInitializationWaiters.add(resolveOnce);
		});
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
		if (message.method) {
			if (message.id !== undefined) {
				this.handleServerRequest(message);
				return;
			}
			if (message.method === "workspace/projectInitializationComplete") {
				this.markProjectInitialized();
			}
			this.onNotification?.(message.method, message.params);
		}
	}

	private handleServerRequest(message: RpcMessage) {
		if (message.id === undefined) return;
		let result: unknown = null;
		if (message.method === "workspace/configuration") {
			const items = (message.params as { items?: unknown[] } | undefined)
				?.items;
			result = Array.isArray(items) ? items.map(() => ({})) : [];
		}
		this.send({ jsonrpc: "2.0", id: message.id, result });
	}

	private markProjectInitialized() {
		this.projectInitialized = true;
		for (const resolve of this.projectInitializationWaiters) resolve();
		this.projectInitializationWaiters.clear();
	}

	private rejectAll(error: Error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

export function defaultCapabilities() {
	return {
		textDocument: {
			publishDiagnostics: { relatedInformation: true },
			diagnostic: { dynamicRegistration: false },
			documentSymbol: { hierarchicalDocumentSymbolSupport: true },
			definition: { linkSupport: true },
			references: {},
			hover: { contentFormat: ["markdown", "plaintext"] },
			signatureHelp: {},
		},
		workspace: {
			configuration: true,
			symbol: { dynamicRegistration: false },
		},
	};
}

export async function initializeClient(
	cwd: string,
	client: LspClient,
	config: ServerConfig,
	capabilities: Record<string, unknown>,
) {
	await client.start();
	const rootUri = pathToFileURL(cwd).toString();
	const init = (await client.request(
		"initialize",
		{
			processId: process.pid,
			rootUri,
			capabilities,
			...(config.initializationOptions
				? await config.initializationOptions(cwd)
				: {}),
			workspaceFolders: [
				{
					uri: rootUri,
					name: path.basename(cwd),
				},
			],
		},
		null,
	)) as { capabilities?: unknown };
	client.setServerCapabilities(init.capabilities);
	client.notify("initialized", {});
}

function killProcessGroup(
	proc: ChildProcessWithoutNullStreams,
	signal: NodeJS.Signals,
) {
	if (process.platform !== "win32" && proc.pid) {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch {}
	}
	proc.kill(signal);
}

async function waitForProcessExit(
	proc: ChildProcessWithoutNullStreams,
	timeoutMs: number,
) {
	if (proc.exitCode !== null || proc.signalCode !== null) return true;
	return await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			proc.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		timer.unref?.();
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		proc.once("exit", onExit);
	});
}

async function lspProcessDirectory(config: ServerConfig, cwd: string) {
	if (config.processDirectory) return await config.processDirectory(cwd);
	const key = createHash("sha256")
		.update(`${cwd}\0${config.command}\0${config.args.join("\0")}`)
		.digest("hex")
		.slice(0, 16);
	const directory = path.join(tmpdir(), "pi-lsp", config.command, key);
	await mkdir(directory, { recursive: true });
	return directory;
}

async function lspProcessEnvironment(
	config: ServerConfig,
	cwd: string,
	processCwd: string,
	signal?: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
	const defaultEnvironment: NodeJS.ProcessEnv = {
		...process.env,
		TMPDIR: processCwd,
	};
	return config.processEnvironment
		? await config.processEnvironment({
				cwd,
				processCwd,
				signal,
				defaultEnvironment,
			})
		: defaultEnvironment;
}
