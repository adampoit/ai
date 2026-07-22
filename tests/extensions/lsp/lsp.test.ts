import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

type ToolParams = Record<string, unknown>;

type InspectionExpectation = {
	params: ToolParams;
	expectedPosition: { file: string; line: number; character: number };
	hoverIncludes?: string;
	definitionIncludes?: string;
	usagesInclude?: string;
	minUsages?: number;
};

type UsageExpectation = {
	params: ToolParams;
	expectedPosition: { file: string; line: number; character: number };
	usagesInclude: string;
	minUsages?: number;
};

type UnsupportedDiagnostic = {
	file: string;
	source: string;
};

type LanguageCase = {
	name: string;
	command: string;
	extraPathCommands?: string[];
	fixtureDir: string;
	prepare?: (cwd: string) => void;
	diagnosticLast?: boolean;
	diagnostic?: {
		file: string;
		source: string;
		messageIncludes: string;
	};
	inspect?: InspectionExpectation;
	positionalInspect?: InspectionExpectation;
	usages?: UsageExpectation;
	positionalUsages?: UsageExpectation;
	search?: {
		query: string;
		nameStartsWith?: string;
		expectedCount?: number;
	};
	unsupportedDiagnostic?: UnsupportedDiagnostic;
	unsupportedUsages?: UsageExpectation;
	unsupportedPositionalUsages?: UsageExpectation;
	unsupportedSearch?: string;
};

class FakePi {
	readonly tools = new Map<string, RegisteredTool>();
	readonly commands = new Map<string, unknown>();
	readonly renderers = new Map<string, unknown>();
	readonly handlers = new Map<
		string,
		Array<(event: unknown, ctx: TestExtensionContext) => unknown>
	>();
	readonly sentMessages: unknown[] = [];

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

	sendMessage(message: unknown) {
		this.sentMessages.push(message);
	}

	async emit(eventName: string, event: unknown, ctx: TestExtensionContext) {
		for (const handler of this.handlers.get(eventName) ?? []) {
			await handler(event, ctx);
		}
	}
}

const fixturesRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);

