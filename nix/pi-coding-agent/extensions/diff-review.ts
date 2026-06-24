import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

async function tryExec(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	args: string[],
	timeout = 5000,
): Promise<ExecResult | undefined> {
	try {
		return await pi.exec(command, args, { cwd, timeout });
	} catch {
		return undefined;
	}
}

async function commandExists(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
): Promise<boolean> {
	const result = await tryExec(
		pi,
		cwd,
		"bash",
		["-lc", 'command -v "$1"', "--", command],
		2000,
	);
	return result?.code === 0;
}

function formatLocalReviewForAgent(review: string): string {
	return [
		"I reviewed your code and have the following comments. Please address them.",
		"",
		review.trim(),
		"",
		"<sub>Reviewed locally with Neovim and unified-review.nvim.</sub>",
	].join("\n");
}

type NvimRunResult = {
	exitCode: number | null;
	stderr: string;
	error?: string;
	signal?: NodeJS.Signals | null;
};

type NvimDiagnostics = {
	status?: string;
	message?: string;
	path?: string;
	format?: string;
	bytes?: number;
	thread_count?: number;
	exported_thread_count?: number;
	empty?: boolean;
	v_errmsg?: string;
	v_exiting?: number;
	messages?: string;
	modified_buffers?: Array<{ name: string; buftype?: string }>;
};

function luaString(value: string): string {
	return JSON.stringify(value);
}

function readTextIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

