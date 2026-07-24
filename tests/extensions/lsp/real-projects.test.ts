import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lspExtension from "../../../nix/pi-coding-agent/extensions/lsp.ts";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
		onUpdate: ((result: ToolResult) => void) | undefined,
		ctx: TestExtensionContext,
	) => Promise<ToolResult>;
};

type ToolResult = {
	content?: Array<{ type: string; text?: string }>;
	details?: any;
	isError?: boolean;
};

type TestExtensionContext = {
	cwd: string;
	signal?: AbortSignal;
	ui: {
		theme: { fg: (_token: string, text: string) => string };
		setStatus: (key: string, value?: string) => void;
		notify: (message: string, level?: string) => void;
	};
};

type RealProjectCase = {
	server: string;
	language: string;
	command: string;
	extraPathCommands?: string[];
	project: string;
	repo: string;
	sha: string;
	file: string;
	inspect: { file: string; line: number; character: number };
	expectInspectIncludes: string[];
	expectUsagesIncludes?: string;
	minUsages?: number;
	searchQuery: string;
	searchIncludes?: string;
};

class FakePi {
	readonly tools = new Map<string, RegisteredTool>();
	readonly commands = new Map<string, unknown>();
	readonly renderers = new Map<string, unknown>();
	readonly handlers = new Map<
		string,
		Array<(event: unknown, ctx: TestExtensionContext) => unknown>
	>();

	registerTool(tool: RegisteredTool) {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, command: unknown) {
		this.commands.set(name, command);
	}

	registerMessageRenderer(customType: string, renderer: unknown) {
		this.renderers.set(customType, renderer);
	}

	on(
		eventName: string,
		handler: (event: unknown, ctx: TestExtensionContext) => unknown,
	) {
		const handlers = this.handlers.get(eventName) ?? [];
		handlers.push(handler);
		this.handlers.set(eventName, handlers);
	}

	sendMessage() {}

	async emit(eventName: string, event: unknown, ctx: TestExtensionContext) {
		for (const handler of this.handlers.get(eventName) ?? []) {
			await handler(event, ctx);
		}
	}
}

