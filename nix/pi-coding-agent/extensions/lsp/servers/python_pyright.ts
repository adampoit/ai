import { standardLspServer } from "../types.ts";

export const pythonPyrightLspServer = standardLspServer({
	languages: ["python"],
	command: "basedpyright-langserver",
	args: ["--stdio"],
});
