import { standardLspServer } from "../types.ts";

export const rustLspServer = {
	...standardLspServer({
		languages: ["rust"],
		command: "rust-analyzer",
		args: [],
	}),
	isProjectInitialized: false,
	projectInitializationTimeoutMs: 60_000,
	initializationOptions: async () => ({
		initializationOptions: {
			check: {
				overrideCommand: [
					"cargo-clippy",
					"--workspace",
					"--message-format=json",
					"--keep-going",
					"--all-targets",
				],
			},
		},
	}),
};