function readJsonIfExists<T>(path: string): T | undefined {
	const text = readTextIfExists(path);
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function lastInterestingLines(text: string | undefined, count = 12): string {
	return (text ?? "")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(-count)
		.join("\n");
}

function formatNvimExitDetails(
	result: NvimRunResult,
	diagnostics: NvimDiagnostics | undefined,
	logPath: string,
): string {
	const details = [
		result.signal
			? `nvim was terminated by ${result.signal}`
			: `nvim exited with code ${result.exitCode ?? "unknown"}`,
	];
	if (diagnostics?.status)
		details.push(`export status: ${diagnostics.status}`);
	if (diagnostics?.message)
		details.push(`export message: ${diagnostics.message}`);
	if (diagnostics?.thread_count !== undefined) {
		details.push(
			`threads: ${diagnostics.exported_thread_count ?? "?"}/${diagnostics.thread_count} exported`,
		);
	}
	if (diagnostics?.v_errmsg)
		details.push(`v:errmsg: ${diagnostics.v_errmsg}`);
	if (diagnostics?.modified_buffers?.length) {
		details.push(
			`modified buffers: ${diagnostics.modified_buffers
				.map(
					(buf) =>
						`${buf.name || "[No Name]"}${buf.buftype ? ` (${buf.buftype})` : ""}`,
				)
				.join(", ")}`,
		);
	}
	const messages = lastInterestingLines(diagnostics?.messages);
	if (messages) details.push(`:messages:\n${messages}`);
	const logTail = lastInterestingLines(readTextIfExists(logPath), 8);
	if (logTail) details.push(`NVIM_LOG_FILE tail:\n${logTail}`);
	return details.join("\n");
}

export default function (pi: ExtensionAPI) {
	const registerReviewCommand = (commandName: string) => {
		pi.registerCommand(commandName, {
			description:
				"Open Neovim to review a diff, then insert the exported review Markdown into the editor",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`/${commandName} requires the interactive TUI`,
						"error",
					);
					return;
				}

				if (!(await commandExists(pi, ctx.cwd, "nvim"))) {
					ctx.ui.notify("nvim was not found on PATH.", "error");
					return;
				}

				const tempDir = mkdtempSync(join(tmpdir(), "pi-nvim-review-"));
				const reviewPath = join(tempDir, "review.md");
				const diagnosticsPath = join(tempDir, "diagnostics.json");
				const nvimLogPath = join(tempDir, "nvim.log");
				const initPath = join(tempDir, "review-init.lua");
				writeFileSync(
					initPath,
					[
						`local review_path = ${luaString(reviewPath)}`,
						`local diagnostics_path = ${luaString(diagnosticsPath)}`,
						"local function collect_messages()",
						"  local ok, result = pcall(vim.api.nvim_exec2, 'messages', { output = true })",
						"  return ok and result.output or ''",
						"end",
						"local function modified_buffers()",
						"  local buffers = {}",
						"  for _, buf in ipairs(vim.api.nvim_list_bufs()) do",
						"    if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].modified then",
						"      table.insert(buffers, { name = vim.api.nvim_buf_get_name(buf), buftype = vim.bo[buf].buftype })",
						"    end",
						"  end",
						"  return buffers",
						"end",
						"local function write_diagnostics(status, fields)",
						"  fields = fields or {}",
						"  fields.status = status",
						"  fields.v_errmsg = vim.v.errmsg",
						"  fields.v_exiting = vim.v.exiting",
						"  fields.messages = collect_messages()",
						"  fields.modified_buffers = modified_buffers()",
						"  pcall(vim.fn.writefile, { vim.json.encode(fields) }, diagnostics_path)",
						"end",
						"vim.api.nvim_create_autocmd('VimLeavePre', { callback = function()",
						"  local ok, summary = pcall(require, 'unified_review.ui.summary')",
						"  if not ok then",
						"    write_diagnostics('error', { message = tostring(summary) })",
						"    return",
						"  end",
						"  if type(summary.save_active) ~= 'function' then",
						"    local legacy_ok, legacy_err = pcall(vim.cmd, 'UnifiedReview save ' .. vim.fn.fnameescape(review_path))",
						"    write_diagnostics(legacy_ok and 'saved' or 'error', { message = legacy_ok and 'saved via legacy command' or tostring(legacy_err) })",
						"    return",
						"  end",
						"  local result, err = summary.save_active(review_path, 'markdown')",
						"  if result then",
						"    write_diagnostics('saved', result)",
						"  else",
						"    write_diagnostics('error', { message = err and err.message or 'failed to save review' })",
						"  end",
						"end })",
						"",
						"vim.api.nvim_create_autocmd('VimEnter', {",
						"  once = true,",
						"  callback = function()",
						"    vim.defer_fn(function()",
						"      for _, buf in ipairs(vim.api.nvim_list_bufs()) do",
						"        if vim.api.nvim_buf_get_name(buf) == '' and not vim.bo[buf].modified then",
						"          pcall(vim.api.nvim_buf_delete, buf, { force = true })",
						"        end",
						"      end",
						"    end, 150)",
						"  end,",
						"})",
					].join("\n") + "\n",
				);

				let keepTempDir = false;
				const result = await ctx.ui.custom<NvimRunResult>(
					(tui, _theme, _keybindings, done) => {
						tui.stop();
						process.stdout.write("\x1b[2J\x1b[H");

						const child = spawnSync(
							"nvim",
							[
								"--cmd",
								"let g:auto_session_enabled = v:false",
								"--cmd",
								"lua vim.g.session_autoload = false",
								"-S",
								initPath,
								"-c",
								"UnifiedReview",
							],
							{
								cwd: ctx.cwd,
								stdio: "inherit",
								encoding: "utf8",
								env: {
									...process.env,
									NVIM_LOG_FILE: nvimLogPath,
								},
							},
						);

						tui.start();
						tui.requestRender(true);

						done({
							exitCode: child.status,
							stderr: "",
							error: child.error?.message,
							signal: child.signal,
						});
						return { render: () => [], invalidate: () => {} };
					},
					{ overlay: false },
				);

				try {
					if (result.error) {
						ctx.ui.notify(
							`Failed to launch nvim: ${result.error}`,
							"error",
						);
						return;
					}

					const diagnostics =
						readJsonIfExists<NvimDiagnostics>(diagnosticsPath);
					const review = readTextIfExists(reviewPath)?.trim();

					if (result.exitCode !== 0 && !review) {
						keepTempDir = true;
						ctx.ui.notify(
							`${formatNvimExitDetails(result, diagnostics, nvimLogPath)}\nDiagnostics retained in ${tempDir}`,
							"warning",
						);
						return;
					}

					if (!existsSync(reviewPath)) {
						ctx.ui.notify(
							"Neovim did not export a review. Add comments with <leader>rc before exiting.",
							"warning",
						);
						return;
					}

					if (!review) {
						ctx.ui.notify(
							"Neovim exported an empty review.",
							"warning",
						);
						return;
					}

					ctx.ui.setEditorText(formatLocalReviewForAgent(review));
					ctx.ui.notify(
						result.exitCode === 0
							? "Inserted Neovim review into the editor."
							: `Inserted Neovim review despite ${formatNvimExitDetails(result, diagnostics, nvimLogPath).split("\n")[0]}.`,
						result.exitCode === 0 ? "info" : "warning",
					);
				} finally {
					if (!keepTempDir) {
						rmSync(tempDir, { recursive: true, force: true });
					}
				}
			},
		});
	};

	registerReviewCommand("review");
}