const realProjectCases: RealProjectCase[] = [
	{
		server: "vtsls",
		language: "JavaScript/TypeScript",
		command: "vtsls",
		project: "microsoft/tslib",
		repo: "https://github.com/microsoft/tslib.git",
		sha: "12bd8a74b320e3acfaba36b0ecb0e14964a9165b",
		file: "tslib.es6.js",
		inspect: { file: "tslib.es6.js", line: 24, character: 17 },
		expectInspectIncludes: ["__extends", "tslib.es6.js"],
		expectUsagesIncludes: "tslib.es6.js",
		minUsages: 2,
		searchQuery: "__extends",
	},
	{
		server: "lua-language-server",
		language: "Lua",
		command: "lua-language-server",
		project: "lua/lua",
		repo: "https://github.com/lua/lua.git",
		sha: "40b76de2d77e66b70a9d4bf989c3f5340919973f",
		file: "testes/goto.lua",
		inspect: { file: "testes/goto.lua", line: 12, character: 16 },
		expectInspectIncludes: ["errmsg", "goto.lua"],
		expectUsagesIncludes: "goto.lua",
		minUsages: 2,
		searchQuery: "errmsg",
		searchIncludes: "errmsg",
	},
	{
		server: "basedpyright-langserver",
		language: "Python",
		command: "basedpyright-langserver",
		project: "psf/requests",
		repo: "https://github.com/psf/requests.git",
		sha: "4ed3d1b3204caa6806a36125a39589044a02e807",
		file: "src/requests/sessions.py",
		inspect: {
			file: "src/requests/sessions.py",
			line: 127,
			character: 7,
		},
		expectInspectIncludes: ["SessionRedirectMixin", "sessions.py"],
		expectUsagesIncludes: "sessions.py",
		minUsages: 1,
		searchQuery: "SessionRedirectMixin",
		searchIncludes: "SessionRedirectMixin",
	},
	{
		server: "ruff",
		language: "Python linting",
		command: "ruff",
		project: "psf/requests",
		repo: "https://github.com/psf/requests.git",
		sha: "4ed3d1b3204caa6806a36125a39589044a02e807",
		file: "src/requests/sessions.py",
		inspect: {
			file: "src/requests/sessions.py",
			line: 127,
			character: 7,
		},
		expectInspectIncludes: ["Unknown request", "sessions.py"],
		searchQuery: "SessionRedirectMixin",
	},
	{
		server: "rust-analyzer",
		language: "Rust",
		command: "rust-analyzer",
		extraPathCommands: ["cargo", "clippy-driver", "rustc"],
		project: "BurntSushi/ripgrep",
		repo: "https://github.com/BurntSushi/ripgrep.git",
		sha: "4649aa9700619f94cf9c66876e9549d83420e16c",
		file: "crates/searcher/src/searcher/mod.rs",
		inspect: {
			file: "crates/searcher/src/searcher/mod.rs",
			line: 577,
			character: 12,
		},
		expectInspectIncludes: ["Searcher", "searcher/mod.rs"],
		expectUsagesIncludes: "searcher/mod.rs",
		minUsages: 2,
		searchQuery: "Searcher",
		searchIncludes: "Searcher",
	},
	{
		server: "nixd",
		language: "Nix",
		command: "nixd",
		extraPathCommands: ["nix"],
		project: "NixOS/nix",
		repo: "https://github.com/NixOS/nix.git",
		sha: "3887a906b178836818a62e8eba666ad652e8a388",
		file: "flake.nix",
		inspect: { file: "flake.nix", line: 46, character: 7 },
		expectInspectIncludes: ["flake.nix"],
		expectUsagesIncludes: "flake.nix",
		minUsages: 1,
		searchQuery: "systems",
	},
	{
		server: "Microsoft.CodeAnalysis.LanguageServer",
		language: "C#",
		command: "Microsoft.CodeAnalysis.LanguageServer",
		extraPathCommands: ["dotnet"],
		project: "JamesNK/Newtonsoft.Json",
		repo: "https://github.com/JamesNK/Newtonsoft.Json.git",
		sha: "4f73e74372445108d2c1bda37b36e6f5e43402e0",
		file: "Src/Newtonsoft.Json/JsonConvert.cs",
		inspect: {
			file: "Src/Newtonsoft.Json/JsonConvert.cs",
			line: 53,
			character: 25,
		},
		expectInspectIncludes: ["JsonConvert", "JsonConvert.cs"],
		expectUsagesIncludes: "JsonConvert.cs",
		minUsages: 1,
		searchQuery: "JsonConvert",
	},
	{
		server: "clangd",
		language: "C++",
		command: "clangd",
		extraPathCommands: ["basename"],
		project: "fmtlib/fmt",
		repo: "https://github.com/fmtlib/fmt.git",
		sha: "0e601c34de26fe5b46f4c62dab2039efcb0acaed",
		file: "include/fmt/format.h",
		inspect: {
			file: "include/fmt/format.h",
			line: 956,
			character: 41,
		},
		expectInspectIncludes: ["format_error", "format.h"],
		expectUsagesIncludes: "format.h",
		minUsages: 1,
		searchQuery: "format_error",
		searchIncludes: "format_error",
	},
	{
		server: "kotlin-lsp",
		language: "Kotlin",
		command: "kotlin-lsp",
		extraPathCommands: ["uname", "xargs"],
		project: "TheAlgorithms/Kotlin",
		repo: "https://github.com/TheAlgorithms/Kotlin.git",
		sha: "b913c1d85c972fd1e679c5d832d6458b21be8fb0",
		file: "src/main/kotlin/sort/BubbleSort.kt",
		inspect: {
			file: "src/main/kotlin/sort/BubbleSort.kt",
			line: 14,
			character: 28,
		},
		expectInspectIncludes: ["Generic Bubble Sort", "BubbleSort"],
		expectUsagesIncludes: "BubbleSort.kt",
		minUsages: 1,
		searchQuery: "bubbleSort",
	},
	{
		server: "sourcekit-lsp",
		language: "Swift",
		command: "sourcekit-lsp",
		extraPathCommands: [
			"swift",
			"swiftc",
			"swift-build",
			"dsymutil",
			"codesign",
			"uname",
		],
		project: "Alamofire/Alamofire",
		repo: "https://github.com/Alamofire/Alamofire.git",
		sha: "903c53c710d1cbbac0b4b9c2527aefb791e1fee3",
		file: "Source/Core/Session.swift",
		inspect: {
			file: "Source/Core/Session.swift",
			line: 30,
			character: 12,
		},
		expectInspectIncludes: ["Session", "Session.swift"],
		searchQuery: "Session",
	},
	{
		server: "terraform-ls",
		language: "Terraform",
		command: "terraform-ls",
		project: "terraform-aws-modules/terraform-aws-vpc",
		repo: "https://github.com/terraform-aws-modules/terraform-aws-vpc.git",
		sha: "3ffbd46fb1c7733e1b34d8666893280454e27436",
		file: "variables.tf",
		inspect: { file: "variables.tf", line: 23, character: 11 },
		expectInspectIncludes: ["name", "variables.tf"],
		expectUsagesIncludes: "outputs.tf",
		minUsages: 1,
		searchQuery: "name",
		searchIncludes: "name",
	},
	{
		server: "vscode-json-language-server",
		language: "JSON",
		command: "vscode-json-language-server",
		project: "SchemaStore/schemastore",
		repo: "https://github.com/SchemaStore/schemastore.git",
		sha: "7c910423df8b6b68a9ec85cd7ee5fb5d508c4953",
		file: "package.json",
		inspect: { file: "package.json", line: 2, character: 4 },
		expectInspectIncludes: ["package.json", "Unhandled method"],
		searchQuery: "schemastore",
	},
	{
		server: "yaml-language-server",
		language: "YAML",
		command: "yaml-language-server",
		project: "docker/awesome-compose",
		repo: "https://github.com/docker/awesome-compose.git",
		sha: "30f4b7f6a6c3b0c0ecf4d4efb0de203c48d11562",
		file: "nginx-golang-postgres/compose.yaml",
		inspect: {
			file: "nginx-golang-postgres/compose.yaml",
			line: 1,
			character: 1,
		},
		expectInspectIncludes: ["services", "compose.yaml"],
		searchQuery: "services",
	},
	{
		server: "marksman",
		language: "Markdown",
		command: "marksman",
		project: "EbookFoundation/free-programming-books",
		repo: "https://github.com/EbookFoundation/free-programming-books.git",
		sha: "c4a099bd87dbdc4ee47a87bb35c78d9aefdaee84",
		file: "books/free-programming-books-langs.md",
		inspect: {
			file: "books/free-programming-books-langs.md",
			line: 1983,
			character: 5,
		},
		expectInspectIncludes: ["free-programming-books-langs.md"],
		expectUsagesIncludes: "free-programming-books-langs.md",
		minUsages: 1,
		searchQuery: "Python",
		searchIncludes: "Python",
	},
	{
		server: "bash-language-server",
		language: "Shell",
		command: "bash-language-server",
		project: "ohmyzsh/ohmyzsh",
		repo: "https://github.com/ohmyzsh/ohmyzsh.git",
		sha: "ff1df9a0399d56b9f6e957bb62a2d4ba6bc0ef4c",
		file: "lib/cli.zsh",
		inspect: { file: "lib/cli.zsh", line: 3, character: 10 },
		expectInspectIncludes: ["cli.zsh", "install.sh"],
		expectUsagesIncludes: "install.sh",
		minUsages: 1,
		searchQuery: "omz",
		searchIncludes: "omz",
	},
	{
		server: "vscode-html-language-server",
		language: "HTML",
		command: "vscode-html-language-server",
		project: "whatwg/html",
		repo: "https://github.com/whatwg/html.git",
		sha: "320c05f679e2e0795acde90d0704caf7ade03fdc",
		file: "404.html",
		inspect: { file: "404.html", line: 13, character: 3 },
		expectInspectIncludes: ["404.html"],
		searchQuery: "Not Found",
	},
	{
		server: "vscode-css-language-server",
		language: "CSS/SCSS",
		command: "vscode-css-language-server",
		project: "twbs/bootstrap",
		repo: "https://github.com/twbs/bootstrap.git",
		sha: "f848b1a9a1abe5171fb13278b6e3e7418e0f784c",
		file: "scss/_containers.scss",
		inspect: { file: "scss/_containers.scss", line: 7, character: 4 },
		expectInspectIncludes: ["container", "_containers.scss"],
		expectUsagesIncludes: "_containers.scss",
		minUsages: 1,
		searchQuery: "container",
	},
];

