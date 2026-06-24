import { standardLspServer } from "../types.ts";

export const cssLspServer = standardLspServer({
	languages: ["css", "scss", "less"],
	command: "vscode-css-language-server",
	args: ["--stdio"],
});
