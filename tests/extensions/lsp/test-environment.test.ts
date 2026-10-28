import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertCommandAvailable,
	withOnlyCommandOnPath,
} from "./test-environment.ts";

test("Rust LSP tests isolate Cargo proxies, retain the linker, and restore the environment", async (t) => {
	const which = assertCommandAvailable("which");
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-lsp-environment-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const bin = path.join(cwd, "bin");
	const linkerBin = path.join(cwd, "linker-bin");
	await mkdir(bin);
	await mkdir(linkerBin);
	await symlink(which, path.join(bin, "which"));
	for (const command of [
		"rust-analyzer",
		"cargo",
		"rustc",
		"clippy-driver",
	]) {
		await symlink(process.execPath, path.join(bin, command));
	}
	await symlink(process.execPath, path.join(linkerBin, "cc"));
	const overrides = {
		PATH: [bin, linkerBin].join(path.delimiter),
		CARGO_HOME: path.join(cwd, "host-cargo"),
		CARGO: "host-cargo",
		RUSTC: "host-rustc",
	};
	const original = Object.fromEntries(
		Object.keys(overrides).map((key) => [key, process.env[key]]),
	);
	try {
		Object.assign(process.env, overrides);
		const failure = new Error("test callback failed");
		await assert.rejects(
			withOnlyCommandOnPath(
				{
					command: "rust-analyzer",
					extraPathCommands: ["cargo", "rustc", "clippy-driver"],
				},
				async () => {
					assert.equal(process.env.CARGO, path.join(bin, "cargo"));
					assert.equal(process.env.RUSTC, path.join(bin, "rustc"));
					assert.notEqual(
						process.env.CARGO_HOME,
						overrides.CARGO_HOME,
					);
					assert.ok(
						process.env.PATH?.split(path.delimiter).includes(
							linkerBin,
						),
					);
					throw failure;
				},
			),
			(error) => error === failure,
		);
		for (const [key, value] of Object.entries(overrides))
			assert.equal(process.env[key], value);
	} finally {
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
