import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

type TaskwarriorAnnotation = {
	entry?: string;
	description?: string;
};

type TaskwarriorTask = {
	id?: number;
	uuid?: string;
	description?: string;
	status?: string;
	project?: string;
	priority?: string;
	tags?: string[];
	annotations?: TaskwarriorAnnotation[];
	urgency?: number;
	[key: string]: unknown;
};

const TASK_REFERENCE_PATTERN =
	/^(?:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
const DATE_FIELDS = new Set([
	"due",
	"end",
	"entry",
	"modified",
	"scheduled",
	"start",
	"until",
	"wait",
]);
const DISPLAYED_FIELDS = new Set([
	"annotations",
	"description",
	"depends",
	"due",
	"end",
	"entry",
	"id",
	"modified",
	"parent",
	"priority",
	"project",
	"recur",
	"rtype",
	"scheduled",
	"start",
	"status",
	"tags",
	"until",
	"urgency",
	"uuid",
	"wait",
]);

function formatTaskwarriorDate(value: unknown): string {
	if (typeof value !== "string") return String(value);
	const compact = value.match(
		/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
	);
	if (!compact) return value;
	return `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}:${compact[6]} UTC`;
}

function formatValue(value: unknown): string {
	if (Array.isArray(value)) return value.map(formatValue).join(", ");
	if (value !== null && typeof value === "object") {
		return JSON.stringify(value);
	}
	return String(value);
}

function formatMultiline(value: string, indent = "  "): string {
	return value.replace(/\r\n?/g, "\n").replace(/\n/g, `\n${indent}`);
}

function fieldLabel(field: string): string {
	return field
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatTaskContext(task: TaskwarriorTask): string {
	const reference =
		task.id !== undefined ? `#${task.id}` : (task.uuid ?? "unknown");
	const lines = [
		`## Taskwarrior Task ${reference}`,
		"",
		`- **Description:** ${formatMultiline(task.description ?? "(none)")}`,
	];
	const fields: Array<[string, unknown]> = [
		["ID", task.id],
		["UUID", task.uuid],
		["Status", task.status],
		["Project", task.project],
		["Priority", task.priority],
		["Tags", task.tags],
		["Due", task.due],
		["Scheduled", task.scheduled],
		["Wait", task.wait],
		["Until", task.until],
		["Start", task.start],
		["Entry", task.entry],
		["Modified", task.modified],
		["End", task.end],
		["Depends", task.depends],
		["Parent", task.parent],
		["Recurrence", task.recur],
		["Recurrence type", task.rtype],
		["Urgency", task.urgency],
	];

	for (const [label, value] of fields) {
		if (value === undefined || value === null || value === "") continue;
		const formatted = DATE_FIELDS.has(label.toLowerCase())
			? formatTaskwarriorDate(value)
			: formatValue(value);
		lines.push(`- **${label}:** ${formatMultiline(formatted)}`);
	}

	const additionalFields = Object.entries(task).filter(
		([field, value]) =>
			!DISPLAYED_FIELDS.has(field) &&
			value !== undefined &&
			value !== null,
	);
	if (additionalFields.length > 0) {
		lines.push("", "### Additional fields", "");
		for (const [field, value] of additionalFields) {
			lines.push(
				`- **${fieldLabel(field)}:** ${formatMultiline(formatValue(value))}`,
			);
		}
	}

	lines.push("", "### Notes", "");
	if (!task.annotations?.length) {
		lines.push("_No notes._");
	} else {
		for (const annotation of task.annotations) {
			const timestamp = annotation.entry
				? ` **${formatTaskwarriorDate(annotation.entry)}**`
				: "";
			const description = formatMultiline(
				annotation.description ?? "(empty note)",
				"  ",
			);
			lines.push(`-${timestamp}\n  ${description}`);
		}
	}

	return lines.join("\n");
}

function parseTasks(stdout: string): TaskwarriorTask[] {
	const parsed: unknown = JSON.parse(stdout);
	const values = Array.isArray(parsed) ? parsed : [parsed];
	return values.filter(
		(value): value is TaskwarriorTask =>
			value !== null &&
			typeof value === "object" &&
			("uuid" in value || "description" in value),
	);
}

async function loadTasks(
	pi: ExtensionAPI,
	reference: string | undefined,
	signal: AbortSignal | undefined,
): Promise<TaskwarriorTask[]> {
	const args = reference
		? ["rc.hooks=off", reference, "export"]
		: ["rc.hooks=off", "rc.color=off", "+PENDING", "export"];
	const result = await pi.exec("task", args, { signal, timeout: 10_000 });
	if (result.code !== 0) {
		throw new Error(
			result.stderr.trim() || `task exited with code ${result.code}`,
		);
	}

	try {
		return parseTasks(result.stdout);
	} catch (error) {
		throw new Error(
			`Taskwarrior returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function taskSelectDescription(task: TaskwarriorTask): string {
	const details: string[] = [];
	if (task.project) details.push(`project:${task.project}`);
	if (task.priority) details.push(`priority:${task.priority}`);
	if (task.due) details.push(`due:${formatTaskwarriorDate(task.due)}`);
	if (task.tags?.length) details.push(`tags:${task.tags.join(",")}`);
	if (task.annotations?.length) {
		details.push(
			`${task.annotations.length} note${task.annotations.length === 1 ? "" : "s"}`,
		);
	}
	if (task.urgency !== undefined)
		details.push(`urgency:${task.urgency.toFixed(1)}`);
	return details.join(" · ");
}

async function selectTask(
	ctx: ExtensionContext,
	tasks: TaskwarriorTask[],
): Promise<TaskwarriorTask | undefined> {
	const sortedTasks = [...tasks].sort(
		(a, b) => (b.urgency ?? 0) - (a.urgency ?? 0),
	);
	const tasksByValue = new Map<string, TaskwarriorTask>();
	const items: SelectItem[] = sortedTasks.map((task, index) => {
		const value = task.uuid ?? String(task.id ?? index);
		tasksByValue.set(value, task);
		return {
			value,
			label: `${task.id === undefined ? "" : `#${task.id} `}${task.description ?? "(no description)"}`,
			description: taskSelectDescription(task),
		};
	});

	const selected = await ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(
				new DynamicBorder((text: string) => theme.fg("accent", text)),
			);
			container.addChild(
				new Text(
					theme.fg(
						"accent",
						theme.bold("Insert Taskwarrior Context"),
					),
					1,
					0,
				),
			);

			const list = new SelectList(items, Math.min(items.length, 14), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						"type to search • ↑↓ navigate • enter insert • esc cancel",
					),
					1,
					0,
				),
			);
			container.addChild(
				new DynamicBorder((text: string) => theme.fg("accent", text)),
			);

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: false },
	);

	return selected ? tasksByValue.get(selected) : undefined;
}

function insertIntoEditor(ctx: ExtensionContext, task: TaskwarriorTask): void {
	const context = formatTaskContext(task);
	const currentText = ctx.ui.getEditorText();
	ctx.ui.setEditorText(
		currentText.trim().length > 0
			? `${currentText.trimEnd()}\n\n${context}`
			: context,
	);
	ctx.ui.notify(
		`Inserted Taskwarrior task ${task.id ?? task.uuid ?? "context"}.`,
		"info",
	);
}

async function insertTask(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reference?: string,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Task selection requires TUI mode", "error");
		return;
	}
	if (reference && !TASK_REFERENCE_PATTERN.test(reference)) {
		ctx.ui.notify("Use a numeric task ID or full UUID", "error");
		return;
	}

	let tasks: TaskwarriorTask[];
	try {
		tasks = await loadTasks(pi, reference, ctx.signal);
	} catch (error) {
		ctx.ui.notify(
			`Unable to load Taskwarrior tasks: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	if (tasks.length === 0) {
		ctx.ui.notify(
			reference
				? `Task ${reference} was not found`
				: "No pending Taskwarrior tasks",
			"warning",
		);
		return;
	}

	const task = reference ? tasks[0] : await selectTask(ctx, tasks);
	if (task) insertIntoEditor(ctx, task);
}

export default function taskwarriorExtension(pi: ExtensionAPI): void {
	pi.registerCommand("task", {
		description:
			"Select a Taskwarrior task and insert its details and notes",
		handler: async (args, ctx) => {
			await insertTask(pi, ctx, args.trim() || undefined);
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Insert Taskwarrior task context",
		handler: async (ctx) => {
			await insertTask(pi, ctx);
		},
	});
}
