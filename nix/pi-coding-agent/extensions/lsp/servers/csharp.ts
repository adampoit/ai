import type { LspServerImplementation } from "../types.ts";

export const csharpLspServer: LspServerImplementation = {
	languages: ["csharp"],
	command: "Microsoft.CodeAnalysis.LanguageServer",
	args: ["--stdio", "--autoLoadProjects"],
	isProjectInitialized: false,
};