const supportedRealProjectCases = realProjectCases.filter(
	(projectCase) =>
		projectCase.language !== "Swift" || process.platform === "darwin",
);

test(
	"lsp extension tools execute against fixed real open source projects",
	{ timeout: 900_000 },
	async (t) => {
		for (const projectCase of supportedRealProjectCases) {
			await t.test(
				`${projectCase.server} on ${projectCase.project}`,
				{ timeout: 180_000 },
				async () => {
					assertCommandAvailable(projectCase.command);
					const cwd = await copyRealProject(projectCase);
					await withOnlyCommandOnPath(projectCase, async () => {
						const pi = loadExtension();
						const ctx = createContext(cwd);

						await pi.emit(
							"session_start",
							{ reason: "real-project-test" },
							ctx,
						);
						try {
							await assertDiagnosticsComplete(
								pi,
								ctx,
								projectCase.file,
							);
							await assertInspect(pi, ctx, projectCase);
							await assertUsages(pi, ctx, projectCase);
							await assertSearch(pi, ctx, projectCase);

							const refresh = await executeTool(
								pi,
								"lsp_refresh",
								ctx,
								{},
							);
							assert.equal(
								toolText(refresh),
								"LSP servers refreshed.",
							);
						} finally {
							await pi.emit(
								"session_shutdown",
								{ reason: "done" },
								ctx,
							);
						}
					});
				},
			);
		}
	},
);

