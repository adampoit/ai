import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import test from "node:test";
import autoformatExtension from "../../../nix/pi-coding-agent/extensions/autoformat.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	ExecHandler,
	runCommand,
} from "../helpers.ts";

function createAutoformatExec(): ExecHandler {
	return async (command, args) => {
		if (command === "git" && args.join(" ").startsWith("ls-files")) {
			return {
				code: 0,
				stdout: ["package.json", "src/main.py", "README.md"].join("\n"),
				stderr: "",
			};
		}
		if (command === "git" && args.join(" ").startsWith("status")) {
			return { code: 0, stdout: " M package.json\n", stderr: "" };
		}
		if (command === "bash" && args[1]?.includes("command -v")) {
			const requested = args.at(-1);
			return requested === "prettier" || requested === "ruff"
				? { code: 0, stdout: `/mock/bin/${requested}\n`, stderr: "" }
				: { code: 1, stdout: "", stderr: "" };
		}
		if (basename(command) === "prettier") {
			const file = args.at(-1);
			if (typeof file !== "string")
				throw new Error("missing prettier file");
			await writeFile(file, '{\n\t"a": 1,\n\t"b": 2\n}\n');
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "diff") {
			return {
				code: 1,
				stdout: '--- a/package.json\n+++ b/package.json\n@@ -1 +1,4 @@\n-{"b":2,"a":1}\n+{\n+\t"a": 1,\n+\t"b": 2\n+}\n',
				stderr: "",
			};
		}
		if (command.startsWith("/mock/bin/")) {
			return {
				code: 0,
				stdout: `${basename(command)} 1.0.0\n`,
				stderr: "",
			};
		}
		return { code: 1, stdout: "", stderr: `${command} not mocked` };
	};
}

async function waitFor(condition: () => boolean) {
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("condition was not met before timeout");
}

test("autoformat extension registers its public surface", () => {
	const pi = loadExtension(autoformatExtension);

	assertPublicSurface(pi, {
		commands: ["formatters"],
		handlers: [
			"session_shutdown",
			"session_start",
			"tool_result",
			"turn_end",
		],
	});
});

test("autoformat reports detected formatter availability on session start", async () => {
	const pi = loadExtension(autoformatExtension, createAutoformatExec());
	const ctx = await createContext();

	await pi.emit("session_start", { reason: "startup" }, ctx);
	await waitFor(() =>
		ctx.statuses.some(([, status]) => status?.includes("prettier")),
	);

	const finalStatus = ctx.statuses.at(-1)?.[1] ?? "";
	assert.ok(finalStatus.includes(" prettier"), finalStatus);
	assert.ok(finalStatus.includes(" ruff"), finalStatus);
});

test("autoformat command renders configured formatter details", async () => {
	const pi = loadExtension(autoformatExtension, createAutoformatExec());
	const rendered: string[] = [];
	const ctx = await createContext();
	ctx.ui.custom = async (factory: any) => {
		const view = factory(
			{ requestRender() {} },
			ctx.ui.theme,
			{ matches: () => false },
			() => {},
		);
		rendered.push(...view.render(100));
		return undefined as never;
	};

	await runCommand(pi, "formatters", "", ctx);

	const output = rendered.join("\n");
	assert.ok(output.includes("formatters"), output);
	assert.ok(output.includes("prettier"), output);
	assert.ok(output.includes("detected because of package.json"), output);
});

test("autoformat formats edit results and adds a formatter diff", async () => {
	const pi = loadExtension(autoformatExtension, createAutoformatExec());
	const ctx = await createContext();
	const file = `${ctx.cwd}/package.json`;
	await writeFile(file, '{"b":2,"a":1}\n');

	const [patch] = await pi.emit(
		"tool_result",
		{
			toolName: "edit",
			input: { path: "package.json" },
			content: [{ type: "text", text: "Edited package.json" }],
			details: { originalContent: '{"b":2,"a":1}\n' },
		},
		ctx,
	);

	assert.equal(await readFile(file, "utf8"), '{\n\t"a": 1,\n\t"b": 2\n}\n');
	assert.ok(JSON.stringify(patch).includes("autoformatted with prettier"));
	assert.equal((patch as any).details.formatter, "prettier");
	assert.ok((patch as any).details.diff.includes("--- a/package.json"));
});

test("autoformat formats modified files at turn end", async () => {
	const pi = loadExtension(autoformatExtension, createAutoformatExec());
	const ctx = await createContext();
	const file = `${ctx.cwd}/package.json`;
	await writeFile(file, '{"b":2,"a":1}\n');

	await pi.emit("turn_end", { turnIndex: 0 }, ctx);

	assert.equal(await readFile(file, "utf8"), '{\n\t"a": 1,\n\t"b": 2\n}\n');
	assert.deepEqual(ctx.notifications.at(-1), {
		message: "Autoformatted 1 file: package.json (prettier)",
		level: "info",
	});
});

test("autoformat clears its status during session shutdown", async () => {
	const pi = loadExtension(autoformatExtension);
	const ctx = await createContext();

	await pi.emit("session_shutdown", { reason: "quit" }, ctx);

	assert.deepEqual(ctx.statuses, [["autoformat", ""]]);
});
