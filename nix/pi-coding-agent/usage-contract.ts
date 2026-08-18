import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const USAGE_CONTRACT_VERSION = 1 as const;
export const USAGE_PROVIDER_EVENT = "usage:register-provider" as const;

const USAGE_PROVIDER_REGISTRY = Symbol.for(
	"pi-coding-agent.usage-provider-registry",
);

type UsageProviderRegistryState = {
	registrations: unknown[];
};

type UsageProviderEventBus = ExtensionAPI["events"] & {
	[key: symbol]: unknown;
};

function getUsageProviderRegistry(
	pi: ExtensionAPI,
): UsageProviderRegistryState {
	const events = pi.events as UsageProviderEventBus;
	const existing = events[USAGE_PROVIDER_REGISTRY];
	if (existing && typeof existing === "object") {
		return existing as UsageProviderRegistryState;
	}

	const registry: UsageProviderRegistryState = { registrations: [] };
	Object.defineProperty(events, USAGE_PROVIDER_REGISTRY, {
		value: registry,
	});
	return registry;
}

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

export function getRegisteredUsageProviders(
	pi: ExtensionAPI,
): readonly unknown[] {
	return [...getUsageProviderRegistry(pi).registrations];
}

export function registerUsageProvider(
	pi: ExtensionAPI,
	registration: UsageProviderRegistrationInput,
): void {
	const value = {
		...registration,
		contractVersion: USAGE_CONTRACT_VERSION,
	};
	getUsageProviderRegistry(pi).registrations.push(value);
	pi.events.emit(USAGE_PROVIDER_EVENT, value);
}