async function assertDiagnosticsComplete(
	pi: FakePi,
	ctx: TestExtensionContext,
	file: string,
) {
	const diagnostics = await executeTool(pi, "lsp_diagnostics", ctx, {
		files: [file],
	});
	assert.equal(diagnostics.isError, undefined, toolText(diagnostics));
	assert.ok(Array.isArray(diagnostics.details?.diagnostics));
	assert.equal(typeof diagnostics.details.count, "number");
	assert.ok(toolText(diagnostics).includes("LSP diagnostics"));
}

async function assertInspect(
	pi: FakePi,
	ctx: TestExtensionContext,
	projectCase: RealProjectCase,
) {
	let inspect: ToolResult | undefined;
	for (let attempt = 0; attempt < 20; attempt++) {
		inspect = await executeTool(
			pi,
			"lsp_inspect",
			ctx,
			projectCase.inspect,
		);
		const serialized = JSON.stringify(inspect.details?.result) ?? "";
		if (
			inspect.details?.ok === true &&
			projectCase.expectInspectIncludes.every((expected) =>
				serialized.includes(expected),
			)
		) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.ok(inspect);
	assert.equal(inspect.details?.ok, true, toolText(inspect));
	const serialized = JSON.stringify(inspect.details.result);
	for (const expected of projectCase.expectInspectIncludes) {
		assert.ok(serialized.includes(expected), toolText(inspect));
	}
}

async function assertUsages(
	pi: FakePi,
	ctx: TestExtensionContext,
	projectCase: RealProjectCase,
) {
	const usages = await executeTool(
		pi,
		"lsp_usages",
		ctx,
		projectCase.inspect,
	);
	assert.ok(usages.details, toolText(usages));
	if (projectCase.expectUsagesIncludes) {
		assert.equal(usages.details.ok, true, toolText(usages));
		const result = usages.details.result?.usages;
		assert.ok(Array.isArray(result), toolText(usages));
		assert.ok(
			result.length >= (projectCase.minUsages ?? 1),
			toolText(usages),
		);
		assert.ok(
			JSON.stringify(result).includes(projectCase.expectUsagesIncludes),
			toolText(usages),
		);
	}
}

async function assertSearch(
	pi: FakePi,
	ctx: TestExtensionContext,
	projectCase: RealProjectCase,
) {
	const search = await executeTool(pi, "lsp_search", ctx, {
		query: projectCase.searchQuery,
	});
	assert.equal(search.details?.ok, true, toolText(search));
	assert.ok(Array.isArray(search.details.result), toolText(search));
	if (projectCase.searchIncludes) {
		assert.ok(
			JSON.stringify(search.details.result).includes(
				projectCase.searchIncludes,
			),
			toolText(search),
		);
	}
}

function loadExtension() {
	const pi = new FakePi();
	lspExtension(pi as unknown as ExtensionAPI);
	return pi;
}

function createContext(cwd: string) {
	const ctx: TestExtensionContext = {
		cwd,
		ui: {
			theme: { fg: (_token, text) => text },
			setStatus: () => {},
			notify: () => {},
		},
	};
	return ctx;
}

async function executeTool(
	pi: FakePi,
	name: string,
	ctx: TestExtensionContext,
	params: unknown,
) {
	const tool = pi.tools.get(name);
	assert.ok(tool, `Expected ${name} to be registered`);
	return await tool.execute(
		`real-project-${name}`,
		params,
		timeoutSignal(120_000),
		undefined,
		ctx,
	);
}

function timeoutSignal(timeoutMs: number) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	return controller.signal;
}

