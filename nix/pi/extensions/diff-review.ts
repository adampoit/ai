import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	let hasToken = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			hasToken = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			hasToken = true;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			hasToken = true;
			continue;
		}
		if (char === quote) {
			quote = undefined;
			hasToken = true;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (hasToken) args.push(current);
			current = "";
			hasToken = false;
			continue;
		}
		current += char;
		hasToken = true;
	}

	if (escaping) throw new Error("Unterminated escape sequence in arguments.");
	if (quote) throw new Error("Unterminated quoted string in arguments.");
	if (hasToken) args.push(current);
	return args;
}

function hasRevisionArg(parts: string[]): boolean {
	return parts.includes("-r") || parts.includes("--revisions");
}

function uniqueNonEmpty(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}

	return result;
}

async function hasWorkingTreeChanges(
	pi: ExtensionAPI,
	cwd: string,
): Promise<boolean> {
	const jjResult = await tryExec(pi, cwd, "jj", [
		"diff",
		"--summary",
		"-r",
		"@",
	]);
	if (jjResult?.code === 0) {
		return jjResult.stdout.trim().length > 0;
	}

	const gitResult = await tryExec(pi, cwd, "git", [
		"status",
		"--porcelain",
		"--untracked-files=no",
	]);
	if (gitResult?.code === 0) {
		return gitResult.stdout.trim().length > 0;
	}

	return false;
}

