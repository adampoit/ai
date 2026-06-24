import { standardLspServer } from "../types.ts";

export const clangdLspServer = standardLspServer({
	languages: ["cpp", "c"],
	command: "clangd",
	args: ["--background-index"],
});
