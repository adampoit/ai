import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const updater = path.resolve("scripts/update-pi.mjs");

async function fixture(t: test.TestContext, version = "1.3.0") {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-update-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const bin = path.join(cwd, "bin");
	await mkdir(bin);
	await writeFile(
		path.join(cwd, "flake.nix"),
		`{ inputs.pi.url = "github:earendil-works/pi/v${version}"; }\n`,
	);
	const mock = `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync("commands.jsonl", JSON.stringify([command, ...args]) + "\\n");
if (command === "npm" && args[0] === "view") console.log("1.4.0");
else if (command === "nix" && args[0] === "flake") {
	if (process.env.FAIL_LOCK) process.exit(17);
	writeFileSync("flake.lock", "updated");
}
else if (command === "nix" && args[0] === "eval") console.log(process.env.RUNTIME_VERSION || "1.4.0");
else if (command !== "npm" || args[0] !== "install") throw new Error("Unexpected command");
`;
	for (const command of ["npm", "nix"]) {
		await writeFile(path.join(bin, command), mock);
		await chmod(path.join(bin, command), 0o755);
	}
	await writeFile(path.join(cwd, "package.json"), '{"type":"module"}');
	return {
		cwd,
		run(version?: string, environment: NodeJS.ProcessEnv = {}) {
			return execFileSync(
				process.execPath,
				[updater, ...(version ? [version] : [])],
				{
					cwd,
					encoding: "utf8",
					stdio: "pipe",
					env: {
						...process.env,
						UPDATE_VERSION: "",
						PATH: `${bin}${path.delimiter}${process.env.PATH}`,
						...environment,
					},
				},
			);
		},
		async commands(): Promise<string[][]> {
			return (await readFile(path.join(cwd, "commands.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		},
	};
}

test("Pi updater advances the release pin and lock before synchronizing all SDK packages", async (t) => {
	const project = await fixture(t);
	project.run("1.4.0");
	assert.match(
		await readFile(path.join(project.cwd, "flake.nix"), "utf8"),
		/\/v1\.4\.0"/,
	);
	assert.equal(
		await readFile(path.join(project.cwd, "flake.lock"), "utf8"),
		"updated",
	);
	assert.deepEqual(await project.commands(), [
		["nix", "flake", "update", "pi"],
		["nix", "eval", "--raw", ".#pi-coding-agent.version"],
		[
			"npm",
			"install",
			"--save-dev",
			"--save-exact",
			"@earendil-works/pi-agent-core@1.4.0",
			"@earendil-works/pi-ai@1.4.0",
			"@earendil-works/pi-coding-agent@1.4.0",
			"@earendil-works/pi-tui@1.4.0",
		],
	]);
});

test("Pi updater discovers the latest release without refreshing an unchanged flake pin", async (t) => {
	const project = await fixture(t, "1.4.0");
	project.run();
	const commands = await project.commands();
	assert.deepEqual(commands[0], [
		"npm",
		"view",
		"@earendil-works/pi-coding-agent",
		"version",
	]);
	assert.equal(
		commands.some(([, action]) => action === "update"),
		false,
	);
	assert.equal(commands.at(-1)?.[1], "install");
});

test("Pi updater accepts the workflow version environment variable", async (t) => {
	const project = await fixture(t);
	project.run(undefined, { UPDATE_VERSION: "1.4.0" });
	assert.deepEqual((await project.commands())[0], [
		"nix",
		"flake",
		"update",
		"pi",
	]);
});

test("Pi updater rejects malformed versions before editing the flake", async (t) => {
	const project = await fixture(t);
	assert.throws(() => project.run('1.4.0"; invalid'), /Invalid Pi version/);
	assert.match(
		await readFile(path.join(project.cwd, "flake.nix"), "utf8"),
		/\/v1\.3\.0"/,
	);
});

test("Pi updater stops before npm installation when the upstream tag has a different runtime version", async (t) => {
	const project = await fixture(t);
	assert.throws(
		() => project.run("1.4.0", { RUNTIME_VERSION: "1.3.0" }),
		/expected 1.4.0/,
	);
	assert.equal(
		(await project.commands()).some(([, action]) => action === "install"),
		false,
	);
});

test("Pi updater stops if the upstream flake cannot be locked", async (t) => {
	const project = await fixture(t);
	assert.throws(() => project.run("1.4.0", { FAIL_LOCK: "1" }));
	assert.deepEqual(await project.commands(), [
		["nix", "flake", "update", "pi"],
	]);
});
