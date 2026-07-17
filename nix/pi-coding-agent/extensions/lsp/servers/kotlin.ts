import type { LspServerImplementation } from "../types.ts";

export const kotlinLspServer: LspServerImplementation = {
	languages: ["kotlin"],
	command: "kotlin-lsp",
	args: ["--stdio"],
};
