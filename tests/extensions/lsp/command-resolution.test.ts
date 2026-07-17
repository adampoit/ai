import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LspManager } from "../../../nix/pi-coding-agent/extensions/lsp/manager.ts";
import { commandPaths } from "../../../nix/pi-coding-agent/extensions/lsp/workspace.ts";

const unixOnly = { skip: process.platform === "win32" };

test(
	"commandPaths returns every executable candidate in PATH order",
	unixOnly,
	async (t) => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-lsp-command-test-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const firstDirectory = path.join(root, "first");
		const secondDirectory = path.join(root, "second");
		const first = await writeExecutable(
			firstDirectory,
			"test-lsp",
			"process.exit(1);",
		);
		const second = await writeExecutable(
			secondDirectory,
			"test-lsp",
			"process.exit(0);",
		);

		const candidates = await commandPaths("test-lsp", {
			PATH: [firstDirectory, secondDirectory, firstDirectory].join(
				path.delimiter,
			),
		});

		assert.deepEqual(candidates, [first, second]);
	},
);

test(
	"LSP startup falls back to a later working executable",
	unixOnly,
	async (t) => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-lsp-command-test-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		await writeFile(
			path.join(root, "main.ts"),
			"export const value = 1;\n",
		);
		const brokenDirectory = path.join(root, "broken");
		const workingDirectory = path.join(root, "working");
		await writeExecutable(
			brokenDirectory,
			"vtsls",
			'console.error("repeated startup failure");\nconsole.error("repeated startup failure");\nprocess.exit(1);',
		);
		const working = await writeExecutable(
			workingDirectory,
			"vtsls",
			workingLspServerSource(),
		);
		const notifications: string[] = [];
		const oldPath = process.env.PATH;
		process.env.PATH = [brokenDirectory, workingDirectory].join(
			path.delimiter,
		);
		const manager = new LspManager(root, undefined, (message) =>
			notifications.push(message),
		);
		t.after(async () => {
			process.env.PATH = oldPath;
			await manager.stop();
		});

		const result = await manager.requestDocumentSymbols("main.ts");

		assert.equal(result.ok, true);
		assert.deepEqual("symbols" in result ? result.symbols : undefined, []);
		assert.deepEqual(notifications, []);
		assert.equal(
			(await manager.getEntries())
				.find((entry) => entry.text.startsWith("- typescript"))
				?.text.includes(`path: ${working}`),
			true,
		);
	},
);

test(
	"LSP startup summarizes failures after all candidates fail",
	unixOnly,
	async (t) => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-lsp-command-test-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		await writeFile(
			path.join(root, "main.ts"),
			"export const value = 1;\n",
		);
		const brokenDirectory = path.join(root, "broken");
		await writeExecutable(
			brokenDirectory,
			"vtsls",
			'["one", "two", "three", "four", "five", "six", "seven", "eight"].forEach((message) => console.error(`failure: ${message}`));\nconsole.error("failure: eight");\nprocess.exit(1);',
		);
		const notifications: string[] = [];
		const oldPath = process.env.PATH;
		process.env.PATH = brokenDirectory;
		const manager = new LspManager(root, undefined, (message) =>
			notifications.push(message),
		);
		t.after(() => {
			process.env.PATH = oldPath;
		});

		const result = await manager.requestDocumentSymbols("main.ts");

		assert.equal(result.ok, false);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /failure: one/);
		assert.match(notifications[0], /; …/);
		assert.ok(notifications[0].length < 1_000);
	},
);

async function writeExecutable(
	directory: string,
	name: string,
	body: string,
): Promise<string> {
	await mkdir(directory, { recursive: true });
	const file = path.join(directory, name);
	await writeFile(file, `#!${process.execPath}\n${body}\n`, "utf8");
	await chmod(file, 0o755);
	return file;
}

function workingLspServerSource(): string {
	return `
if (process.argv.includes("--version")) {
	console.log("test-lsp 1.0.0");
	process.exit(0);
}
let buffer = Buffer.alloc(0);
function send(message) {
	const body = Buffer.from(JSON.stringify(message));
	process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
	process.stdout.write(body);
}
function handle(message) {
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
	} else if (message.method === "textDocument/documentSymbol") {
		send({ jsonrpc: "2.0", id: message.id, result: [] });
	} else if (message.method === "shutdown") {
		send({ jsonrpc: "2.0", id: message.id, result: null });
	}
}
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const length = Number(/Content-Length: (\\d+)/i.exec(header)?.[1]);
		const bodyStart = headerEnd + 4;
		const bodyEnd = bodyStart + length;
		if (buffer.length < bodyEnd) return;
		handle(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
		buffer = buffer.subarray(bodyEnd);
	}
});
`;
}
