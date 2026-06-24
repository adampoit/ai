import type { LspServerImplementation } from "../types.ts";

export const kotlinLspServer: LspServerImplementation = {
	languages: ["kotlin"],
	command: "kotlin-language-server",
	args: [],
	async initializationOptions(cwd) {
		return { initializationOptions: { storagePath: cwd } };
	},
};
