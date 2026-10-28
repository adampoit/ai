import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type TestServer = { command: string; extraPathCommands?: string[] };

export async function withOnlyCommandOnPath(
	server: TestServer,
	callback: () => Promise<void>,
) {
	const commands = [server.command, ...(server.extraPathCommands ?? [])];
	if (server.command === "rust-analyzer") commands.push("cc");
	const executables = new Map(
		commands.map((command) => [command, assertCommandAvailable(command)]),
	);
	const environment: NodeJS.ProcessEnv = {
		PATH: [...new Set([...executables.values()].map(path.dirname))].join(
			path.delimiter,
		),
	};
	if (server.command === "rust-analyzer") {
		// rust-analyzer prefers $CARGO_HOME/bin proxies over PATH.
		environment.CARGO_HOME = path.join(tmpdir(), "pi-lsp-cargo-home");
		await mkdir(environment.CARGO_HOME, { recursive: true });
		environment.CARGO = executables.get("cargo");
		environment.RUSTC = executables.get("rustc");
	}
	const previous = Object.fromEntries(
		Object.keys(environment).map((key) => [key, process.env[key]]),
	);
	try {
		for (const [key, value] of Object.entries(environment)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await callback();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

export function assertCommandAvailable(command: string) {
	let matches: string[] = [];
	try {
		matches = execFileSync("which", ["-a", command], { encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {}
	const commandPath =
		matches.find((match) => match.startsWith("/nix/store/")) ?? matches[0];
	assert.ok(commandPath, `${command} is not available on PATH`);
	return commandPath;
}
