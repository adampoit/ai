import { standardLspServer } from "../types.ts";

export const terraformLspServer = standardLspServer({
	languages: ["terraform"],
	command: "terraform-ls",
	args: ["serve"],
});