const languageCases: LanguageCase[] = [
	{
		name: "TypeScript",
		command: "vtsls",
		fixtureDir: "typescript-project",
		diagnostic: {
			file: "src/index.ts",
			source: `import { Calculator, greet } from "./math.js";

const message = greet("Pi");
const calculator = new Calculator();
const total = calculator.add(1, 2);

const broken: number = message;

console.log(total, broken);
`,
			messageIncludes: "not assignable",
		},
		inspect: {
			params: { file: "src/math.ts", symbol: "greet" },
			expectedPosition: { file: "src/math.ts", line: 1, character: 17 },
			hoverIncludes: "greet",
			definitionIncludes: "src/math.ts",
			usagesInclude: "src/index.ts",
		},
		positionalInspect: {
			params: { file: "src/math.ts", line: 1, character: 17 },
			expectedPosition: { file: "src/math.ts", line: 1, character: 17 },
			hoverIncludes: "greet",
			usagesInclude: "src/index.ts",
		},
		usages: {
			params: { file: "src/math.ts", symbol: "greet" },
			expectedPosition: { file: "src/math.ts", line: 1, character: 17 },
			usagesInclude: "src/index.ts",
		},
		positionalUsages: {
			params: { file: "src/index.ts", line: 3, character: 17 },
			expectedPosition: { file: "src/index.ts", line: 3, character: 17 },
			usagesInclude: "src/math.ts",
		},
		search: { query: "greet", nameStartsWith: "greet" },
	},
	{
		name: "Lua",
		command: "lua-language-server",
		fixtureDir: "lua-project",
		diagnostic: {
			file: "broken.lua",
			source: "local broken =\n",
			messageIncludes: "<exp> expected",
		},
		inspect: {
			params: { file: "math_utils.lua", symbol: "M.greet" },
			expectedPosition: {
				file: "math_utils.lua",
				line: 5,
				character: 12,
			},
			hoverIncludes: "greet",
			definitionIncludes: "math_utils.lua",
			usagesInclude: "main.lua",
		},
		positionalInspect: {
			params: { file: "math_utils.lua", line: 5, character: 12 },
			expectedPosition: {
				file: "math_utils.lua",
				line: 5,
				character: 12,
			},
			hoverIncludes: "greet",
			usagesInclude: "main.lua",
		},
		usages: {
			params: { file: "math_utils.lua", symbol: "M.greet" },
			expectedPosition: {
				file: "math_utils.lua",
				line: 5,
				character: 12,
			},
			usagesInclude: "main.lua",
		},
		positionalUsages: {
			params: { file: "main.lua", line: 3, character: 28 },
			expectedPosition: { file: "main.lua", line: 3, character: 28 },
			usagesInclude: "math_utils.lua",
		},
		search: { query: "greet", nameStartsWith: "greet" },
	},
	{
		name: "Python",
		command: "basedpyright-langserver",
		fixtureDir: "python-project",
		diagnostic: {
			file: "broken.py",
			source: "print(missing_name)\n",
			messageIncludes: "is not defined",
		},
		inspect: {
			params: { file: "math_utils.py", symbol: "greet" },
			expectedPosition: { file: "math_utils.py", line: 1, character: 5 },
			hoverIncludes: "greet",
			definitionIncludes: "math_utils.py",
			usagesInclude: "main.py",
		},
		positionalInspect: {
			params: { file: "math_utils.py", line: 1, character: 5 },
			expectedPosition: { file: "math_utils.py", line: 1, character: 5 },
			hoverIncludes: "greet",
			usagesInclude: "main.py",
		},
		usages: {
			params: { file: "math_utils.py", symbol: "greet" },
			expectedPosition: { file: "math_utils.py", line: 1, character: 5 },
			usagesInclude: "main.py",
		},
		positionalUsages: {
			params: { file: "main.py", line: 3, character: 11 },
			expectedPosition: { file: "main.py", line: 3, character: 11 },
			usagesInclude: "math_utils.py",
		},
		search: { query: "greet", nameStartsWith: "greet" },
	},
	{
		name: "Rust",
		command: "rust-analyzer",
		extraPathCommands: ["cargo", "clippy-driver", "rustc"],
		fixtureDir: "rust-project",
		diagnosticLast: true,
		diagnostic: {
			file: "src/broken.rs",
			source: "#![deny(clippy::clone_on_copy)]\n\npub fn unnecessary_clone(value: i32) -> i32 {\n    value.clone()\n}\n",
			messageIncludes: "using `clone` on type `i32`",
		},
		inspect: {
			params: { file: "src/lib.rs", symbol: "greet" },
			expectedPosition: { file: "src/lib.rs", line: 3, character: 8 },
			hoverIncludes: "greet",
			definitionIncludes: "src/lib.rs",
			usagesInclude: "src/main.rs",
		},
		positionalInspect: {
			params: { file: "src/broken.rs", line: 3, character: 8 },
			expectedPosition: {
				file: "src/broken.rs",
				line: 3,
				character: 8,
			},
			hoverIncludes: "unnecessary_clone",
			definitionIncludes: "src/broken.rs",
			usagesInclude: "src/broken.rs",
			minUsages: 1,
		},
		usages: {
			params: { file: "src/lib.rs", symbol: "greet" },
			expectedPosition: { file: "src/lib.rs", line: 3, character: 8 },
			usagesInclude: "src/main.rs",
		},
		positionalUsages: {
			params: { file: "src/broken.rs", line: 3, character: 8 },
			expectedPosition: {
				file: "src/broken.rs",
				line: 3,
				character: 8,
			},
			usagesInclude: "src/broken.rs",
			minUsages: 1,
		},
		search: { query: "greet", nameStartsWith: "greet" },
	},
	{
		name: "Nix",
		command: "nixd",
		extraPathCommands: ["nix"],
		fixtureDir: "nix-project",
		diagnostic: {
			file: "broken.nix",
			source: "let x = ; in x\n",
			messageIncludes: "expected binding expression",
		},
		inspect: {
			params: { file: "default.nix", symbol: "greet" },
			expectedPosition: { file: "default.nix", line: 2, character: 3 },
			usagesInclude: "default.nix",
			minUsages: 1,
		},
		positionalInspect: {
			params: { file: "default.nix", line: 3, character: 13 },
			expectedPosition: { file: "default.nix", line: 3, character: 13 },
			definitionIncludes: "default.nix",
			usagesInclude: "default.nix",
			minUsages: 1,
		},
		usages: {
			params: { file: "default.nix", symbol: "greet" },
			expectedPosition: { file: "default.nix", line: 2, character: 3 },
			usagesInclude: "default.nix",
			minUsages: 1,
		},
		positionalUsages: {
			params: { file: "default.nix", line: 3, character: 13 },
			expectedPosition: { file: "default.nix", line: 3, character: 13 },
			usagesInclude: "default.nix",
			minUsages: 1,
		},
		search: { query: "greet", expectedCount: 0 },
	},
	{
		name: "C#",
		command: "Microsoft.CodeAnalysis.LanguageServer",
		fixtureDir: "csharp-project",
		diagnostic: {
			file: "Broken.cs",
			source: `namespace ToyProject;

public static class Broken
{
	public static void Run()
	{
		var message = ;
	}
}
`,
			messageIncludes: "Invalid expression term ';'",
		},
		inspect: {
			params: { file: "Greeter.cs", symbol: "Greet" },
			expectedPosition: { file: "Greeter.cs", line: 5, character: 23 },
			hoverIncludes: "Greet",
			definitionIncludes: "Greeter.cs",
			usagesInclude: "Program.cs",
		},
		positionalInspect: {
			params: { file: "Greeter.cs", line: 5, character: 23 },
			expectedPosition: { file: "Greeter.cs", line: 5, character: 23 },
			hoverIncludes: "Greet",
			definitionIncludes: "Greeter.cs",
			usagesInclude: "Program.cs",
		},
		usages: {
			params: { file: "Greeter.cs", symbol: "Greet" },
			expectedPosition: { file: "Greeter.cs", line: 5, character: 23 },
			usagesInclude: "Program.cs",
		},
		positionalUsages: {
			params: { file: "Program.cs", line: 3, character: 23 },
			expectedPosition: { file: "Program.cs", line: 3, character: 23 },
			usagesInclude: "Greeter.cs",
		},
		search: { query: "Greet", nameStartsWith: "Greet" },
	},
	{
		name: "C++",
		command: "clangd",
		extraPathCommands: ["basename"],
		fixtureDir: "cpp-project",
		diagnostic: {
			file: "src/Broken.cpp",
			source: "int broken() { return ; }\n",
			messageIncludes: "should return a value",
		},
		inspect: {
			params: { file: "src/greeter.cpp", symbol: "greet" },
			expectedPosition: {
				file: "src/greeter.cpp",
				line: 4,
				character: 13,
			},
			hoverIncludes: "greet",
			definitionIncludes: "greeter.cpp",
			usagesInclude: "greeter.cpp",
		},
		positionalInspect: {
			params: { file: "src/greeter.cpp", line: 4, character: 13 },
			expectedPosition: {
				file: "src/greeter.cpp",
				line: 4,
				character: 13,
			},
			hoverIncludes: "greet",
			usagesInclude: "greeter.cpp",
		},
		usages: {
			params: { file: "src/greeter.cpp", symbol: "greet" },
			expectedPosition: {
				file: "src/greeter.cpp",
				line: 4,
				character: 13,
			},
			usagesInclude: "greeter.cpp",
		},
		positionalUsages: {
			params: { file: "src/greeter.cpp", line: 4, character: 13 },
			expectedPosition: {
				file: "src/greeter.cpp",
				line: 4,
				character: 13,
			},
			usagesInclude: "greeter.cpp",
		},
		search: { query: "greet", nameStartsWith: "greet" },
	},
	{
		name: "Kotlin",
		command: "kotlin-lsp",
		extraPathCommands: ["uname", "xargs"],
		fixtureDir: "kotlin-project",
		diagnostic: {
			file: "Broken.kt",
			source: "package toy\n\nfun broken() {\n    val value =\n}\n",
			messageIncludes: "Expecting an expression",
		},
		inspect: {
			params: { file: "Main.kt", symbol: "greet" },
			expectedPosition: { file: "Main.kt", line: 3, character: 5 },
			usagesInclude: "Main.kt",
			minUsages: 1,
		},
		positionalInspect: {
			params: { file: "Main.kt", line: 3, character: 5 },
			expectedPosition: { file: "Main.kt", line: 3, character: 5 },
			hoverIncludes: "String",
			usagesInclude: "Main.kt",
			minUsages: 1,
		},
		usages: {
			params: { file: "Main.kt", symbol: "greet" },
			expectedPosition: { file: "Main.kt", line: 3, character: 5 },
			usagesInclude: "Main.kt",
			minUsages: 1,
		},
		positionalUsages: {
			params: { file: "Main.kt", line: 3, character: 5 },
			expectedPosition: { file: "Main.kt", line: 3, character: 5 },
			usagesInclude: "Main.kt",
			minUsages: 1,
		},
		unsupportedSearch: "greet",
	},
	{
		name: "Swift",
		command: "sourcekit-lsp",
		extraPathCommands: [
			"swift",
			"swiftc",
			"swift-build",
			"dsymutil",
			"codesign",
			"uname",
		],
		fixtureDir: "swift-project",
		prepare: (cwd) => {
			execFileSync("swift", ["build", "--enable-index-store"], {
				cwd,
				stdio: "pipe",
				timeout: 30_000,
			});
		},
		diagnostic: {
			file: "Sources/ToySwift/Broken.swift",
			source: "func broken() -> String {\n    return\n}\n",
			messageIncludes: "function should return a value",
		},
		inspect: {
			params: { file: "Sources/ToySwift/Greeter.swift", symbol: "greet" },
			expectedPosition: {
				file: "Sources/ToySwift/Greeter.swift",
				line: 1,
				character: 6,
			},
			usagesInclude: "main.swift",
		},
		positionalInspect: {
			params: {
				file: "Sources/ToySwift/main.swift",
				line: 1,
				character: 15,
			},
			expectedPosition: {
				file: "Sources/ToySwift/main.swift",
				line: 1,
				character: 15,
			},
			hoverIncludes: "greet",
			definitionIncludes: "Greeter.swift",
		},
		usages: {
			params: { file: "Sources/ToySwift/Greeter.swift", symbol: "greet" },
			expectedPosition: {
				file: "Sources/ToySwift/Greeter.swift",
				line: 1,
				character: 6,
			},
			usagesInclude: "main.swift",
			minUsages: 2,
		},
		positionalUsages: {
			params: {
				file: "Sources/ToySwift/main.swift",
				line: 1,
				character: 15,
			},
			expectedPosition: {
				file: "Sources/ToySwift/main.swift",
				line: 1,
				character: 15,
			},
			usagesInclude: "Greeter.swift",
			minUsages: 2,
		},
		search: { query: "greet", nameStartsWith: "greet" },
	},
	{
		name: "Terraform",
		command: "terraform-ls",
		fixtureDir: "terraform-project",
		diagnostic: {
			file: "broken.tf",
			source: 'output "broken" {\n  value =\n}\n',
			messageIncludes: "Invalid expression",
		},
		inspect: {
			params: { file: "main.tf", symbol: "locals" },
			expectedPosition: { file: "main.tf", line: 10, character: 1 },
		},
		positionalInspect: {
			params: { file: "main.tf", line: 14, character: 12 },
			expectedPosition: { file: "main.tf", line: 14, character: 12 },
			hoverIncludes: "greeting",
		},
		unsupportedUsages: {
			params: { file: "main.tf", symbol: "locals" },
			expectedPosition: { file: "main.tf", line: 10, character: 1 },
			usagesInclude: "main.tf",
		},
		unsupportedPositionalUsages: {
			params: { file: "main.tf", line: 14, character: 12 },
			expectedPosition: { file: "main.tf", line: 14, character: 12 },
			usagesInclude: "main.tf",
		},
		search: { query: "greeting", nameStartsWith: 'output "greeting"' },
	},
	{
		name: "JSON",
		command: "vscode-json-language-server",
		fixtureDir: "json-project",
		diagnostic: {
			file: "broken.json",
			source: '{ "broken": }\n',
			messageIncludes: "Value expected",
		},
		inspect: {
			params: { file: "settings.json", symbol: "serviceName" },
			expectedPosition: { file: "settings.json", line: 2, character: 2 },
		},
		positionalInspect: {
			params: { file: "settings.json", line: 2, character: 4 },
			expectedPosition: { file: "settings.json", line: 2, character: 4 },
		},
		unsupportedUsages: {
			params: { file: "settings.json", symbol: "serviceName" },
			expectedPosition: { file: "settings.json", line: 2, character: 2 },
			usagesInclude: "settings.json",
		},
		unsupportedPositionalUsages: {
			params: { file: "settings.json", line: 2, character: 4 },
			expectedPosition: { file: "settings.json", line: 2, character: 4 },
			usagesInclude: "settings.json",
		},
		search: { query: "serviceName", expectedCount: 0 },
	},
	{
		name: "YAML",
		command: "yaml-language-server",
		fixtureDir: "yaml-project",
		diagnostic: {
			file: "broken.yaml",
			source: "serviceName: [\n",
			messageIncludes: "Flow sequence",
		},
		inspect: {
			params: { file: "config.yaml", symbol: "serviceName" },
			expectedPosition: { file: "config.yaml", line: 1, character: 1 },
		},
		positionalInspect: {
			params: { file: "config.yaml", line: 1, character: 1 },
			expectedPosition: { file: "config.yaml", line: 1, character: 1 },
		},
		unsupportedUsages: {
			params: { file: "config.yaml", symbol: "serviceName" },
			expectedPosition: { file: "config.yaml", line: 1, character: 1 },
			usagesInclude: "config.yaml",
		},
		unsupportedPositionalUsages: {
			params: { file: "config.yaml", line: 1, character: 1 },
			expectedPosition: { file: "config.yaml", line: 1, character: 1 },
			usagesInclude: "config.yaml",
		},
		search: { query: "serviceName", expectedCount: 0 },
	},
	{
		name: "Markdown",
		command: "marksman",
		fixtureDir: "markdown-project",
		inspect: {
			params: { file: "README.md", symbol: "Greeter" },
			expectedPosition: { file: "README.md", line: 3, character: 1 },
		},
		positionalInspect: {
			params: { file: "README.md", line: 3, character: 4 },
			expectedPosition: { file: "README.md", line: 3, character: 4 },
			usagesInclude: "README.md",
			minUsages: 1,
		},
		usages: {
			params: { file: "README.md", symbol: "Greeter" },
			expectedPosition: { file: "README.md", line: 3, character: 1 },
			usagesInclude: "README.md",
			minUsages: 1,
		},
		positionalUsages: {
			params: { file: "README.md", line: 3, character: 4 },
			expectedPosition: { file: "README.md", line: 3, character: 4 },
			usagesInclude: "README.md",
			minUsages: 1,
		},
		unsupportedDiagnostic: {
			file: "Broken.md",
			source: "# Broken\n\n[[Greet]] hello\n",
		},
		search: { query: "Greeter", nameStartsWith: "H2: Greeter" },
	},
	{
		name: "Shell",
		command: "bash-language-server",
		fixtureDir: "shell-project",
		diagnostic: {
			file: "broken.sh",
			source: "#!/usr/bin/env bash\nif then\n",
			messageIncludes: "Unexpected keyword",
		},
		inspect: {
			params: { file: "main.sh", symbol: "make_greeting" },
			expectedPosition: { file: "main.sh", line: 3, character: 1 },
			usagesInclude: "main.sh",
			minUsages: 1,
		},
		positionalInspect: {
			params: { file: "main.sh", line: 8, character: 1 },
			expectedPosition: { file: "main.sh", line: 8, character: 1 },
			definitionIncludes: "main.sh",
			usagesInclude: "main.sh",
			minUsages: 1,
		},
		usages: {
			params: { file: "main.sh", symbol: "make_greeting" },
			expectedPosition: { file: "main.sh", line: 3, character: 1 },
			usagesInclude: "main.sh",
			minUsages: 1,
		},
		positionalUsages: {
			params: { file: "main.sh", line: 8, character: 1 },
			expectedPosition: { file: "main.sh", line: 8, character: 1 },
			usagesInclude: "main.sh",
			minUsages: 1,
		},
		search: { query: "greeting", nameStartsWith: "make_greeting" },
	},
	{
		name: "HTML",
		command: "vscode-html-language-server",
		fixtureDir: "html-project",
		inspect: {
			params: { file: "index.html", symbol: "main" },
			expectedPosition: { file: "index.html", line: 7, character: 3 },
		},
		positionalInspect: {
			params: { file: "index.html", line: 7, character: 6 },
			expectedPosition: { file: "index.html", line: 7, character: 6 },
		},
		unsupportedDiagnostic: {
			file: "broken.html",
			source: "<!doctype html>\n<div>\n",
		},
		unsupportedUsages: {
			params: { file: "index.html", symbol: "main" },
			expectedPosition: { file: "index.html", line: 7, character: 3 },
			usagesInclude: "index.html",
		},
		unsupportedPositionalUsages: {
			params: { file: "index.html", line: 7, character: 6 },
			expectedPosition: { file: "index.html", line: 7, character: 6 },
			usagesInclude: "index.html",
		},
		search: { query: "main", expectedCount: 0 },
	},
	{
		name: "CSS",
		command: "vscode-css-language-server",
		fixtureDir: "css-project",
		diagnostic: {
			file: "broken.css",
			source: ".broken {\n  color: ;\n}\n",
			messageIncludes: "property value expected",
		},
		inspect: {
			params: { file: "styles.css", symbol: ".app-title" },
			expectedPosition: { file: "styles.css", line: 1, character: 1 },
		},
		positionalInspect: {
			params: { file: "styles.css", line: 1, character: 2 },
			expectedPosition: { file: "styles.css", line: 1, character: 2 },
			hoverIncludes: "app-title",
		},
		usages: {
			params: { file: "styles.css", symbol: ".app-title" },
			expectedPosition: { file: "styles.css", line: 1, character: 1 },
			usagesInclude: "styles.css",
			minUsages: 1,
		},
		positionalUsages: {
			params: { file: "styles.css", line: 1, character: 2 },
			expectedPosition: { file: "styles.css", line: 1, character: 2 },
			usagesInclude: "styles.css",
			minUsages: 1,
		},
		search: { query: "app-title", expectedCount: 0 },
	},
];

