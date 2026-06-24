import { standardLspServer } from "../types.ts";

export const jsonLspServer = standardLspServer({
	languages: ["json", "jsonc"],
	command: "vscode-json-language-server",
	args: ["--stdio"],
});
