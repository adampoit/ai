import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	Input,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	BlockFrame,
	gruvbox,
	KeyHintLine,
	renderBadge,
} from "../components/index.ts";
import type { Focusable } from "@earendil-works/pi-tui";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const storePath = join(homedir(), ".pi", "agent", "jj-checkpoints.json");
const maxCheckpointsPerRepo = 200;

type Checkpoint = {
	repo: string;
	op: string;
	time: string;
	tool: string;
	summary: string;
	/** Session file where this checkpoint was captured. */
	sessionFile?: string;
	/** Conversation leaf before the tool ran. */
	conversationLeafId?: string;
};

type Store = Record<string, Checkpoint[]>;

async function readStore(): Promise<Store> {
	try {
		return JSON.parse(await readFile(storePath, "utf8"));
	} catch {
		return {};
	}
}

async function writeStore(store: Store): Promise<void> {
	await mkdir(dirname(storePath), { recursive: true });
	const tempPath = `${storePath}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`);
	await rename(tempPath, storePath);
}

async function runJj(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	ctx?: ExtensionContext,
) {
	return await pi.exec("jj", args, {
		cwd,
		signal: ctx?.signal,
		timeout: 5000,
	});
}

async function getRepoRoot(
	pi: ExtensionAPI,
	cwd: string,
	ctx?: ExtensionContext,
): Promise<string | undefined> {
	const result = await runJj(pi, cwd, ["root"], ctx);
	if (result.code !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

async function getCurrentOp(
	pi: ExtensionAPI,
	repo: string,
	ctx?: ExtensionContext,
): Promise<string | undefined> {
	const result = await runJj(
		pi,
		repo,
		[
			"op",
			"log",
			"--limit",
			"1",
			"--no-graph",
			"--color=never",
			"-T",
			'id.short() ++ "\\n"',
		],
		ctx,
	);
	if (result.code !== 0) return undefined;
	return result.stdout.trim().split(/\s+/)[0];
}

function stringField(
	input: Record<string, unknown>,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const value = input[name];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function summarizeToolCall(event: ToolCallEvent): string {
	const input = event.input as Record<string, unknown>;
	if (event.toolName === "bash")
		return stringField(input, "command") ?? "bash";
	if (event.toolName === "read")
		return stringField(input, "path", "filePath") ?? "read";
	if (event.toolName === "edit")
		return stringField(input, "path", "filePath") ?? "edit";
	if (event.toolName === "write")
		return stringField(input, "path", "filePath") ?? "write";
	if (event.toolName === "lsp_diagnostics") {
		const files = input.files;
		if (Array.isArray(files) && files.length > 0) return files.join(", ");
	}
	return event.toolName;
}

function normalizeDisplayText(text: string): string {
	return text
		.replace(/[\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function shortenPath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash": {
			const command = normalizeDisplayText(
				String(args.command || ""),
			).slice(0, 50);
			return `[bash: ${command}${command.length === 50 ? "..." : ""}]`;
		}
		case "read": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			const offset = args.offset;
			const limit = args.limit;
			let display = path;
			if (offset !== undefined || limit !== undefined) {
				const start = Number(offset ?? 1);
				const end =
					limit !== undefined ? start + Number(limit) - 1 : "";
				display += `:${start}${end ? `-${end}` : ""}`;
			}
			return `[read: ${display}]`;
		}
		case "edit": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			return `[edit: ${path}]`;
		}
		case "write": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			return `[write: ${path}]`;
		}
		case "lsp_diagnostics": {
			const files = args.files;
			const display = Array.isArray(files)
				? files.join(", ")
				: String(args.path || args.command || "lsp_diagnostics");
			const summary = normalizeDisplayText(display).slice(0, 50);
			return `[lsp_diagnostics: ${summary}${summary.length === 50 ? "..." : ""}]`;
		}
		default:
			return `[${name}]`;
	}
}

function checkpointToolLabel(checkpoint: Checkpoint): string {
	return formatToolCall(checkpoint.tool, {
		command: checkpoint.summary,
		path: checkpoint.summary,
		files: [checkpoint.summary],
	});
}

function checkpointLabel(checkpoint: Checkpoint): string {
	return `• ${checkpointToolLabel(checkpoint)}`;
}

