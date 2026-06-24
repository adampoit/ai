import { standardLspServer } from "../types.ts";

export const nixLspServer = standardLspServer({
	languages: ["nix"],
	command: "nixd",
	args: [],
});