async function copyRealProject(projectCase: RealProjectCase) {
	const cacheDir = await ensureRealProjectCache(projectCase);
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-lsp-real-project-"));
	const gitDir = path.join(cacheDir, ".git");
	await cp(cacheDir, cwd, {
		recursive: true,
		filter: (source) =>
			source !== gitDir && !source.startsWith(`${gitDir}${path.sep}`),
	});
	return cwd;
}

async function ensureRealProjectCache(projectCase: RealProjectCase) {
	const cacheRoot = path.join(tmpdir(), "pi-lsp-real-projects");
	await mkdir(cacheRoot, { recursive: true });
	const cacheDir = path.join(
		cacheRoot,
		`${safePathSegment(projectCase.project)}-${projectCase.sha.slice(0, 12)}`,
	);
	const marker = path.join(cacheDir, ".pi-lsp-real-project-complete");
	if (await fileExists(marker)) return cacheDir;

	await rm(cacheDir, { recursive: true, force: true });
	await mkdir(cacheDir, { recursive: true });
	const git = assertCommandAvailable("git");
	execFileSync(git, ["init"], { cwd: cacheDir, stdio: "ignore" });
	execFileSync(git, ["remote", "add", "origin", projectCase.repo], {
		cwd: cacheDir,
		stdio: "ignore",
	});
	execFileSync(git, ["fetch", "--depth=1", "origin", projectCase.sha], {
		cwd: cacheDir,
		stdio: "ignore",
		timeout: 300_000,
	});
	execFileSync(git, ["checkout", "--detach", projectCase.sha], {
		cwd: cacheDir,
		stdio: "ignore",
	});
	await writeFile(marker, `${projectCase.project}\n${projectCase.sha}\n`);
	return cacheDir;
}

async function withOnlyCommandOnPath(
	projectCase: RealProjectCase,
	callback: () => Promise<void>,
) {
	const oldPath = process.env.PATH;
	const commandDirs = [
		projectCase.command,
		...(projectCase.extraPathCommands ?? []),
	].map((command) => path.dirname(assertCommandAvailable(command)));
	process.env.PATH = [...new Set(commandDirs)].join(path.delimiter);
	try {
		await callback();
	} finally {
		process.env.PATH = oldPath;
	}
}

function assertCommandAvailable(command: string) {
	const commandPath = findCommand(command);
	assert.ok(commandPath, `${command} is not available on PATH`);
	return commandPath;
}

function findCommand(command: string) {
	try {
		const matches = execFileSync("which", ["-a", command], {
			encoding: "utf8",
		})
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		return (
			matches.find((match) => match.startsWith("/nix/store/")) ??
			matches[0]
		);
	} catch {
		return undefined;
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

function safePathSegment(value: string) {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function toolText(result: ToolResult) {
	return (
		result.content
			?.filter((entry) => entry.type === "text")
			.map((entry) => entry.text ?? "")
			.join("\n") ?? ""
	);
}
