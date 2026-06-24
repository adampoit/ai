import { standardLspServer } from "../types.ts";

export const yamlLspServer = standardLspServer({
	languages: ["yaml"],
	command: "yaml-language-server",
	args: ["--stdio"],
});
