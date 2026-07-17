import type { LspServerImplementation } from "./types.ts";
import { nixLspServer } from "./servers/nixd.ts";
import { luaLspServer } from "./servers/lua.ts";
import { typescriptLspServer } from "./servers/typescript.ts";
import { pythonPyrightLspServer } from "./servers/python_pyright.ts";
import { pythonRuffLspServer } from "./servers/python_ruff.ts";
import { rustLspServer } from "./servers/rust.ts";
import { csharpLspServer } from "./servers/csharp.ts";
import { clangdLspServer } from "./servers/clangd.ts";
import { kotlinLspServer } from "./servers/kotlin.ts";
import { swiftLspServer } from "./servers/swift.ts";
import { terraformLspServer } from "./servers/terraform.ts";
import { jsonLspServer } from "./servers/json.ts";
import { yamlLspServer } from "./servers/yaml.ts";
import { markdownLspServer } from "./servers/markdown.ts";
import { shellLspServer } from "./servers/shell.ts";
import { htmlLspServer } from "./servers/html.ts";
import { cssLspServer } from "./servers/css.ts";

export { languageByExtension } from "./languages.ts";
export type { LspServerImplementation } from "./types.ts";

export const lspServers: LspServerImplementation[] = [
	nixLspServer,
	luaLspServer,
	typescriptLspServer,
	pythonPyrightLspServer,
	pythonRuffLspServer,
	rustLspServer,
	csharpLspServer,
	clangdLspServer,
	kotlinLspServer,
	swiftLspServer,
	terraformLspServer,
	jsonLspServer,
	yamlLspServer,
	markdownLspServer,
	shellLspServer,
	htmlLspServer,
	cssLspServer,
];
