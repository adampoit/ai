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

function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = undefined;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) args.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	if (current) args.push(current);
	return args;
}

function hasRevisionArg(parts: string[]): boolean {
	return parts.includes("-r") || parts.includes("--revisions");
}

async function inferPrNumber(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string | undefined> {
	const result = await pi.exec(
		"gh",
		["pr", "view", "--json", "number", "--jq", ".number"],
		{ cwd, timeout: 5000 },
	);
	const prNumber = result.stdout.trim();
	if (result.code !== 0 || !prNumber) return undefined;
	return prNumber;
}

async function tuicrArgs(
	pi: ExtensionAPI,
	cwd: string,
	args: string,
): Promise<string[]> {
	const parts = splitArgs(args.trim());
	let normalized = parts;

	if (parts.length === 0) {
		normalized = ["-w"];
	} else if (parts[0] === "pr") {
		const prNumber = parts[1] ?? (await inferPrNumber(pi, cwd));
		if (!prNumber) {
			throw new Error(
				"Could not infer a PR for the current branch with gh.",
			);
		}
		normalized = ["pr", prNumber, ...parts.slice(parts[1] ? 2 : 1)];
	} else if (
		!hasRevisionArg(parts) &&
		parts[0] &&
		!parts[0].startsWith("-")
	) {
		normalized = ["--revisions", parts[0], ...parts.slice(1)];
	}

	if (normalized.includes("--stdout")) return normalized;
	return [...normalized, "--stdout"];
}

async function commandExists(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
): Promise<boolean> {
	const result = await pi.exec(
		"bash",
		["-lc", 'command -v "$1"', "--", command],
		{ cwd, timeout: 2000 },
	);
	return result.code === 0;
}

export default function (pi: ExtensionAPI) {
	const registerReviewCommand = (commandName: string) => {
		pi.registerCommand(commandName, {
			description:
				"Open tuicr to review a diff, then insert the exported review Markdown into the editor",
			handler: async (args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`/${commandName} requires the interactive TUI`,
						"error",
					);
					return;
				}

				if (!(await commandExists(pi, ctx.cwd, "tuicr"))) {
					ctx.ui.notify(
						"tuicr was not found on PATH. Install it from https://tuicr.dev/ and try again.",
						"error",
					);
					return;
				}

				let runArgs: string[];
				try {
					runArgs = await tuicrArgs(pi, ctx.cwd, args);
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"error",
					);
					return;
				}

				const tempDir = mkdtempSync(join(tmpdir(), "pi-tuicr-"));
				const reviewPath = join(tempDir, "review.md");

				const exitCode = await ctx.ui.custom<number | null>(
					(tui, _theme, _keybindings, done) => {
						tui.stop();
						process.stdout.write("\x1b[2J\x1b[H");

						const result = spawnSync("tuicr", runArgs, {
							cwd: ctx.cwd,
							env: process.env,
							stdio: ["inherit", "pipe", "inherit"],
							encoding: "utf8",
						});

						tui.start();
						tui.requestRender(true);

						if (result.stdout) {
							writeFileSync(reviewPath, result.stdout);
						}

						done(result.status);
						return { render: () => [], invalidate: () => {} };
					},
					{ overlay: false },
				);

				try {
					if (exitCode !== 0) {
						ctx.ui.notify(
							`tuicr exited with code ${exitCode ?? "unknown"}`,
							"warning",
						);
						return;
					}

					if (!existsSync(reviewPath)) {
						ctx.ui.notify(
							"tuicr did not export a review.",
							"warning",
						);
						return;
					}

					const review = readFileSync(reviewPath, "utf8").trim();
					if (!review) {
						ctx.ui.notify(
							"tuicr exported an empty review.",
							"warning",
						);
						return;
					}

					ctx.ui.setEditorText(review);
					ctx.ui.notify(
						"Inserted tuicr review into the editor.",
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