type RewindRow = {
	id: string;
	text: string;
	searchText: string;
	kind: "message" | "tool" | "other";
	checkpoint?: Checkpoint;
};

function entryText(entry: SessionEntry): string {
	if (entry.type !== "message") return `[${entry.type}]`;
	const message = entry.message;
	if (message.role === "user" || message.role === "assistant") {
		const content = normalizeDisplayText(
			extractMessageText((message as { content?: unknown }).content),
		).slice(0, 200);
		return `${message.role}: ${content || "(no content)"}`;
	}
	if (message.role === "bashExecution") {
		return `[bash]: ${normalizeDisplayText(String((message as { command?: unknown }).command ?? ""))}`;
	}
	if (message.role === "toolResult") return "[tool result]";
	return `[${message.role}]`;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

function entryToolCalls(entry: SessionEntry): ToolCallBlock[] {
	if (entry.type !== "message" || entry.message.role !== "assistant")
		return [];
	const content = (entry.message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is ToolCallBlock =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "toolCall" &&
			"name" in block &&
			typeof block.name === "string" &&
			"arguments" in block &&
			typeof block.arguments === "object" &&
			block.arguments !== null,
	);
}

type ToolCallBlock = {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
};

function buildRewindRows(
	ctx: ExtensionCommandContext,
	checkpoints: Checkpoint[],
): RewindRow[] {
	const unused = [...checkpoints];
	const rows: RewindRow[] = [];
	const branch = ctx.sessionManager.getBranch();

	for (const entry of branch) {
		const toolCalls = entryToolCalls(entry);
		if (toolCalls.length > 0) {
			for (const toolCall of toolCalls) {
				const checkpointIndex = unused.findIndex(
					(checkpoint) =>
						checkpoint.conversationLeafId === entry.id &&
						checkpoint.tool === toolCall.name,
				);
				const checkpoint =
					checkpointIndex >= 0
						? unused.splice(checkpointIndex, 1)[0]
						: undefined;
				const op = checkpoint ? `  ${checkpoint.op}` : "";
				const text = `• ${formatToolCall(toolCall.name, toolCall.arguments)}${op}`;
				rows.push({
					id: `${entry.id}:${toolCall.name}:${rows.length}`,
					text,
					searchText: text,
					kind: "tool",
					checkpoint,
				});
			}
			continue;
		}

		if (entry.type === "message" && entry.message.role !== "toolResult") {
			const text = `• ${entryText(entry)}`;
			rows.push({
				id: entry.id,
				text,
				searchText: text,
				kind: "message",
			});
		}
	}

	for (const checkpoint of unused) {
		const text = `${checkpointLabel(checkpoint)}  ${checkpoint.op}`;
		rows.push({
			id: `${checkpoint.op}:${checkpoint.time}`,
			text,
			searchText: text,
			kind: "tool",
			checkpoint,
		});
	}

	return rows;
}

class RewindSelector extends Container implements Focusable {
	private search = new Input();
	private selectedIndex = 0;
	private filteredRows: RewindRow[] = [];
	private focusedValue = false;

	constructor(
		private rows: RewindRow[],
		private theme: ExtensionCommandContext["ui"]["theme"],
		private done: (row: RewindRow | undefined) => void,
		private maxVisibleLines: number,
	) {
		super();
		this.filteredRows = rows;
		this.search.onSubmit = () => this.selectCurrent();
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.search.focused = value;
	}

	invalidate(): void {}

	private applyFilter(): void {
		const query = this.search.getValue().toLowerCase().trim();
		const tokens = query.split(/\s+/).filter(Boolean);
		this.filteredRows = tokens.length
			? this.rows.filter((row) =>
					tokens.every((token) =>
						row.searchText.toLowerCase().includes(token),
					),
				)
			: this.rows;
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredRows.length - 1),
		);
	}

	private selectCurrent(): void {
		const row = this.filteredRows[this.selectedIndex];
		if (!row) return;
		if (row.checkpoint) this.done(row);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(
				this.filteredRows.length - 1,
				this.selectedIndex + 1,
			);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(
				0,
				this.selectedIndex - this.maxVisibleLines,
			);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(
				this.filteredRows.length - 1,
				this.selectedIndex + this.maxVisibleLines,
			);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.selectCurrent();
			return;
		}

		this.search.handleInput(data);
		this.applyFilter();
	}

	render(width: number): string[] {
		const checkpointCount = this.rows.filter(
			(row) => row.checkpoint,
		).length;
		return new BlockFrame(
			{
				invalidate() {},
				render: (contentWidth: number) => this.renderBody(contentWidth),
			},
			{
				title: {
					title: "Rewind Checkpoints",
					icon: "⟲",
					accent: gruvbox.yellow,
					badges: [
						{
							text: `${checkpointCount} checkpoints`,
							bg: gruvbox.bg2,
						},
						{
							text: `${this.filteredRows.length}/${this.rows.length}`,
							bg: gruvbox.bg2,
						},
					],
					theme: this.theme,
				},
				borderColor: gruvbox.yellow,
				background: gruvbox.bg1,
				theme: this.theme,
				paddingX: 1,
				paddingY: 1,
			},
		).render(width);
	}

	private renderBody(width: number): string[] {
		const lines: string[] = [];
		lines.push(
			...new KeyHintLine(
				[
					{ key: "↑↓", label: "move" },
					{ key: "←→", label: "page" },
					{ key: "enter", label: "restore checkpoint" },
					{ key: "esc", label: "cancel" },
				],
				{ theme: this.theme, accent: gruvbox.yellow },
			).render(width),
		);
		lines.push("", this.theme.fg("muted", "Type to search:"));
		lines.push(...this.search.render(width));
		lines.push("");

		if (this.filteredRows.length === 0) {
			lines.push(this.theme.fg("muted", "No entries found"));
			lines.push(this.theme.fg("muted", "(0/0)"));
			return lines;
		}

		const maxRows = Math.max(1, this.maxVisibleLines);
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxRows / 2),
				this.filteredRows.length - maxRows,
			),
		);
		const end = Math.min(start + maxRows, this.filteredRows.length);
		for (let index = start; index < end; index++) {
			const row = this.filteredRows[index]!;
			const selected = index === this.selectedIndex;
			const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
			let text = row.text;
			if (row.kind === "tool") text = this.theme.fg("muted", text);
			if (row.kind === "message" && row.text.includes("assistant:")) {
				text = row.text.replace(
					"assistant:",
					this.theme.fg("success", "assistant:"),
				);
			}
			if (row.kind === "message" && row.text.includes("user:")) {
				text = row.text.replace(
					"user:",
					this.theme.fg("accent", "user:"),
				);
			}
			if (row.checkpoint) {
				text += ` ${renderBadge({
					text: "checkpoint",
					icon: "⟲",
					fg: gruvbox.bg,
					bg: gruvbox.green,
					theme: this.theme,
					paddingX: 1,
				})}`;
			}
			let line = cursor + text;
			if (selected) line = this.theme.bg("selectedBg", line);
			lines.push(truncateToWidth(line, width));
		}
		lines.push(
			this.theme.fg(
				"muted",
				`(${this.selectedIndex + 1}/${this.filteredRows.length})`,
			),
		);
		return lines;
	}
}

