import { standardLspServer } from "../types.ts";

export const shellLspServer = standardLspServer({
	languages: ["shellscript"],
	command: "bash-language-server",
	args: ["start"],
});
