import { standardLspServer } from "../types.ts";

export const htmlLspServer = standardLspServer({
	languages: ["html"],
	command: "vscode-html-language-server",
	args: ["--stdio"],
});
