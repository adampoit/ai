import { standardLspServer } from "../types.ts";

export const markdownLspServer = standardLspServer({
	languages: ["markdown"],
	command: "marksman",
	args: ["server"],
});