async function selectCheckpoint(
	ctx: ExtensionCommandContext,
	checkpoints: Checkpoint[],
): Promise<Checkpoint | undefined> {
	const row = await ctx.ui.custom<RewindRow | undefined>(
		(tui, theme, _keybindings, done) =>
			new RewindSelector(
				buildRewindRows(ctx, checkpoints),
				theme,
				done,
				Math.max(
					8,
					((tui as { terminal?: { rows?: number } }).terminal?.rows ??
						30) - 10,
				),
			),
		{ overlay: false },
	);
	return row?.checkpoint;
}

function sessionCheckpoints(
	ctx: ExtensionCommandContext,
	checkpoints: Checkpoint[],
): Checkpoint[] {
	const sessionFile = ctx.sessionManager.getSessionFile();
	return checkpoints.filter(
		(checkpoint) =>
			checkpoint.sessionFile !== undefined &&
			checkpoint.sessionFile === sessionFile,
	);
}

async function addCheckpoint(checkpoint: Checkpoint): Promise<void> {
	const store = await readStore();
	const checkpoints = store[checkpoint.repo] ?? [];
	const latest = checkpoints[0];
	if (
		latest?.op === checkpoint.op &&
		latest.conversationLeafId === checkpoint.conversationLeafId &&
		latest.tool === checkpoint.tool
	) {
		return;
	}
	store[checkpoint.repo] = [checkpoint, ...checkpoints].slice(
		0,
		maxCheckpointsPerRepo,
	);
	await writeStore(store);
}

