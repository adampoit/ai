import assert from "node:assert/strict";
import test from "node:test";
import taskwarriorExtension, {
	formatTaskContext,
} from "../../../nix/pi-coding-agent/extensions/taskwarrior.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	runCommand,
} from "../helpers.ts";

const pendingTask = {
	id: 42,
	uuid: "12345678-1234-1234-1234-123456789abc",
	description: "Investigate the failing build",
	status: "pending",
	project: "engineering",
	priority: "H",
	tags: ["build", "ci"],
	due: "20260401T170000Z",
	entry: "20260320T120000Z",
	modified: "20260321T130000Z",
	urgency: 12.25,
	annotations: [
		{
			entry: "20260321T140000Z",
			description:
				"Failure started after the dependency update.\nCheck Linux first.",
		},
	],
	jira: "ENG-123",
};

test("taskwarrior extension registers its command and shortcut", () => {
	const pi = loadExtension(taskwarriorExtension);

	assertPublicSurface(pi, {
		commands: ["task"],
		shortcuts: ["ctrl+shift+t"],
	});
});

test("task command selects a pending task and inserts its notes", async () => {
	const pi = loadExtension(taskwarriorExtension, (command, args) => {
		assert.equal(command, "task");
		assert.deepEqual(args, [
			"rc.hooks=off",
			"rc.color=off",
			"+PENDING",
			"export",
		]);
		return { code: 0, stdout: JSON.stringify([pendingTask]), stderr: "" };
	});
	const ctx = await createContext();
	let rendered = "";
	ctx.ui.custom = async (factory: any, options?: unknown) => {
		assert.deepEqual(options, { overlay: false });
		let selected: string | null = null;
		const component = factory(
			{ requestRender() {} },
			{
				...ctx.ui.theme,
				bold: (text: string) => text,
			},
			{},
			(value: string | null) => {
				selected = value;
			},
		);
		rendered = component.render(100).join("\n");
		component.handleInput("\r");
		return selected as never;
	};

	await runCommand(pi, "task", "", ctx);

	assert.match(rendered, /Insert Taskwarrior Context/);
	assert.match(rendered, /Investigate the failing bu/);
	assert.match(ctx.editorText ?? "", /## Taskwarrior Task #42/);
	assert.match(
		ctx.editorText ?? "",
		/Failure started after the dependency update/,
	);
	assert.match(ctx.editorText ?? "", /Check Linux first/);
	assert.match(ctx.editorText ?? "", /\*\*Jira:\*\* ENG-123/);
	assert.deepEqual(ctx.notifications.at(-1), {
		message: "Inserted Taskwarrior task 42.",
		level: "info",
	});
});

test("task command accepts a task ID and appends to existing editor text", async () => {
	const pi = loadExtension(taskwarriorExtension, (_command, args) => {
		assert.deepEqual(args, ["rc.hooks=off", "42", "export"]);
		return { code: 0, stdout: JSON.stringify([pendingTask]), stderr: "" };
	});
	const ctx = await createContext();
	ctx.ui.setEditorText("Please fix this task.");

	await runCommand(pi, "task", "42", ctx);

	assert.ok(ctx.editorText?.startsWith("Please fix this task.\n\n"));
	assert.match(ctx.editorText ?? "", /\*\*UUID:\*\* 12345678/);
});

test("task command rejects filters instead of passing them to Taskwarrior", async () => {
	const pi = loadExtension(taskwarriorExtension, () => {
		throw new Error("task should not run");
	});
	const ctx = await createContext();

	await runCommand(pi, "task", "project:engineering", ctx);

	assert.equal(pi.execCalls.length, 0);
	assert.deepEqual(ctx.notifications.at(-1), {
		message: "Use a numeric task ID or full UUID",
		level: "error",
	});
});

test("formatTaskContext makes missing notes explicit", () => {
	const context = formatTaskContext({
		id: 7,
		uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		description: "A task without annotations",
	});

	assert.match(context, /### Notes\n\n_No notes\._/);
});
