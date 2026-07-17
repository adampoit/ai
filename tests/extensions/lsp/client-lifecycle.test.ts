import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LspClient } from "../../../nix/pi-coding-agent/extensions/lsp/client.ts";

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
