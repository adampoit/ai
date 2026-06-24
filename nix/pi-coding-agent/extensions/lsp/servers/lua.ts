import { standardLspServer } from "../types.ts";

export const luaLspServer = standardLspServer({
	languages: ["lua"],
	command: "lua-language-server",
	args: [],
});