async function createCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: ToolCallEvent,
): Promise<void> {
	const repo = await getRepoRoot(pi, ctx.cwd, ctx);
	if (!repo) return;

	const status = await runJj(pi, repo, ["status"], ctx);
	if (status.code !== 0) return;

	const op = await getCurrentOp(pi, repo, ctx);
	if (!op) return;

	await addCheckpoint({
		repo,
		op,
		time: new Date().toISOString(),
		tool: event.toolName,
		summary: summarizeToolCall(event).slice(0, 120),
		sessionFile: ctx.sessionManager.getSessionFile(),
		conversationLeafId: ctx.sessionManager.getLeafId() ?? undefined,
	});
}

async function restoreCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: string,
	checkpoint: Checkpoint,
): Promise<void> {
	if (
		checkpoint.sessionFile === undefined ||
		checkpoint.sessionFile !== ctx.sessionManager.getSessionFile()
	) {
		ctx.ui.notify(
			`Refusing to restore checkpoint ${checkpoint.op} from another session`,
			"error",
		);
		return;
	}

	const ok = await ctx.ui.confirm(
		"Restore jj operation?",
		`Restore ${repo} to operation ${checkpoint.op}? This creates a new jj restore operation and may undo later repository operations.`,
	);
	if (!ok) return;

	const result = await runJj(pi, repo, ["op", "restore", checkpoint.op], ctx);
	if (result.code !== 0) {
		ctx.ui.notify(
			result.stderr || `Failed to restore ${checkpoint.op}`,
			"error",
		);
		return;
	}

	if (checkpoint.conversationLeafId) {
		if (!ctx.sessionManager.getEntry(checkpoint.conversationLeafId)) {
			ctx.ui.notify(
				`Restored jj operation ${checkpoint.op}, but conversation checkpoint no longer exists in this session`,
				"warning",
			);
		} else if (
			ctx.sessionManager.getLeafId() !== checkpoint.conversationLeafId
		) {
			const navigation = await ctx.navigateTree(
				checkpoint.conversationLeafId,
				{
					summarize: false,
				},
			);
			if (navigation.cancelled) {
				ctx.ui.notify(
					`Restored jj operation ${checkpoint.op}, but conversation rewind was cancelled`,
					"warning",
				);
				return;
			}
		}
	} else {
		ctx.ui.notify(
			`Restored jj operation ${checkpoint.op}; this older checkpoint has no conversation position`,
			"warning",
		);
	}

	ctx.ui.notify(`Restored ${repo} to jj operation ${checkpoint.op}`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		await createCheckpoint(pi, ctx, event);
	});

	pi.registerCommand("rewind", {
		description:
			"Restore this jj repo to a checkpoint captured before an agent change",
		handler: async (args, ctx) => {
			const repo = await getRepoRoot(pi, ctx.cwd, ctx);
			if (!repo) {
				ctx.ui.notify("Not in a jj repository", "warning");
				return;
			}

			const allCheckpoints = (await readStore())[repo] ?? [];
			const checkpoints = sessionCheckpoints(ctx, allCheckpoints);
			if (checkpoints.length === 0) {
				ctx.ui.notify(
					"No jj checkpoints recorded for this repo in this session",
					"warning",
				);
				return;
			}

			const target = args.trim();
			let checkpoint: Checkpoint | undefined;
			if (target === "last") {
				checkpoint = checkpoints[0];
			} else if (target) {
				checkpoint = checkpoints.find((item) =>
					item.op.startsWith(target),
				);
			} else {
				checkpoint = await selectCheckpoint(ctx, checkpoints);
				if (!checkpoint) return;
			}

			if (!checkpoint) {
				ctx.ui.notify(
					`No matching jj checkpoint: ${target}`,
					"warning",
				);
				return;
			}

			await restoreCheckpoint(pi, ctx, repo, checkpoint);
		},
	});
}
