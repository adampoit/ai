import { standardLspServer } from "../types.ts";

export const rustLspServer = {
	...standardLspServer({
		languages: ["rust"],
		command: "rust-analyzer",
		args: [],
	}),
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
