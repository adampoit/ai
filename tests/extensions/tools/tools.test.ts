import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import toolsExtension from "../../../nix/pi-coding-agent/extensions/tools/index.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	RegisteredTool,
} from "../helpers.ts";

const toolNames = ["bash", "edit", "find", "grep", "ls", "read", "write"];

async function executeTool(
	tool: RegisteredTool,
	params: unknown,
	ctx: unknown,
) {
	assert.ok(tool.execute, `Expected ${tool.name} to have execute`);
	return await tool.execute(
		`test-${tool.name}`,
		params,
		AbortSignal.timeout(10_000),
		undefined,
		ctx,
	);
}

test("custom tools extension registers its public surface", () => {
	const pi = loadExtension(toolsExtension);

	assertPublicSurface(pi, { tools: toolNames });
});

test("custom tools extension keeps built-in tool wrappers self-rendering", () => {
	const pi = loadExtension(toolsExtension);

	for (const toolName of toolNames) {
		const tool = pi.tools.get(toolName);
		assert.ok(tool, `Expected ${toolName} to be registered`);
		assert.equal(
			tool.renderShell,
			"self",
			`Expected ${toolName} to self-render`,
		);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
	}
});

test("custom tools extension executes built-in file tools against a fixture directory", async () => {
	const pi = loadExtension(toolsExtension);
	const ctx = await createContext();
	(ctx.model as any).input = ["text"];

	const file = `${ctx.cwd}/notes/example.txt`;
	await executeTool(
		pi.tools.get("write")!,
		{ path: file, content: "hello\nworld\n" },
		ctx,
	);
	assert.equal(
		await readFile(`${ctx.cwd}/notes/example.txt`, "utf8"),
		"hello\nworld\n",
	);

	const read = await executeTool(pi.tools.get("read")!, { path: file }, ctx);
	assert.ok(JSON.stringify(read).includes("hello"), JSON.stringify(read));

	const grep = await executeTool(
		pi.tools.get("grep")!,
		{ pattern: "world", path: `${ctx.cwd}/notes` },
		ctx,
	);
	assert.ok(
		JSON.stringify(grep).includes("example.txt"),
		JSON.stringify(grep),
	);

	const find = await executeTool(
		pi.tools.get("find")!,
		{ pattern: "**/*.txt", path: `${ctx.cwd}/notes` },
		ctx,
	);
	assert.ok(
		JSON.stringify(find).includes("example.txt"),
		JSON.stringify(find),
	);

	const ls = await executeTool(
		pi.tools.get("ls")!,
		{ path: `${ctx.cwd}/notes` },
		ctx,
	);
	assert.ok(JSON.stringify(ls).includes("example.txt"), JSON.stringify(ls));
});

test("custom tools extension edit wrapper preserves built-in edit behavior", async () => {
	const pi = loadExtension(toolsExtension);
	const ctx = await createContext();
	await writeFile(`${ctx.cwd}/editable.txt`, "before\n");

	const result = await executeTool(
		pi.tools.get("edit")!,
		{
			path: `${ctx.cwd}/editable.txt`,
			edits: [{ oldText: "before", newText: "after" }],
		},
		ctx,
	);

	assert.equal(await readFile(`${ctx.cwd}/editable.txt`, "utf8"), "after\n");
	assert.ok(
		JSON.stringify(result).includes("editable.txt"),
		JSON.stringify(result),
	);
});
