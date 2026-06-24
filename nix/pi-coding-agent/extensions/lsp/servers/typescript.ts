import { standardLspServer } from "../types.ts";

export const typescriptLspServer = standardLspServer({
	languages: [
		"typescript",
		"javascript",
		"typescriptreact",
		"javascriptreact",
	],
	command: "vtsls",
	args: ["--stdio"],
});