async function inferGitHeadRefs(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string[]> {
	const branches: string[] = [];

	const currentBranch = await tryExec(pi, cwd, "git", [
		"branch",
		"--show-current",
	]);
	if (currentBranch?.code === 0) {
		branches.push(currentBranch.stdout);
	}

	const refsAtHead = await tryExec(pi, cwd, "git", [
		"for-each-ref",
		"--format=%(refname:short)",
		"--points-at",
		"HEAD",
		"refs/heads",
		"refs/remotes",
	]);
	if (refsAtHead?.code === 0) {
		branches.push(refsAtHead.stdout);
	}

	return uniqueNonEmpty(branches.join("\n").split(/\r?\n/)).filter(
		(branch) => branch !== "origin/HEAD",
	);
}

async function inferJjBookmarkRefs(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string[]> {
	const result = await tryExec(pi, cwd, "jj", [
		"log",
		"-r",
		"ancestors(@, 25)",
		"--no-graph",
		"-T",
		'bookmarks.join("\\n") ++ "\\n"',
	]);
	if (result?.code !== 0) return [];
	return uniqueNonEmpty(result?.stdout.split(/\r?\n/) ?? []);
}

async function inferPrNumber(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string | undefined> {
	const directResult = await tryExec(pi, cwd, "gh", [
		"pr",
		"view",
		"--json",
		"number",
		"--jq",
		".number",
	]);
	const directPrNumber = directResult?.stdout.trim();
	if (directResult?.code === 0 && directPrNumber) {
		return directPrNumber;
	}

	const headRefs = uniqueNonEmpty([
		...(await inferGitHeadRefs(pi, cwd)),
		...(await inferJjBookmarkRefs(pi, cwd)),
	]);

	for (const headRef of headRefs) {
		const result = await tryExec(pi, cwd, "gh", [
			"pr",
			"list",
			"--head",
			headRef,
			"--json",
			"number",
			"--limit",
			"1",
			"--jq",
			".[0].number",
		]);
		const prNumber = result?.stdout.trim();
		if (result?.code === 0 && prNumber) {
			return prNumber;
		}
	}

	return undefined;
}

async function inferPrBaseRef(
	pi: ExtensionAPI,
	cwd: string,
	prNumber?: string,
): Promise<string | undefined> {
	const args = ["pr", "view"];
	if (prNumber) args.push(prNumber);
	args.push("--json", "baseRefName", "--jq", ".baseRefName");

	const result = await tryExec(pi, cwd, "gh", args);
	const baseRef = result?.stdout.trim();
	return result?.code === 0 && baseRef ? baseRef : undefined;
}

async function jjGitEnv(
	pi: ExtensionAPI,
	cwd: string,
): Promise<NodeJS.ProcessEnv> {
	const rootResult = await tryExec(pi, cwd, "jj", ["root"]);
	const root = rootResult?.stdout.trim();
	if (rootResult?.code !== 0 || !root) return {};

	const gitDir = join(root, ".jj", "repo", "store", "git");
	if (!existsSync(gitDir)) return {};

	return {
		GIT_DIR: gitDir,
		GIT_WORK_TREE: root,
	};
}

function isRemotePrReview(args: string): boolean {
	const parts = splitArgs(args.trim());
	return parts[0] === "pr" && parts[1] === "remote";
}

async function codeDiffArgs(
	pi: ExtensionAPI,
	cwd: string,
	args: string,
): Promise<string[]> {
	const parts = splitArgs(args.trim());
	let diffTarget: string | undefined;

	if (parts.length === 0) {
		diffTarget = (await hasWorkingTreeChanges(pi, cwd))
			? undefined
			: "HEAD~1 HEAD";
	} else if (parts[0] === "pr") {
		const prNumber = parts[1] ?? (await inferPrNumber(pi, cwd));
		if (!prNumber) {
			throw new Error(
				"Could not infer a PR for the current branch or jj bookmark with gh.",
			);
		}
		const baseRef = await inferPrBaseRef(pi, cwd, prNumber);
		if (!baseRef) {
			throw new Error(`Could not infer the base branch for PR ${prNumber}.`);
		}
		diffTarget = `origin/${baseRef} HEAD`;
	} else if (hasRevisionArg(parts)) {
		const revisionIndex = parts.findIndex(
			(part) => part === "-r" || part === "--revisions",
		);
		diffTarget = parts[revisionIndex + 1];
	} else if (parts[0] && !parts[0].startsWith("-")) {
		diffTarget = parts.join(" ");
	}

	const command = diffTarget ? `CodeDiff ${diffTarget}` : "CodeDiff";
	return ["-c", command];
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
		"<sub>Reviewed locally with Neovim, CodeDiff, and unified-review.nvim.</sub>",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const registerReviewCommand = (commandName: string) => {
		pi.registerCommand(commandName, {
			description:
				"Open Neovim to review a diff, then insert the exported review Markdown into the editor",
			handler: async (args, ctx) => {
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

				let runArgs: string[];
				let gitEnv: NodeJS.ProcessEnv;
				try {
					if (isRemotePrReview(args)) {
						throw new Error(
							"Remote GitHub PR review is not supported yet. Use /review pr to review the PR diff locally.",
						);
					}
					runArgs = await codeDiffArgs(pi, ctx.cwd, args);
					gitEnv = await jjGitEnv(pi, ctx.cwd);
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"error",
					);
					return;
				}

				const tempDir = mkdtempSync(join(tmpdir(), "pi-nvim-review-"));
				const reviewPath = join(tempDir, "review.md");
				const initPath = join(tempDir, "review-init.lua");
				writeFileSync(
					initPath,
					[
						"vim.api.nvim_create_autocmd('VimLeavePre', { callback = function()",
						`  pcall(vim.cmd, 'ReviewSave ${reviewPath.replace(/'/g, "''")}')`,
						"end })",
					].join("\n") + "\n",
				);

				type NvimRunResult = {
					exitCode: number | null;
					stderr: string;
					error?: string;
					signal?: NodeJS.Signals | null;
				};

				const result = await ctx.ui.custom<NvimRunResult>(
					(tui, _theme, _keybindings, done) => {
						tui.stop();
						process.stdout.write("\x1b[2J\x1b[H");

						const child = spawnSync(
							"nvim",
							["-S", initPath, ...runArgs],
							{
								cwd: ctx.cwd,
								env: { ...process.env, ...gitEnv },
								stdio: "inherit",
								encoding: "utf8",
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

					if (result.exitCode !== 0) {
						if (result.signal) {
							ctx.ui.notify(
								`nvim was terminated by ${result.signal}`,
								"warning",
							);
							return;
						}
						ctx.ui.notify(
							`nvim exited with code ${result.exitCode ?? "unknown"}`,
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

					const review = readFileSync(reviewPath, "utf8").trim();
					if (!review) {
						ctx.ui.notify(
							"Neovim exported an empty review.",
							"warning",
						);
						return;
					}

					ctx.ui.setEditorText(formatLocalReviewForAgent(review));
					ctx.ui.notify(
						"Inserted Neovim review into the editor.",
						"info",
					);
				} finally {
					rmSync(tempDir, { recursive: true, force: true });
				}
			},
		});
	};

	registerReviewCommand("review");
}
