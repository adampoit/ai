import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
	defaultCapabilities,
	initializeClient,
	LspClient,
} from "../../../nix/pi-coding-agent/extensions/lsp/client.ts";
import { rustLspServer } from "../../../nix/pi-coding-agent/extensions/lsp/servers/rust.ts";

const unixOnly = { skip: process.platform === "win32" };

test(
	"LspClient handles a language server closing stdin",
	unixOnly,
	async (t) => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-lsp-client-test-"));
		const readyFile = path.join(cwd, "ready");
		const serverPath = path.join(cwd, "closed-stdin-lsp");
		await writeFile(
			serverPath,
			`#!${process.execPath}
const fs = require("node:fs");
fs.closeSync(0);
fs.writeFileSync(process.argv[2], "ready");
setInterval(() => {}, 1000);
`,
		);
		await chmod(serverPath, 0o755);

		const client = new LspClient(cwd, {
			languages: ["test"],
			command: serverPath,
			args: [readyFile],
			processDirectory: async () => cwd,
		});
		t.after(async () => {
			await client.stop();
			await rm(cwd, { recursive: true, force: true });
		});

		await client.start();
		await waitForFile(readyFile);
		await client.stop();

		assert.equal(client.started, false);
	},
);

test("LspClient waits for rust-analyzer to become quiescent", async (t) => {
	const client = await createInitializingClient(t);
	assert.equal(
		defaultCapabilities().experimental.serverStatusNotification,
		true,
	);
	let ready = false;
	const waiting = client.waitForProjectInitialization().then(() => {
		ready = true;
	});
	for (const params of [{ quiescent: false }, { quiescent: "true" }, {}]) {
		client.notify("test/notification", {
			method: "experimental/serverStatus",
			params,
		});
		await client.request("test/barrier", {});
		assert.equal(ready, false);
	}
	client.notify("test/notification", {
		method: "experimental/serverStatus",
		params: { quiescent: true },
	});
	await waiting;
	await client.waitForProjectInitialization(1);
});

test("LspClient sends save notifications only when requested by the server", (t) => {
	const client = new LspClient(".", {
		languages: [],
		command: "mock-lsp",
		args: [],
	});
	const notify = t.mock.method(client, "notify", () => {});
	const document = { uri: "file:///project/main.rs", text: "fn main() {}" };
	for (const textDocumentSync of [undefined, null, 1, { save: false }]) {
		client.setServerCapabilities({ textDocumentSync });
		client.notifyDocumentSaved(document);
	}
	assert.equal(notify.mock.callCount(), 0);
	client.setServerCapabilities({ textDocumentSync: { save: true } });
	client.notifyDocumentSaved(document);
	assert.deepEqual(notify.mock.calls[0]?.arguments, [
		"textDocument/didSave",
		{ textDocument: { uri: document.uri } },
	]);
	client.setServerCapabilities({
		textDocumentSync: { save: { includeText: true } },
	});
	client.notifyDocumentSaved(document);
	assert.deepEqual(notify.mock.calls[1]?.arguments, [
		"textDocument/didSave",
		{ textDocument: { uri: document.uri }, text: document.text },
	]);
});

test("LspClient preserves best-effort initialization for servers without an explicit deadline", async () => {
	const client = new LspClient(".", {
		languages: [],
		command: "mock-lsp",
		args: [],
		isProjectInitialized: false,
	});
	client.started = true;
	await client.waitForProjectInitialization(5);
});

test("LspClient reports project initialization timeouts", async (t) => {
	const client = await createInitializingClient(t);
	await assert.rejects(
		client.waitForProjectInitialization(20),
		/project initialization timed out after 20ms/,
	);
});

test("LspClient cancels initialization waits without losing the ready notification", async (t) => {
	const client = await createInitializingClient(t);
	const controller = new AbortController();
	const failure = new Error("cancel initialization");
	const cancelled = assert.rejects(
		client.waitForProjectInitialization(undefined, controller.signal),
		(error) => error === failure,
	);
	controller.abort(failure);
	await cancelled;
	const waiting = client.waitForProjectInitialization();
	client.notify("test/notification", {
		method: "workspace/projectInitializationComplete",
		params: {},
	});
	await waiting;
});

test("LspClient rejects initialization waits when the server exits", async (t) => {
	const client = await createInitializingClient(t);
	const stopped = assert.rejects(
		client.waitForProjectInitialization(),
		/exited with/,
	);
	client.notify("exit");
	await stopped;
});

async function createInitializingClient(t: TestContext) {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-lsp-initialization-"));
	const server = path.join(cwd, "server.cjs");
	await writeFile(
		server,
		`
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    const end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString());
    buffer = buffer.subarray(end);
    if (message.method === "test/notification") send(message.params);
    else if (message.method === "exit") process.exit(0);
    else if (message.id !== undefined) send({ id: message.id, result: message.method === "initialize" ? { capabilities: {} } : null });
  }
});
`,
	);
	const config = {
		...rustLspServer,
		command: process.execPath,
		args: [server],
		projectInitializationTimeoutMs: 1_000,
		processDirectory: async () => cwd,
	};
	const client = new LspClient(cwd, config);
	t.after(async () => {
		await client.stop();
		await rm(cwd, { recursive: true, force: true });
	});
	await initializeClient(cwd, client, config, defaultCapabilities());
	return client;
}

async function waitForFile(file: string) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			await access(file);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	assert.fail(`Timed out waiting for ${file}`);
}
