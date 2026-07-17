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
				command: "clippy",
			},
		},
	}),
};
