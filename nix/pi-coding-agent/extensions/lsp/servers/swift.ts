import { createHash } from "node:crypto";
import { access, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { LspServerImplementation } from "../types.ts";

export const swiftLspServer: LspServerImplementation = {
	languages: ["swift"],
	command: "sourcekit-lsp",
	args: [],
	async processEnvironment({ cwd, signal, defaultEnvironment }) {
		const env: NodeJS.ProcessEnv = { ...defaultEnvironment };
		const swiftBuild =
			(await commandPathFromEnvironment("swift-build", env.PATH)) ??
			(await commandPath("swift-build", cwd, signal));
		if (swiftBuild) {
			const swiftpm = path.dirname(path.dirname(swiftBuild));
			env.SWIFTPM_CUSTOM_BIN_DIR ??= path.join(swiftpm, "bin");
			env.SWIFTPM_CUSTOM_LIBS_DIR ??= path.join(
				swiftpm,
				"lib",
				"swift",
				"pm",
			);
		}

		if (!env.SOURCEKIT_TOOLCHAIN_PATH) {
			const swiftc =
				(await commandPathFromEnvironment("swiftc", env.PATH)) ??
				(await commandPath("swiftc", cwd, signal));
			const swift =
				(await commandPathFromEnvironment("swift", env.PATH)) ??
				(await commandPath("swift", cwd, signal));
			const toolchain = await sourceKitToolchainPath(swiftc ?? swift);
			if (toolchain) env.SOURCEKIT_TOOLCHAIN_PATH = toolchain;
		}
		return env;
	},
};

async function commandPathFromEnvironment(
	command: string,
	environmentPath: string | undefined,
): Promise<string | undefined> {
	for (const directory of (environmentPath ?? "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, command);
		try {
			await access(candidate);
			return candidate;
		} catch {}
	}
	return undefined;
}

async function sourceKitToolchainPath(
	compilerPath: string | undefined,
): Promise<string | undefined> {
	const toolchain = await inferSwiftToolchainPath(compilerPath);
	if (!toolchain) return undefined;

	if (await fileExists(path.join(toolchain, "lib", "libIndexStore.dylib"))) {
		return toolchain;
	}

	const libIndexStore = await findLibIndexStore();
	if (!libIndexStore) return toolchain;
	return await synthesizeSourceKitToolchain(toolchain, libIndexStore);
}

async function inferSwiftToolchainPath(
	compilerPath: string | undefined,
): Promise<string | undefined> {
	if (!compilerPath) return undefined;

	const compilerRoot = path.dirname(path.dirname(compilerPath));
	if (
		await fileExists(path.join(compilerRoot, "lib", "sourcekitd.framework"))
	) {
		return compilerRoot;
	}

	try {
		const wrapper = await readFile(compilerPath, "utf8");
		const match = wrapper.match(
			/(\/nix\/store\/[^\s"']+-swift-[^\/\s"']+)\/bin\/swift-frontend/,
		);
		if (match?.[1]) return match[1];
	} catch {}
	return undefined;
}

async function findLibIndexStore(): Promise<string | undefined> {
	const developerDir = process.env.DEVELOPER_DIR;
	const candidates = [
		developerDir
			? path.join(
					developerDir,
					"Toolchains",
					"XcodeDefault.xctoolchain",
					"usr",
					"lib",
					"libIndexStore.dylib",
				)
			: undefined,
		"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/libIndexStore.dylib",
	].filter((candidate): candidate is string => Boolean(candidate));

	for (const candidate of candidates) {
		if (await fileExists(candidate)) return candidate;
	}
	return undefined;
}

async function synthesizeSourceKitToolchain(
	toolchain: string,
	libIndexStore: string,
): Promise<string> {
	const key = createHash("sha256")
		.update(`${toolchain}\0${libIndexStore}`)
		.digest("hex")
		.slice(0, 16);
	const root = path.join(tmpdir(), "pi-sourcekit-toolchains", key);
	await mkdir(path.join(root, "bin"), { recursive: true });
	await mkdir(path.join(root, "lib"), { recursive: true });
	await ensureSymlink(
		path.join(toolchain, "bin", "swift"),
		path.join(root, "bin", "swift"),
	);
	await ensureSymlink(
		path.join(toolchain, "bin", "swiftc"),
		path.join(root, "bin", "swiftc"),
	);
	await ensureSymlink(
		path.join(toolchain, "lib", "sourcekitd.framework"),
		path.join(root, "lib", "sourcekitd.framework"),
	);
	await ensureSymlink(
		libIndexStore,
		path.join(root, "lib", "libIndexStore.dylib"),
	);
	return root;
}

async function ensureSymlink(target: string, linkPath: string) {
	try {
		await symlink(target, linkPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

async function fileExists(file: string) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

async function commandPath(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await runShell(
		cwd,
		`command -v ${shellQuote(command)}`,
		signal,
	);
	const path = result.stdout.trim();
	return result.exitCode === 0 && path ? path : undefined;
}

async function runShell(cwd: string, command: string, signal?: AbortSignal) {
	return await new Promise<{ stdout: string; exitCode: number }>(
		(resolve) => {
			const proc = spawn("/bin/sh", ["-lc", command], { cwd, signal });
			let stdout = "";
			proc.stdout.on("data", (data) => (stdout += data));
			proc.on("error", () => resolve({ stdout, exitCode: 1 }));
			proc.on("close", (code) =>
				resolve({ stdout, exitCode: code ?? 1 }),
			);
		},
	);
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
