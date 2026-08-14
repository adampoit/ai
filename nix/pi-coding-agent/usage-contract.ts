import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const USAGE_CONTRACT_VERSION = 1 as const;
export const USAGE_PROVIDER_EVENT = "usage:register-provider" as const;

export type UsageValueFormat =
	| "text"
	| "count"
	| "currency"
	| "percent"
	| "date";

export type UsageProviderContext = {
	signal: AbortSignal;
	refresh: boolean;
	now: Date;
	mode: ExtensionContext["mode"];
	cwd: string;
	exec: ExtensionAPI["exec"];
	modelRegistry: ExtensionContext["modelRegistry"];
};

export type UsageProviderRegistration = {
	contractVersion: typeof USAGE_CONTRACT_VERSION;
	id: string;
	label: string;
	description?: string;
	timeoutMs?: number;
	load: (context: UsageProviderContext) => Promise<UsageSnapshot>;
};

export type UsageProviderRegistrationInput = Omit<
	UsageProviderRegistration,
	"contractVersion"
>;

export type UsageSnapshot = {
	status: "ok" | "unavailable" | "error";
	message?: string;
	windows?: UsageWindow[];
	metrics?: UsageMetric[];
	tables?: UsageTable[];
	fetchedAt?: string;
};

export type UsageWindow = {
	label: string;
	used?: number;
	total?: number;
	remaining?: number;
	percentRemaining?: number;
	resetAt?: string;
	durationMs?: number;
	unlimited?: boolean;
	cost?: number;
};

export type UsageMetric = {
	label: string;
	value: string | number;
	format?: UsageValueFormat;
};

export type UsageTable = {
	id: string;
	title?: string;
	columns: UsageTableColumn[];
	rows: Array<Record<string, string | number | null>>;
};

export type UsageTableColumn = {
	key: string;
	label: string;
	format?: UsageValueFormat;
	align?: "left" | "right";
};

export function registerUsageProvider(
	pi: ExtensionAPI,
	registration: UsageProviderRegistrationInput,
): void {
	pi.events.emit(USAGE_PROVIDER_EVENT, {
		...registration,
		contractVersion: USAGE_CONTRACT_VERSION,
	});
}
