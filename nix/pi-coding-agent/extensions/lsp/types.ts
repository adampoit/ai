export type DiagnosticParams = {
	files?: string[];
	scope?: "changed" | "all";
};

export type SymbolPositionParams = {
	file: string;
	symbol?: string;
	line?: number;
	character?: number;
};

export type PositionParams = {
	file: string;
	line: number;
	character: number;
};

export type Diagnostic = {
	file: string;
	line: number;
	character: number;
	severity: string;
	source?: string;
	message: string;
};

export type NotificationLevel = "error" | "warning" | "info";
export type Notify = (message: string, level?: NotificationLevel) => void;

export type LspToolResult = {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
};

export type JsonToolResult =
	| { ok: true; result: unknown }
	| { ok: false; error: string };

export type LspProcessEnvironmentContext = {
	cwd: string;
	processCwd: string;
	signal?: AbortSignal;
	defaultEnvironment: NodeJS.ProcessEnv;
};

export interface LspServerImplementation {
	languages: string[];
	command: string;
	args: string[];
	isProjectInitialized?: boolean;
	initializationOptions?: (cwd: string) => Promise<Record<string, unknown>>;
	processDirectory?: (cwd: string) => Promise<string>;
	processEnvironment?: (
		context: LspProcessEnvironmentContext,
	) => Promise<NodeJS.ProcessEnv>;
}

export function standardLspServer(
	server: Pick<LspServerImplementation, "languages" | "command" | "args">,
): LspServerImplementation {
	return server;
}