test("lsp extension registers its public surface", () => {
	const pi = loadExtension();

	assert.deepEqual([...pi.tools.keys()].sort(), [
		"lsp_diagnostics",
		"lsp_inspect",
		"lsp_refresh",
		"lsp_search",
		"lsp_usages",
	]);
	assert.deepEqual([...pi.commands.keys()].sort(), [
		"lsp",
		"lsp-diagnostics",
		"lsp-refresh",
	]);
	assert.ok(pi.renderers.has("lsp-diagnostics"));
	assert.ok(pi.handlers.has("session_start"));
	assert.ok(pi.handlers.has("session_shutdown"));
});

test("lsp diagnostics notifies and stops the server when initialization fails", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-lsp-failed-init-"));
	const bin = path.join(cwd, "bin");
	await mkdir(bin);
	await writeFile(path.join(cwd, "main.ts"), "const value = 1;\n");
	const terminatedFile = path.join(cwd, "terminated");
	const serverPath = path.join(bin, "vtsls");
	await writeFile(
		serverPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
let buffer = Buffer.alloc(0);
function send(message) {
	const body = Buffer.from(JSON.stringify(message));
	process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
	process.stdout.write(body);
}
function handle(message) {
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "fake init failed" } });
	}
}
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const length = Number(/Content-Length: (\\d+)/i.exec(header)?.[1]);
		const bodyStart = headerEnd + 4;
		const bodyEnd = bodyStart + length;
		if (buffer.length < bodyEnd) return;
		handle(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
		buffer = buffer.subarray(bodyEnd);
	}
});
process.on("SIGTERM", () => {
	fs.writeFileSync(process.env.PI_FAKE_LSP_TERMINATED, "SIGTERM");
	process.exit(0);
});
setInterval(() => {}, 1000);
`,
	);
	await chmod(serverPath, 0o755);

	const oldPath = process.env.PATH;
	const oldTerminatedFile = process.env.PI_FAKE_LSP_TERMINATED;
	process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
	process.env.PI_FAKE_LSP_TERMINATED = terminatedFile;
	try {
		const pi = loadExtension();
		const ctx = createContext(cwd);
		const error = await executeTool(pi, "lsp_diagnostics", ctx, {
			files: ["main.ts"],
		}).then(
			() => undefined,
			(error) => error,
		);

		assert.ok(error, "expected diagnostics to fail");
		await waitFor(
			() =>
				ctx.notifications.some((entry) =>
					entry.message.includes("fake init failed"),
				),
			"LSP initialization failure notification was not shown",
		);
		await waitFor(
			() => pathExists(terminatedFile),
			"Failed LSP process was not terminated",
		);
	} finally {
		process.env.PATH = oldPath;
		if (oldTerminatedFile === undefined)
			delete process.env.PI_FAKE_LSP_TERMINATED;
		else process.env.PI_FAKE_LSP_TERMINATED = oldTerminatedFile;
	}
});

test("lsp command renders project detection reasons", async () => {
	const gitPath = assertCommandAvailable("git");
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-lsp-reasons-"));
	await mkdir(path.join(cwd, "src"), { recursive: true });
	await writeFile(
		path.join(cwd, "src", "index.ts"),
		"export const value = 1;\n",
	);
	execFileSync(gitPath, ["init"], { cwd, stdio: "ignore" });
	execFileSync(gitPath, ["add", "src/index.ts"], { cwd, stdio: "ignore" });

	const oldPath = process.env.PATH;
	const rendered: string[] = [];
	try {
		process.env.PATH = path.dirname(gitPath);
		const pi = loadExtension();
		const ctx = createContext(cwd);
		(ctx.ui as any).custom = async (factory: any) => {
			const view = factory(
				{ requestRender() {} },
				ctx.ui.theme,
				{ matches: () => false },
				() => {},
			);
			view.handleInput("t");
			rendered.push(...view.render(120));
			return undefined as never;
		};

		const command = pi.commands.get("lsp") as {
			handler: (args: string, ctx: TestExtensionContext) => Promise<void>;
		};
		await command.handler("", ctx);
	} finally {
		process.env.PATH = oldPath;
	}

	const output = rendered.join("\n");
	assert.ok(output.includes("typescript"), output);
	assert.ok(output.includes("detected because of src/index.ts"), output);
});

for (const languageCase of languageCases) {
	test(`lsp extension tools execute against a ${languageCase.name} toy project`, async () => {
		assertCommandAvailable(languageCase.command);

		await withOnlyCommandOnPath(languageCase, async () => {
			const cwd = await copyFixtureProject(languageCase);
			const pi = loadExtension();
			const ctx = createContext(cwd);

			try {
				await pi.emit("session_start", { reason: "startup" }, ctx);
				await waitFor(
					() =>
						ctx.statuses.some(
							(entry) =>
								entry[0] === "lsp" &&
								entry[1]?.includes("none"),
						),
					"LSP prewarm did not finish",
				);
				if (languageCase.diagnostic && !languageCase.diagnosticLast) {
					await assertDiagnostics(pi, ctx, languageCase);
				}

				if (languageCase.inspect) {
					await assertInspect(pi, ctx, languageCase.inspect);
				}
				if (languageCase.positionalInspect) {
					await assertInspect(
						pi,
						ctx,
						languageCase.positionalInspect,
					);
				}
				if (languageCase.usages) {
					await assertUsages(pi, ctx, languageCase.usages);
				}
				if (languageCase.positionalUsages) {
					await assertUsages(pi, ctx, languageCase.positionalUsages);
				}
				if (languageCase.search) {
					await assertSearch(pi, ctx, languageCase.search);
				}
				if (languageCase.diagnostic && languageCase.diagnosticLast) {
					await executeTool(pi, "lsp_refresh", ctx, {});
					await assertDiagnostics(pi, ctx, languageCase);
				}
				if (languageCase.unsupportedDiagnostic) {
					await assertUnsupportedDiagnostic(pi, ctx, languageCase);
				}
				if (languageCase.unsupportedUsages) {
					await assertUnsupportedUsages(
						pi,
						ctx,
						languageCase.unsupportedUsages,
					);
				}
				if (languageCase.unsupportedPositionalUsages) {
					await assertUnsupportedUsages(
						pi,
						ctx,
						languageCase.unsupportedPositionalUsages,
					);
				}
				if (languageCase.unsupportedSearch) {
					await assertUnsupportedSearch(
						pi,
						ctx,
						languageCase.unsupportedSearch,
					);
				}

				const refresh = await executeTool(pi, "lsp_refresh", ctx, {});
				assert.equal(toolText(refresh), "LSP servers refreshed.");
				assert.deepEqual(refresh.details, { refreshed: true });
			} finally {
				await pi.emit("session_shutdown", { reason: "quit" }, ctx);
			}
		});
	});
}

async function assertDiagnostics(
	pi: FakePi,
	ctx: TestExtensionContext,
	languageCase: LanguageCase,
) {
	const { diagnostic } = languageCase;
	assert.ok(diagnostic);
	let diagnostics: ToolResult | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		diagnostics = await executeTool(pi, "lsp_diagnostics", ctx, {
			files: [diagnostic.file],
		});
		if (
			diagnostics.details?.diagnostics?.some(
				(item: any) =>
					item.file === diagnostic.file &&
					item.severity === "error" &&
					item.message.includes(diagnostic.messageIncludes),
			)
		) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.ok(diagnostics);
	assert.equal(diagnostics.isError, undefined);
	assert.ok(toolText(diagnostics).includes("LSP diagnostics"));
	assert.ok(
		toolText(diagnostics).includes(diagnostic.file),
		toolText(diagnostics),
	);
	assert.ok(diagnostics.details.count > 0, toolText(diagnostics));
	assert.ok(
		diagnostics.details.diagnostics.some(
			(item: any) =>
				item.file === diagnostic.file &&
				item.severity === "error" &&
				item.message.includes(diagnostic.messageIncludes),
		),
		toolText(diagnostics),
	);
}

async function assertInspect(
	pi: FakePi,
	ctx: TestExtensionContext,
	expectation: InspectionExpectation,
) {
	let inspect: ToolResult | undefined;
	for (let attempt = 0; attempt < 20; attempt++) {
		inspect = await executeTool(pi, "lsp_inspect", ctx, expectation.params);
		const hover = inspect.details?.result?.hover;
		const hoverReady = (() => {
			if (!expectation.hoverIncludes) return true;
			return (
				hover?.ok === true &&
				hover?.result !== null &&
				hover?.result !== undefined
			);
		})();
		const usagesReady = expectation.usagesInclude
			? jsonIncludes(
					inspect.details?.result?.usages,
					expectation.usagesInclude,
				)
			: true;
		if (hoverReady && usagesReady) break;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.ok(inspect);
	assert.equal(inspect.details.ok, true, toolText(inspect));
	assert.deepEqual(
		inspect.details.result.position,
		expectation.expectedPosition,
	);
	if (expectation.hoverIncludes) {
		assert.ok(
			jsonIncludes(
				inspect.details.result.hover,
				expectation.hoverIncludes,
			),
			toolText(inspect),
		);
	}
	if (expectation.definitionIncludes) {
		assert.ok(
			jsonIncludes(
				inspect.details.result.definition,
				expectation.definitionIncludes,
			),
			toolText(inspect),
		);
	}
	if (expectation.minUsages !== undefined) {
		const usages = inspect.details.result.usages;
		assert.equal(usages.ok, true, toolText(inspect));
		assert.ok(Array.isArray(usages.result), toolText(inspect));
		assert.ok(
			usages.result.length >= expectation.minUsages,
			toolText(inspect),
		);
	}
	if (expectation.usagesInclude) {
		assert.ok(
			jsonIncludes(
				inspect.details.result.usages,
				expectation.usagesInclude,
			),
			toolText(inspect),
		);
	}
}

async function assertUsages(
	pi: FakePi,
	ctx: TestExtensionContext,
	expectation: UsageExpectation,
) {
	let usages: ToolResult | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		usages = await executeTool(pi, "lsp_usages", ctx, expectation.params);
		if (
			jsonIncludes(
				usages.details?.result?.usages,
				expectation.usagesInclude,
			)
		) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.ok(usages);
	assert.equal(usages.details.ok, true, toolText(usages));
	assert.deepEqual(
		usages.details.result.position,
		expectation.expectedPosition,
	);
	assert.ok(Array.isArray(usages.details.result.usages), toolText(usages));
	assert.ok(
		usages.details.result.usages.length >= (expectation.minUsages ?? 2),
		toolText(usages),
	);
	assert.ok(
		jsonIncludes(usages.details.result.usages, expectation.usagesInclude),
		toolText(usages),
	);
}

async function assertSearch(
	pi: FakePi,
	ctx: TestExtensionContext,
	expectation: NonNullable<LanguageCase["search"]>,
) {
	const search = await executeTool(pi, "lsp_search", ctx, {
		query: expectation.query,
	});
	assert.equal(search.details.ok, true, toolText(search));
	if (expectation.expectedCount !== undefined) {
		assert.equal(
			search.details.result.length,
			expectation.expectedCount,
			toolText(search),
		);
	}
	const { nameStartsWith } = expectation;
	if (nameStartsWith) {
		assert.ok(
			search.details.result.some((symbol: any) =>
				String(symbol?.name).startsWith(nameStartsWith),
			),
			toolText(search),
		);
	}
}

async function assertUnsupportedDiagnostic(
	pi: FakePi,
	ctx: TestExtensionContext,
	languageCase: LanguageCase,
) {
	const spec = languageCase.unsupportedDiagnostic;
	assert.ok(spec);
	assert.ok(languageCase.fixtureDir);
	await writeFile(path.join(ctx.cwd, spec.file), spec.source);
	const result = await executeTool(pi, "lsp_diagnostics", ctx, {
		files: [spec.file],
	});
	const diags = result.details?.diagnostics ?? [];
	assert.ok(
		!diags.some(
			(item: any) => item.file === spec.file && item.severity === "error",
		),
		`Expected no error diagnostics for ${spec.file}, but got: ${JSON.stringify(diags)}`,
	);
}

async function assertUnsupportedUsages(
	pi: FakePi,
	ctx: TestExtensionContext,
	expectation: UsageExpectation,
) {
	const usages = await executeTool(pi, "lsp_usages", ctx, expectation.params);
	assert.ok(usages.details, toolText(usages));
	if (usages.details.ok === true) {
		const list = usages.details.result?.usages;
		if (list?.ok === true) {
			assert.ok(
				Array.isArray(list.result) && list.result.length === 0,
				toolText(usages),
			);
		}
	} else {
		// Position resolution failure (no documentSymbol) is acceptable.
	}
}

async function assertUnsupportedSearch(
	pi: FakePi,
	ctx: TestExtensionContext,
	query: string,
) {
	const search = await executeTool(pi, "lsp_search", ctx, { query });
	assert.equal(search.details.ok, true, toolText(search));
	assert.equal(search.details.result.length, 0, toolText(search));
}

function loadExtension() {
	const pi = new FakePi();
	lspExtension(pi as unknown as ExtensionAPI);
	return pi;
}

function createContext(cwd: string) {
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx: TestExtensionContext & {
		statuses: typeof statuses;
		notifications: typeof notifications;
	} = {
		cwd,
		ui: {
			theme: { fg: (_token, text) => text },
			setStatus: (key, value) => statuses.push([key, value]),
			notify: (message, level) => notifications.push({ message, level }),
		},
		statuses,
		notifications,
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
		`test-${name}`,
		params,
		timeoutSignal(30_000),
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

async function copyFixtureProject(languageCase: LanguageCase) {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-lsp-fixture-"));
	await cp(path.join(fixturesRoot, languageCase.fixtureDir), cwd, {
		recursive: true,
	});
	languageCase.prepare?.(cwd);
	if (languageCase.diagnostic && !languageCase.diagnosticLast) {
		await writeFile(
			path.join(cwd, languageCase.diagnostic.file),
			languageCase.diagnostic.source,
		);
	}
	return cwd;
}

async function withOnlyCommandOnPath(
	languageCase: LanguageCase,
	callback: () => Promise<void>,
) {
	const oldPath = process.env.PATH;
	const commandDirs = [
		languageCase.command,
		...(languageCase.extraPathCommands ?? []),
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

async function waitFor(
	condition: () => boolean | Promise<boolean>,
	failureMessage: string,
) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(failureMessage);
}

async function pathExists(file: string) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

function toolText(result: ToolResult) {
	return (
		result.content
			?.filter((entry) => entry.type === "text")
			.map((entry) => entry.text ?? "")
			.join("\n") ?? ""
	);
}

function jsonIncludes(value: unknown, text: string) {
	return JSON.stringify(value)?.includes(text) ?? false;
}
