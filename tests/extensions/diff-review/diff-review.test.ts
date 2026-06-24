import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import diffReviewExtension from "../../../nix/pi-coding-agent/extensions/diff-review.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	runCommand,
} from "../helpers.ts";

test("diff-review extension registers its public surface", () => {
	const pi = loadExtension(diffReviewExtension);

	assertPublicSurface(pi, { commands: ["review"] });
});

test("diff-review reports that /review requires an interactive UI before probing nvim", async () => {
	const pi = loadExtension(diffReviewExtension);
	const ctx = await createContext({ hasUI: false, mode: "print" });

	await runCommand(pi, "review", "", ctx);

	assert.deepEqual(ctx.notifications, [
		{ message: "/review requires the interactive TUI", level: "error" },
	]);
	assert.deepEqual(pi.execCalls, []);
});

test("diff-review imports a review exported by Neovim", async () => {
	const ctx = await createContext();
	const binDir = path.join(ctx.cwd, "bin");
	const fakeNvim = path.join(binDir, "nvim");
	await mkdir(binDir);
	await writeFile(
		fakeNvim,
		`#!/usr/bin/env node
const fs = require("node:fs");
const init = process.argv[process.argv.indexOf("-S") + 1];
const source = fs.readFileSync(init, "utf8");
const reviewPath = JSON.parse(source.match(/local review_path = (.*)/)[1]);
const diagnosticsPath = JSON.parse(source.match(/local diagnostics_path = (.*)/)[1]);
fs.writeFileSync(reviewPath, "## Review\\n\\n- Looks good from the fake reviewer.\\n");
fs.writeFileSync(diagnosticsPath, JSON.stringify({ status: "saved", thread_count: 1, exported_thread_count: 1 }));
`,
	);
	await chmod(fakeNvim, 0o755);

	const oldPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	try {
		const pi = loadExtension(diffReviewExtension, async (command, args) => {
			if (command === "bash" && args[1]?.includes("command -v")) {
				return { code: 0, stdout: `${fakeNvim}\n`, stderr: "" };
			}
			return { code: 1, stdout: "", stderr: "not mocked" };
		});
		ctx.ui.custom = async (factory: any) => {
			let result: unknown;
			factory(
				{
					stop() {},
					start() {},
					requestRender() {},
				},
				ctx.ui.theme,
				{ matches: () => false },
				(value: unknown) => {
					result = value;
				},
			);
			return result as never;
		};

		await runCommand(pi, "review", "", ctx);
	} finally {
		process.env.PATH = oldPath;
	}

	assert.ok(ctx.editorText?.includes("I reviewed your code"), ctx.editorText);
	assert.ok(
		ctx.editorText?.includes("Looks good from the fake reviewer"),
		ctx.editorText,
	);
	assert.deepEqual(ctx.notifications.at(-1), {
		message: "Inserted Neovim review into the editor.",
		level: "info",
	});
});
