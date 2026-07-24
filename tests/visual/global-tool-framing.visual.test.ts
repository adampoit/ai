import assert from "node:assert/strict";
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	writeFile,
} from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { ShellUse } from "shell-use";

const enabled = process.env.RUN_VISUAL_E2E === "1";
const shellUseBinary =
	process.env.SHELL_USE_BIN ?? findExecutable("shell-use") ?? "shell-use";
const piBinary = resolve("node_modules/.bin/pi");
const fixtureCwd = resolve("tests/visual/fixture-project");
const webAccessExtension = resolve("node_modules/pi-web-access/index.ts");
const extensions = [
	resolve("nix/pi-coding-agent/extensions/global-tool-framing.ts"),
	resolve("nix/pi-coding-agent/extensions/tools/index.ts"),
	resolve("tests/visual/extensions/scripted-provider.ts"),
	resolve("tests/visual/extensions/third-party-fixture.ts"),
];

function findExecutable(name: string): string | undefined {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.map((directory) => join(directory, name))
		.find((candidate) => existsSync(candidate));
}

async function available(): Promise<boolean> {
	if (!enabled) return false;
	try {
		await access(shellUseBinary, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

test(
	"real Pi TUI composes global tool frames deterministically",
	{ skip: !(await available()) && "set RUN_VISUAL_E2E=1 and SHELL_USE_BIN" },
	async (t) => {
		for (const fixture of [
			{
				prompt: "fixture:grep-success",
				width: 92,
				expected: "grep",
				snapshot: "grep-collapsed-wide",
			},
			{
				prompt: "fixture:generic-success",
				width: 92,
				expected: "Third Party Fixture",
				snapshot: "generic-success-wide",
			},
			{
				prompt: "fixture:generic-error",
				width: 52,
				expected: "fixture execution failed",
				snapshot: "generic-error-narrow",
			},
		]) {
			await t.test(
				`${fixture.prompt} at ${fixture.width} columns`,
				async () => {
					const sessionHome = await mkdtemp(
						join(tmpdir(), "pi-tool-frame-"),
					);
					await installTheme(sessionHome);
					const shell = new ShellUse(undefined, {
						binary: shellUseBinary,
						home: join(sessionHome, "shell-use"),
					});
					try {
						await shell.run(
							piBinary,
							[
								"--no-extensions",
								"--no-skills",
								"--no-prompt-templates",
								"--no-context-files",
								"--no-session",
								"--offline",
								"--model",
								"visual-fixture/scripted",
								...extensions.flatMap((path) => ["-e", path]),
								fixture.prompt,
							],
							{
								cols: fixture.width,
								rows: 36,
								cwd: fixtureCwd,
								env: cleanEnvironment(sessionHome),
							},
						);
						await shell.waitText("fixture complete", {
							timeout: 15_000,
						});
						await shell.expectText(fixture.expected);
						const state = await shell.state();
						for (const line of state.text.split("\n")) {
							assert.ok(line.length <= fixture.width);
						}
						await assertTextSnapshot(
							fixture.snapshot,
							extractToolFrame(
								state.text,
								fixture.prompt.includes("grep")
									? "grep"
									: "Third Party Fixture",
							),
						);
						const cells = await shell.cells(
							0,
							0,
							fixture.width,
							36,
						);
						assert.ok(cells.some((cell) => cell.fg !== "default"));
						await shell.screenshot(
							join(
								sessionHome,
								`${fixture.prompt.replace(":", "-")}.txt`,
							),
							{ full: true },
						);
						if (fixture.prompt === "fixture:grep-success") {
							await shell.press("CTRL+O");
							await shell.waitText("expanded", {
								timeout: 2_000,
							});
						}
					} finally {
						await shell.close();
					}
				},
			);
		}

		await t.test(
			"synchronizes generic running and completed frames with markers",
			async () => {
				const sessionHome = await mkdtemp(
					join(tmpdir(), "pi-tool-frame-running-"),
				);
				await installTheme(sessionHome);
				const ready = join(sessionHome, "ready");
				const release = join(sessionHome, "release");
				const shell = new ShellUse(undefined, {
					binary: shellUseBinary,
					home: join(sessionHome, "shell-use"),
				});
				try {
					await shell.run(
						piBinary,
						[
							"--no-extensions",
							"--no-skills",
							"--no-prompt-templates",
							"--no-context-files",
							"--no-session",
							"--offline",
							"--model",
							"visual-fixture/scripted",
							...extensions.flatMap((path) => ["-e", path]),
							"fixture:generic-running",
						],
						{
							cols: 72,
							rows: 36,
							cwd: fixtureCwd,
							env: {
								...cleanEnvironment(sessionHome),
								VISUAL_FIXTURE_READY: ready,
								VISUAL_FIXTURE_RELEASE: release,
							},
						},
					);
					await waitForFile(ready);
					await shell.expectText("running", { strict: false });
					await shell.expectText("partial fixture result");
					await assertTextSnapshot(
						"generic-running",
						extractToolFrame(
							await shell.text({ full: true }),
							"Third Party Fixture",
						),
					);
					await shell.screenshot(
						join(sessionHome, "generic-running.txt"),
						{
							full: true,
						},
					);
					await writeFile(release, "release");
					await shell.waitText("fixture complete", {
						timeout: 15_000,
					});
					await shell.expectText("final fixture result: waiting");
				} finally {
					await shell.close();
				}
			},
		);

		await t.test(
			"bash streams, ticks, and settles in one frame",
			async () => {
				const sessionHome = await mkdtemp(
					join(tmpdir(), "pi-tool-frame-bash-"),
				);
				await installTheme(sessionHome);
				const ready = join(sessionHome, "ready");
				const release = join(sessionHome, "release");
				const shell = await runFixture(
					sessionHome,
					"fixture:bash-running",
					80,
					{
						VISUAL_FIXTURE_READY: ready,
						VISUAL_FIXTURE_RELEASE: release,
					},
				);
				try {
					await waitForFile(ready);
					await shell.waitText("bash started", { timeout: 10_000 });
					await new Promise((resolve) => setTimeout(resolve, 1_100));
					await shell.expectText("elapsed", { strict: false });
					await assertTextSnapshot(
						"bash-running",
						extractToolFrame(
							await shell.text({ full: true }),
							"bash",
						),
					);
					await writeFile(release, "release");
					await shell.waitText("fixture complete", {
						timeout: 15_000,
					});
					await shell.expectText("bash completed", { strict: false });
					await shell.expectText("took", { strict: false });
					await assertTextSnapshot(
						"bash-complete",
						extractToolFrame(
							await shell.text({ full: true }),
							"bash",
						),
					);
				} finally {
					await shell.close();
				}
			},
		);

		await t.test(
			"bash replaces output from a continuously updating progress app",
			async () => {
				const sessionHome = await mkdtemp(
					join(tmpdir(), "pi-tool-frame-progress-"),
				);
				await installTheme(sessionHome);
				const shell = await runFixture(
					sessionHome,
					"fixture:bash-progress",
					80,
				);
				try {
					await shell.waitText("⠋ 10%", { timeout: 10_000 });
					await shell.waitText("fixture complete", {
						timeout: 15_000,
					});
					const frame = extractToolFrame(
						await shell.text({ full: true }),
						"bash",
					);
					assert.match(frame, /Downloading assets/);
					assert.match(frame, /✓ complete/);
					assert.doesNotMatch(frame, /\n│  [⠋⠙]/);
				} finally {
					await shell.close();
				}
			},
		);

		await t.test(
			"actual pi-web-access renderer receives the generic frame",
			async () => {
				const sessionHome = await mkdtemp(
					join(tmpdir(), "pi-tool-frame-web-"),
				);
				await installTheme(sessionHome);
				const shell = await runFixture(
					sessionHome,
					"fixture:web-search-error",
					72,
					{},
					[webAccessExtension],
				);
				try {
					await shell.waitText("fixture complete", {
						timeout: 15_000,
					});
					await shell.expectText("Web Search");
					await shell.expectText("Brave Search API key not found", {
						strict: false,
					});
					await assertTextSnapshot(
						"pi-web-access-error",
						extractToolFrame(
							await shell.text({ full: true }),
							"Web Search",
						),
					);
				} finally {
					await shell.close();
				}
			},
		);

		await t.test("edit renders its final Delta preview", async () => {
			const sessionHome = await mkdtemp(
				join(tmpdir(), "pi-tool-frame-edit-"),
			);
			await installTheme(sessionHome);
			const editCwd = join(sessionHome, "fixture-project");
			await mkdir(editCwd, { recursive: true });
			await writeFile(join(editCwd, "editable.txt"), "before\n");
			const shell = await runFixture(
				sessionHome,
				"fixture:edit-success",
				92,
				{},
				[],
				editCwd,
			);
			try {
				await shell.waitText("fixture complete", { timeout: 15_000 });
				await shell.expectText("applied");
				assert.equal(
					await readFile(join(editCwd, "editable.txt"), "utf8"),
					"after\n",
				);
				await assertTextSnapshot(
					"edit-complete",
					extractToolFrame(await shell.text({ full: true }), "edit"),
				);
			} finally {
				await shell.close();
			}
		});
	},
);

async function runFixture(
	home: string,
	prompt: string,
	cols: number,
	env: Record<string, string> = {},
	extraExtensions: string[] = [],
	cwd = fixtureCwd,
): Promise<ShellUse> {
	const shell = new ShellUse(undefined, {
		binary: shellUseBinary,
		home: join(home, "shell-use"),
	});
	await shell.run(
		piBinary,
		[
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-session",
			"--offline",
			"--model",
			"visual-fixture/scripted",
			...[...extensions, ...extraExtensions].flatMap((path) => [
				"-e",
				path,
			]),
			prompt,
		],
		{
			cols,
			rows: 36,
			cwd,
			env: { ...cleanEnvironment(home), ...env },
		},
	);
	return shell;
}

async function assertTextSnapshot(name: string, frame: string): Promise<void> {
	const path = resolve("tests/visual/snapshots", `${name}.txt`);
	const normalized = `${frame
		.replaceAll(fixtureCwd, "<fixture>")
		.replace(
			/\b(elapsed|took) (?:\d+(?:\.\d+)?(?:ms|s)|\d+m \d+s)/g,
			"$1 <duration>",
		)
		.trimEnd()}\n`;
	if (process.env.UPDATE_VISUAL_SNAPSHOTS === "1") {
		await mkdir(resolve("tests/visual/snapshots"), { recursive: true });
		await writeFile(path, normalized);
		return;
	}
	assert.equal(
		normalized,
		await readFile(path, "utf8"),
		`Visual snapshot ${name}`,
	);
}

function extractToolFrame(text: string, title: string): string {
	const lines = text.split("\n").map((line) => line.trimEnd());
	const start = lines.findIndex(
		(line) => line.includes("╭") && line.includes(title),
	);
	assert.notEqual(start, -1, `Missing ${title} tool frame`);
	const end = lines.findIndex(
		(line, index) => index >= start && line.includes("╯"),
	);
	assert.notEqual(end, -1, `Unterminated ${title} tool frame`);
	return lines.slice(start, end + 1).join("\n");
}

async function installTheme(home: string): Promise<void> {
	const agentDir = join(home, ".pi", "agent");
	await mkdir(join(agentDir, "themes"), { recursive: true });
	await cp(
		resolve("tests/visual/gruvbox.json"),
		join(agentDir, "themes", "gruvbox.json"),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ theme: "gruvbox" }),
	);
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error(`Timed out waiting for fixture marker: ${path}`);
}

function cleanEnvironment(home: string): Record<string, string> {
	return {
		HOME: home,
		PATH: process.env.PATH ?? "",
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
	};
}
