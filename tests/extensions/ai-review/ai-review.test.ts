import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import aiReviewExtension from "../../../nix/pi-coding-agent/extensions/ai-review.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	runCommand,
} from "../helpers.ts";

function luaAssignedString(source: string, name: string): string {
	const match = source.match(new RegExp(`local ${name} = (.*)`));
	assert.ok(match, `expected ${name} assignment`);
	return JSON.parse(match[1]);
}

test("ai-review extension registers its public surface", () => {
	const pi = loadExtension(aiReviewExtension);

	assertPublicSurface(pi, {
		commands: ["ai-review"],
		tools: ["submit_ai_review_feedback"],
		handlers: ["agent_end"],
	});
});

test("ai-review reports that /ai-review requires an interactive UI before probing nvim", async () => {
	const pi = loadExtension(aiReviewExtension);
	const ctx = await createContext({ hasUI: false, mode: "print" });

	await runCommand(pi, "ai-review", "", ctx);

	assert.deepEqual(ctx.notifications, [
		{ message: "/ai-review requires the interactive TUI", level: "error" },
	]);
	assert.deepEqual(pi.execCalls, []);
});

test("ai-review selects a target, queues review prompt, and imports submitted feedback", async () => {
	const ctx = await createContext();
	const binDir = path.join(ctx.cwd, "bin");
	const fakeNvim = path.join(binDir, "nvim");
	await mkdir(binDir);
	await writeFile(
		fakeNvim,
		`#!/usr/bin/env node
const fs = require("node:fs");
const selectionPath = process.argv.at(-1).match(/agent-select (.*)$/)[1];
fs.writeFileSync(selectionPath, JSON.stringify({
  schema: "unified-review.agent-selection.v1",
  selected_at: "run-123",
  label: "Current jj change",
  target: { kind: "jj", base: "trunk()", head: "@" }
}));
`,
	);
	await chmod(fakeNvim, 0o755);

	const oldPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	try {
		const pi = loadExtension(aiReviewExtension, async (command, args) => {
			if (command === "bash" && args[1]?.includes("command -v")) {
				return { code: 0, stdout: `${fakeNvim}\n`, stderr: "" };
			}
			if (command === "nvim") {
				const initPath = args[args.indexOf("-S") + 1];
				const source = await readFile(initPath, "utf8");
				if (source.includes("write_context")) {
					const contextPath = luaAssignedString(
						source,
						"context_path",
					);
					await writeFile(
						contextPath,
						JSON.stringify({
							schema: "unified-review.agent-context.v1",
							session: { id: "s1", kind: "local_jj" },
							files: [
								{ path: "a.lua", raw_patch: "@@ -1 +1 @@" },
							],
						}),
					);
					return { code: 0, stdout: "", stderr: "" };
				}
				if (source.includes("import_file")) {
					const diagnosticsPath = luaAssignedString(
						source,
						"diagnostics_path",
					);
					await writeFile(
						diagnosticsPath,
						JSON.stringify({
							status: "imported",
							result: {
								imported_comments: 1,
								updated_threads: 0,
								skipped: [],
							},
						}),
					);
					return { code: 0, stdout: "", stderr: "" };
				}
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

		await runCommand(pi, "ai-review", "", ctx);

		assert.equal(pi.sentUserMessages.length, 1);
		assert.match(
			(pi.sentUserMessages[0] as { content: string }).content,
			/submit_ai_review_feedback/,
		);
		assert.match(
			(pi.sentUserMessages[0] as { content: string }).content,
			/a\.lua/,
		);

		const tool = pi.tools.get("submit_ai_review_feedback");
		assert.ok(tool?.execute);
		const result = await tool.execute(
			"tool-1",
			{
				schema: "unified-review.agent-feedback.v1",
				summary: "Found one issue.",
				comments: [
					{
						id: "c1",
						body: "Please check this line.",
						target: {
							kind: "line",
							path: "a.lua",
							side: "right",
							line: 1,
						},
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		assert.deepEqual(ctx.notifications.at(-1), {
			message: "Imported 1 AI review comment(s), updated 0, skipped 0.",
			level: "info",
		});
		assert.match(JSON.stringify(result), /Imported 1 AI review/);

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(ctx.notifications.at(-1), {
			message: "Imported 1 AI review comment(s), updated 0, skipped 0.",
			level: "info",
		});
	} finally {
		process.env.PATH = oldPath;
	}
});
