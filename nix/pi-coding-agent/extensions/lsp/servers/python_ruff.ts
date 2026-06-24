import { standardLspServer } from "../types.ts";

export const pythonRuffLspServer = standardLspServer({
	languages: ["python"],
	command: "ruff",
	args: ["server"],
});
