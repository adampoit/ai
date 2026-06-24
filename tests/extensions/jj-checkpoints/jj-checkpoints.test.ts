import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertPublicSurface,
	createContext,
	ExecHandler,
	loadExtension,
	runCommand,
} from "../helpers.ts";

async function importJjCheckpointsExtension(home: string) {
	process.env.HOME = home;
	const module = await import(
		`../../../nix/pi-coding-agent/extensions/jj-checkpoints.ts?home=${encodeURIComponent(home)}&t=${Date.now()}`
	);
	return module.default;
}

function createJjExec(repo: string): ExecHandler {
	return async (command, args) => {
		if (command !== "jj") return { code: 1, stdout: "", stderr: "not jj" };
		if (args[0] === "root")
			return { code: 0, stdout: `${repo}\n`, stderr: "" };
		if (args[0] === "status")
			return {
				code: 0,
				stdout: "Working copy changes:\nM file.ts\n",
				stderr: "",
			};
		if (args.join(" ").startsWith("op log"))
			return { code: 0, stdout: "abc123\n", stderr: "" };
		if (args.join(" ") === "op restore abc123")
			return { code: 0, stdout: "restored\n", stderr: "" };
		return {
			code: 1,
			stdout: "",
			stderr: `unexpected jj ${args.join(" ")}`,
		};
	};
}

test("jj-checkpoints extension registers its public surface", async () => {
	const oldHome = process.env.HOME;
	const home = await mkdtemp(path.join(tmpdir(), "pi-jj-home-"));
	try {
		const jjCheckpointsExtension = await importJjCheckpointsExtension(home);
		const pi = loadExtension(jjCheckpointsExtension);

		assertPublicSurface(pi, {
			commands: ["rewind"],
			handlers: ["tool_call"],
		});
	} finally {
		process.env.HOME = oldHome;
	}
});

test("jj-checkpoints records a checkpoint and rewinds repository plus conversation", async () => {
	const oldHome = process.env.HOME;
	const home = await mkdtemp(path.join(tmpdir(), "pi-jj-home-"));
	const repo = path.join(home, "repo");
	let leafId = "leaf-before-tool";
	const navigations: unknown[] = [];
	try {
		const jjCheckpointsExtension = await importJjCheckpointsExtension(home);
		const pi = loadExtension(jjCheckpointsExtension, createJjExec(repo));
		const ctx = await createContext({ cwd: repo });
		ctx.sessionManager.getLeafId = () => leafId;
		ctx.sessionManager.getEntry = (id) =>
			id === "leaf-before-tool" ? { id } : undefined;
		ctx.ui.confirm = async () => true;
		ctx.navigateTree = async (entryId, options) => {
			navigations.push({ entryId, options });
			return { cancelled: false };
		};

		await pi.emit(
			"tool_call",
			{
				toolName: "write",
				input: { path: "src/example.ts" },
			},
			ctx,
		);

		const store = JSON.parse(
			await readFile(
				path.join(home, ".pi/agent/jj-checkpoints.json"),
				"utf8",
			),
		);
		assert.equal(store[repo][0].op, "abc123");
		assert.equal(store[repo][0].tool, "write");
		assert.equal(store[repo][0].summary, "src/example.ts");
		assert.equal(store[repo][0].conversationLeafId, "leaf-before-tool");

		leafId = "leaf-after-tool";
		await runCommand(pi, "rewind", "last", ctx);

		assert.deepEqual(navigations, [
			{ entryId: "leaf-before-tool", options: { summarize: false } },
		]);
		assert.deepEqual(ctx.notifications.at(-1), {
			message: `Restored ${repo} to jj operation abc123`,
			level: "info",
		});
		assert.ok(
			pi.execCalls.some(
				(call) =>
					call.command === "jj" &&
					call.args.join(" ") === "op restore abc123",
			),
		);
	} finally {
		process.env.HOME = oldHome;
	}
});
