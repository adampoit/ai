import {
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	BlockFrame,
	gruvbox,
	KeyHintLine,
	renderBadge,
	renderMeter,
} from "../components/ui/index.ts";
import {
	registerUsageProvider,
	USAGE_CONTRACT_VERSION,
	USAGE_PROVIDER_EVENT,
	type UsageMetric,
	type UsageProviderContext,
	type UsageProviderRegistration,
	type UsageProviderRegistrationInput,
	type UsageSnapshot,
	type UsageTable,
	type UsageTableColumn,
	type UsageValueFormat,
	type UsageWindow,
} from "../usage-contract.ts";

export type {
	UsageMetric,
	UsageProviderContext,
	UsageProviderRegistration,
	UsageProviderRegistrationInput,
	UsageSnapshot,
	UsageTable,
	UsageTableColumn,
	UsageValueFormat,
	UsageWindow,
} from "../usage-contract.ts";

export type ProviderUsage = UsageSnapshot;
export type QuotaStatus = "ok" | "warn" | "error";

const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_LENGTH = 240;
const MAX_TABLE_ROWS = 10;
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_GO_DASHBOARD_PREFIX = "https://opencode.ai/workspace/";
const OPENCODE_GO_DASHBOARD_SUFFIX = "/go";

type JsonObject = Record<string, unknown>;

type UsageProviderView = {
	id: string;
	label: string;
	description?: string;
	loading: boolean;
	snapshot: UsageSnapshot;
};

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nested(value: unknown, path: string[]): unknown {
	let current = value;
	for (const part of path) {
		if (!isObject(current)) return undefined;
		current = current[part];
	}
	return current;
}

function clampPercent(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, value));
}

function formatCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
}

function formatCurrency(value: number): string {
	if (value === 0) return "$0.00";
	if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function safeMessage(value: unknown, fallback: string): string {
	if (typeof value !== "string" || !value.trim()) return fallback;
	return value.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH);
}

function quotaDurationMs(window: UsageWindow): number | undefined {
	if (
		window.durationMs !== undefined &&
		Number.isFinite(window.durationMs) &&
		window.durationMs > 0
	) {
		return window.durationMs;
	}
	const label = window.label.toLowerCase();
	if (label.includes("5h")) return 5 * 60 * 60 * 1000;
	if (label.includes("week")) return 7 * 24 * 60 * 60 * 1000;
	if (label.includes("month")) return 30 * 24 * 60 * 60 * 1000;
}

export function resetEta(window: UsageWindow): string | undefined {
	if (!window.resetAt) return undefined;
	const ms = new Date(window.resetAt).getTime() - Date.now();
	if (!Number.isFinite(ms)) return undefined;
	const minutes = Math.max(0, Math.round(ms / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

export function resetDate(window: UsageWindow): string | undefined {
	if (!window.resetAt) return undefined;
	const date = new Date(window.resetAt);
	if (!Number.isFinite(date.getTime())) return undefined;
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(date);
}

export function quotaPace(
	_provider: string,
	window: UsageWindow,
): number | undefined {
	if (window.remaining !== undefined && window.remaining < 0) return Infinity;
	if (window.percentRemaining === undefined || !window.resetAt)
		return undefined;
	const duration = quotaDurationMs(window);
	if (!duration) return undefined;
	const remainingMs = Math.max(
		0,
		new Date(window.resetAt).getTime() - Date.now(),
	);
	const elapsedPercent = Math.max(
		1,
		((duration - remainingMs) / duration) * 100,
	);
	const usedPercent = 100 - window.percentRemaining;
	return usedPercent / elapsedPercent;
}

export function paceColor(pace: number | undefined): QuotaStatus {
	if (pace === Infinity || (pace !== undefined && pace > 1.25))
		return "error";
	if (pace !== undefined && pace > 1) return "warn";
	return "ok";
}

export function quotaWindowStatus(
	provider: string,
	window: UsageWindow,
): QuotaStatus {
	if (window.unlimited) return "ok";
	const pace = quotaPace(provider, window);
	if (pace !== undefined) return paceColor(pace);
	if (window.percentRemaining !== undefined) {
		if (window.percentRemaining <= 10) return "error";
		if (window.percentRemaining <= 25) return "warn";
	}
	return "ok";
}

function burnRateWindows(windows: UsageWindow[]): UsageWindow[] {
	return windows.filter(
		(window) =>
			!window.unlimited && quotaDurationMs(window) !== 5 * 60 * 60 * 1000,
	);
}

export function limitingWindow(
	provider: string,
	windows: UsageWindow[],
): UsageWindow | undefined {
	return burnRateWindows(windows).reduce<UsageWindow | undefined>(
		(worst, window) => {
			if (!worst) return window;
			const worstPace = quotaPace(provider, worst) ?? -1;
			const pace = quotaPace(provider, window) ?? -1;
			return pace > worstPace ? window : worst;
		},
		undefined,
	);
}

export function quotaBar(
	percentRemaining: number | undefined,
	width: number,
): string {
	if (percentRemaining === undefined) return "·".repeat(width);
	const clamp = (value: number) => Math.max(0, Math.min(100, value));
	const used = clamp(100 - percentRemaining);
	const filled = Math.round((used / 100) * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function configPathCandidates(): string[] {
	const piConfigDir = process.env.PI_CONFIG_DIR?.trim();
	const home = process.env.HOME || process.env.USERPROFILE;
	return [
		piConfigDir ? `${piConfigDir}/usage/opencode-go.json` : undefined,
		home ? `${home}/.pi/agent/usage/opencode-go.json` : undefined,
	].filter((path): path is string => Boolean(path));
}

function configWritePath(): string {
	const candidates = configPathCandidates();
	if (candidates.length === 0) {
		throw new Error("Could not resolve an OpenCode config directory.");
	}
	return candidates[0];
}

function localSessionUsage(ctx: ExtensionCommandContext): string {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant")
			continue;
		input += entry.message.usage.input;
		output += entry.message.usage.output;
		cacheRead += entry.message.usage.cacheRead;
		cacheWrite += entry.message.usage.cacheWrite;
		cost += entry.message.usage.cost.total;
	}

	const total = input + output + cacheRead + cacheWrite;
	if (total === 0)
		return "No local token usage recorded in this Pi session yet.";

	return [
		`${formatCount(total)} tokens, ${formatCurrency(cost)} recorded cost`,
		`input ${formatCount(input)} · output ${formatCount(output)} · cache read ${formatCount(cacheRead)} · cache write ${formatCount(cacheWrite)}`,
	].join("\n");
}

async function fetchWithTimeout<T>(
	signal: AbortSignal | undefined,
	operation: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	try {
		return await operation(controller.signal);
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

async function fetchText(
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
	try {
		return await fetchWithTimeout(signal, async (requestSignal) => {
			const response = await fetch(url, {
				headers,
				signal: requestSignal,
			});
			const text = await response.text();
			if (!response.ok) {
				return { ok: false, message: `HTTP ${response.status}` };
			}
			return { ok: true, text };
		});
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

async function fetchJson(
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
	try {
		return await fetchWithTimeout(signal, async (requestSignal) => {
			const response = await fetch(url, {
				headers,
				signal: requestSignal,
			});
			if (!response.ok) {
				return { ok: false, message: `HTTP ${response.status}` };
			}
			return { ok: true, data: await response.json() };
		});
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

type StoredCredential = ReturnType<typeof readStoredCredential>;

type LegacyAuthStorage = {
	list?: () => unknown;
	get?: (key: string) => StoredCredential;
};

type ModelRegistry = ExtensionContext["modelRegistry"];

function legacyAuthStorage(
	modelRegistry: ModelRegistry,
): LegacyAuthStorage | undefined {
	return (
		modelRegistry as ModelRegistry & { authStorage?: LegacyAuthStorage }
	).authStorage;
}

function authKeysMatching(
	modelRegistry: ModelRegistry,
	patterns: RegExp[],
): string[] {
	const legacyKeys = legacyAuthStorage(modelRegistry)?.list?.();
	const keys = Array.isArray(legacyKeys)
		? legacyKeys.filter((key): key is string => typeof key === "string")
		: modelRegistry.getAll().map((model) => model.provider);
	return [...new Set(keys)]
		.filter((key) => patterns.some((pattern) => pattern.test(key)))
		.sort();
}

function storedCredential(modelRegistry: ModelRegistry, key: string) {
	return (
		legacyAuthStorage(modelRegistry)?.get?.(key) ??
		readStoredCredential(key)
	);
}

export async function openAiUsage(
	ctx: UsageProviderContext,
): Promise<UsageSnapshot> {
	const now = ctx.now ?? new Date();
	const keys = [
		"openai-codex",
		"openai",
		"codex",
		"chatgpt",
		"opencode",
		...authKeysMatching(ctx.modelRegistry, [
			/openai/i,
			/codex/i,
			/chatgpt/i,
		]),
	].filter((key, index, all) => all.indexOf(key) === index);
	const credential = keys
		.map((key) => storedCredential(ctx.modelRegistry, key))
		.find((candidate) => candidate?.type === "oauth" && candidate.access);
	if (!credential || credential.type !== "oauth" || !credential.access) {
		return {
			status: "unavailable",
			message: `No ChatGPT/OpenAI OAuth credential found. Checked: ${keys.join(", ")}.`,
		};
	}
	if (credential.expires && credential.expires < Date.now()) {
		return {
			status: "error",
			message: "OAuth token is expired; run /login for OpenAI.",
		};
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.access}`,
		"User-Agent": "pi-usage/1.0",
	};
	if (typeof credential.accountId === "string")
		headers["ChatGPT-Account-Id"] = credential.accountId;

	const response = await fetchJson(OPENAI_USAGE_URL, headers, ctx.signal);
	if (!response.ok)
		return {
			status: "error",
			message: response.message,
		};

	const primary = nested(response.data, ["rate_limit", "primary_window"]);
	const secondary = nested(response.data, ["rate_limit", "secondary_window"]);
	const codeReview = nested(response.data, [
		"code_review_rate_limit",
		"primary_window",
	]);
	const windows = [
		openAiWindow("primary", primary, now),
		openAiWindow("secondary", secondary, now),
		openAiWindow("code review", codeReview, now),
	].filter((window): window is UsageWindow => Boolean(window));

	return windows.length > 0
		? { status: "ok", windows, fetchedAt: now.toISOString() }
		: {
				status: "error",
				message: "Usage response did not include quota windows.",
			};
}

function openAiWindow(
	label: string,
	value: unknown,
	now: Date,
): UsageWindow | undefined {
	if (!isObject(value)) return undefined;
	const limit = typeof value.limit === "number" ? value.limit : undefined;
	const remaining =
		typeof value.remaining === "number" ? value.remaining : undefined;
	const used =
		limit !== undefined && remaining !== undefined
			? Math.max(0, limit - remaining)
			: undefined;
	const resetAt =
		typeof value.reset_at === "string"
			? value.reset_at
			: typeof value.reset_at === "number"
				? new Date(value.reset_at * 1000).toISOString()
				: typeof value.reset_after_seconds === "number"
					? new Date(
							now.getTime() + value.reset_after_seconds * 1000,
						).toISOString()
					: undefined;
	const durationMs =
		typeof value.limit_window_seconds === "number" &&
		value.limit_window_seconds > 0
			? value.limit_window_seconds * 1000
			: undefined;
	const percentRemaining =
		typeof value.used_percent === "number"
			? 100 - value.used_percent
			: limit && remaining !== undefined
				? (remaining / limit) * 100
				: undefined;
	return {
		label,
		used,
		total: limit,
		remaining,
		percentRemaining: clampPercent(percentRemaining),
		resetAt,
		durationMs,
	};
}

async function readOpenCodeGoConfig(): Promise<
	| { state: "configured"; workspaceId: string; authCookie: string }
	| { state: "unavailable"; message: string }
> {
	const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (workspaceId || authCookie) {
		return workspaceId && authCookie
			? { state: "configured", workspaceId, authCookie }
			: {
					state: "unavailable",
					message: workspaceId
						? "OPENCODE_GO_AUTH_COOKIE is not set."
						: "OPENCODE_GO_WORKSPACE_ID is not set.",
				};
	}

	const { readFile } = await import("node:fs/promises");
	for (const path of configPathCandidates()) {
		try {
			const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
			if (!isObject(parsed)) {
				return {
					state: "unavailable",
					message: `${path} must contain a JSON object.`,
				};
			}
			const fileWorkspaceId =
				typeof parsed.workspaceId === "string"
					? parsed.workspaceId.trim()
					: "";
			const fileAuthCookie =
				typeof parsed.authCookie === "string"
					? parsed.authCookie.trim()
					: "";
			if (
				fileAuthCookie.startsWith("Cookie '") ||
				(fileAuthCookie && fileAuthCookie.length < 40)
			) {
				return {
					state: "unavailable",
					message: `${path} does not contain a valid OpenCode auth cookie. Run /usage auth opencode-go again.`,
				};
			}
			return fileWorkspaceId && fileAuthCookie
				? {
						state: "configured",
						workspaceId: fileWorkspaceId,
						authCookie: fileAuthCookie,
					}
				: {
						state: "unavailable",
						message: `${path} is missing workspaceId or authCookie.`,
					};
		} catch (error) {
			if (isObject(error) && error.code === "ENOENT") continue;
			return { state: "unavailable", message: `Could not read ${path}.` };
		}
	}

	return {
		state: "unavailable",
		message:
			"Model auth uses OPENCODE_API_KEY, but dashboard quota currently needs browser auth. Run /usage auth opencode-go to save Pi usage auth.",
	};
}

function parseOpenCodeGoWindow(
	html: string,
	name: "rollingUsage" | "weeklyUsage" | "monthlyUsage",
	label: string,
	now: Date,
): UsageWindow | undefined {
	const number = String.raw`(-?\d+(?:\.\d+)?)`;
	const percentFirst = new RegExp(
		String.raw`${name}:\$R\[\d+\]=\{[^}]*usagePercent:${number}[^}]*resetInSec:${number}[^}]*\}`,
	);
	const resetFirst = new RegExp(
		String.raw`${name}:\$R\[\d+\]=\{[^}]*resetInSec:${number}[^}]*usagePercent:${number}[^}]*\}`,
	);
	const percentMatch = percentFirst.exec(html);
	const resetMatch = resetFirst.exec(html);
	const usagePercent = percentMatch
		? Number(percentMatch[1])
		: resetMatch
			? Number(resetMatch[2])
			: undefined;
	const resetInSec = percentMatch
		? Number(percentMatch[2])
		: resetMatch
			? Number(resetMatch[1])
			: undefined;
	if (
		usagePercent === undefined ||
		resetInSec === undefined ||
		!Number.isFinite(usagePercent) ||
		!Number.isFinite(resetInSec)
	) {
		return undefined;
	}
	return {
		label,
		percentRemaining: clampPercent(100 - usagePercent),
		resetAt: new Date(
			now.getTime() + Math.max(0, resetInSec) * 1000,
		).toISOString(),
	};
}

function genericQuotaWindows(data: unknown, now: Date): UsageWindow[] {
	const candidates = isObject(data)
		? [data, data.quota, data.usage, data.lite, data.go].filter(isObject)
		: [];
	const windows: UsageWindow[] = [];
	for (const candidate of candidates) {
		for (const [key, label] of [
			["rollingUsage", "~5h"],
			["rolling", "~5h"],
			["weeklyUsage", "weekly"],
			["weekly", "weekly"],
			["monthlyUsage", "monthly"],
			["monthly", "monthly"],
		] as const) {
			const value = candidate[key];
			if (!isObject(value)) continue;
			const usedPercent =
				typeof value.usagePercent === "number"
					? value.usagePercent
					: typeof value.usedPercent === "number"
						? value.usedPercent
						: undefined;
			const resetAt =
				typeof value.resetTimeIso === "string"
					? value.resetTimeIso
					: typeof value.resetAt === "string"
						? value.resetAt
						: typeof value.resetInSec === "number"
							? new Date(
									now.getTime() + value.resetInSec * 1000,
								).toISOString()
							: undefined;
			if (usedPercent !== undefined || resetAt) {
				windows.push({
					label,
					percentRemaining: clampPercent(
						usedPercent === undefined
							? undefined
							: 100 - usedPercent,
					),
					resetAt,
				});
			}
		}
	}
	return windows;
}

async function probeOpenCodeGoApiKey(
	ctx: UsageProviderContext,
): Promise<UsageSnapshot | undefined> {
	const apiKey =
		(await ctx.modelRegistry.getApiKeyForProvider("opencode-go")) ??
		(await ctx.modelRegistry.getApiKeyForProvider("opencode"));
	if (!apiKey) return undefined;

	const endpoints = [
		"https://opencode.ai/zen/go/v1/usage",
		"https://opencode.ai/zen/go/v1/quota",
		"https://opencode.ai/zen/go/v1/me",
		"https://opencode.ai/zen/go/v1/workspace",
		"https://opencode.ai/zen/go/v1/billing",
	];
	const failures: string[] = [];
	for (const endpoint of endpoints) {
		const response = await fetchJson(
			endpoint,
			{
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
				"User-Agent": "pi-usage/1.0",
			},
			ctx.signal,
		);
		if (!response.ok) {
			failures.push(`${endpoint.split("/").pop()}: ${response.message}`);
			continue;
		}
		const now = ctx.now ?? new Date();
		const windows = genericQuotaWindows(response.data, now);
		if (windows.length > 0) {
			return { status: "ok", windows, fetchedAt: now.toISOString() };
		}
		failures.push(`${endpoint.split("/").pop()}: no quota fields`);
	}

	return {
		status: "unavailable",
		message: `No API-key quota endpoint discovered (${failures.join("; ")}). Dashboard cookie fallback may still work.`,
	};
}

export async function openCodeGoUsage(
	ctx: UsageProviderContext,
): Promise<UsageSnapshot> {
	const now = ctx.now ?? new Date();
	const apiProbe = await probeOpenCodeGoApiKey(ctx);
	if (apiProbe?.status === "ok") return apiProbe;

	const config = await readOpenCodeGoConfig();
	if (config.state !== "configured") {
		return (
			apiProbe ?? {
				status: "unavailable",
				message: config.message,
			}
		);
	}

	const response = await fetchText(
		`${OPENCODE_GO_DASHBOARD_PREFIX}${encodeURIComponent(config.workspaceId)}${OPENCODE_GO_DASHBOARD_SUFFIX}`,
		{
			Accept: "text/html",
			Cookie: `auth=${config.authCookie}`,
			"User-Agent": "Mozilla/5.0 pi-usage/1.0",
		},
		ctx.signal,
	);
	if (!response.ok) {
		return {
			status: "error",
			message: response.message,
		};
	}

	const windows = [
		parseOpenCodeGoWindow(response.text, "rollingUsage", "~5h", now),
		parseOpenCodeGoWindow(response.text, "weeklyUsage", "weekly", now),
		parseOpenCodeGoWindow(response.text, "monthlyUsage", "monthly", now),
	].filter((window): window is UsageWindow => Boolean(window));

	return windows.length > 0
		? { status: "ok", windows, fetchedAt: now.toISOString() }
		: {
				status: "error",
				message:
					"Dashboard did not include recognizable usage windows.",
			};
}

const builtInProviders: UsageProviderRegistrationInput[] = [
	{
		id: "openai",
		label: "OpenAI",
		description: "ChatGPT and OpenAI subscription quotas.",
		load: openAiUsage,
	},
	{
		id: "opencode-go",
		label: "OpenCode Go",
		description: "OpenCode Go dashboard or API-key quotas.",
		timeoutMs: 60_000,
		load: openCodeGoUsage,
	},
];

function debugUsage(message: string, error?: unknown): void {
	if (
		process.env.PI_DEBUG !== "1" &&
		process.env.PI_DEBUG !== "true" &&
		process.env.DEBUG !== "1" &&
		process.env.DEBUG !== "true"
	)
		return;
	if (error === undefined) console.debug(`[usage] ${message}`);
	else console.debug(`[usage] ${message}`, error);
}

function validRegistration(value: unknown): value is UsageProviderRegistration {
	if (!isObject(value)) return false;
	if (value.contractVersion !== USAGE_CONTRACT_VERSION) return false;
	if (
		typeof value.id !== "string" ||
		!/^[a-z0-9][a-z0-9._-]*$/.test(value.id)
	)
		return false;
	if (typeof value.label !== "string" || !value.label.trim()) return false;
	if (
		value.description !== undefined &&
		typeof value.description !== "string"
	)
		return false;
	if (
		value.timeoutMs !== undefined &&
		(typeof value.timeoutMs !== "number" ||
			!Number.isFinite(value.timeoutMs) ||
			value.timeoutMs <= 0)
	)
		return false;
	return typeof value.load === "function";
}

function registrationErrorMessage(value: unknown): string {
	if (!isObject(value))
		return "Usage provider registration was not an object.";
	if (value.contractVersion !== USAGE_CONTRACT_VERSION) {
		return `Usage provider contract version ${String(value.contractVersion)} is not supported.`;
	}
	if (
		typeof value.id !== "string" ||
		!/^[a-z0-9][a-z0-9._-]*$/.test(value.id)
	) {
		return "Usage provider id must be lowercase letters, numbers, dots, underscores, or hyphens.";
	}
	if (typeof value.label !== "string" || !value.label.trim()) {
		return "Usage provider label is required.";
	}
	if (typeof value.load !== "function") {
		return "Usage provider load function is required.";
	}
	return "Usage provider registration has invalid fields.";
}

function createProviderRegistry(pi: ExtensionAPI): {
	providers: Map<string, UsageProviderRegistration>;
	errors: string[];
} {
	const providers = new Map<string, UsageProviderRegistration>();
	const errors: string[] = [];
	pi.events.on(USAGE_PROVIDER_EVENT, (value) => {
		if (!validRegistration(value)) {
			const message = registrationErrorMessage(value);
			errors.push(message);
			debugUsage(message);
			return;
		}
		if (providers.has(value.id)) {
			debugUsage(
				`provider '${value.id}' was replaced by a later registration`,
			);
		}
		providers.set(value.id, value);
	});

	for (const provider of builtInProviders) {
		registerUsageProvider(pi, provider);
	}
	return { providers, errors };
}

const usageFormats = new Set<UsageValueFormat>([
	"text",
	"count",
	"currency",
	"percent",
	"date",
]);

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function validWindow(value: unknown): value is UsageWindow {
	if (!isObject(value) || typeof value.label !== "string") return false;
	for (const key of [
		"used",
		"total",
		"remaining",
		"percentRemaining",
		"durationMs",
		"cost",
	] as const) {
		if (value[key] !== undefined && !finiteNumber(value[key])) return false;
	}
	if (value.resetAt !== undefined && typeof value.resetAt !== "string")
		return false;
	return (
		value.unlimited === undefined || typeof value.unlimited === "boolean"
	);
}

function validMetric(value: unknown): value is UsageMetric {
	if (!isObject(value) || typeof value.label !== "string") return false;
	if (
		(typeof value.value !== "string" && !finiteNumber(value.value)) ||
		(value.format !== undefined &&
			(typeof value.format !== "string" ||
				!usageFormats.has(value.format as UsageValueFormat)))
	)
		return false;
	return true;
}

function validTable(value: unknown): value is UsageTable {
	if (
		!isObject(value) ||
		typeof value.id !== "string" ||
		(value.title !== undefined && typeof value.title !== "string") ||
		!Array.isArray(value.columns) ||
		!Array.isArray(value.rows)
	)
		return false;
	if (
		!value.columns.every((column) => {
			if (
				!isObject(column) ||
				typeof column.key !== "string" ||
				typeof column.label !== "string"
			)
				return false;
			return (
				(column.format === undefined ||
					(typeof column.format === "string" &&
						usageFormats.has(column.format as UsageValueFormat))) &&
				(column.align === undefined ||
					column.align === "left" ||
					column.align === "right")
			);
		})
	)
		return false;
	return value.rows.every(
		(row) =>
			isObject(row) &&
			Object.values(row).every(
				(cell) =>
					cell === null ||
					typeof cell === "string" ||
					finiteNumber(cell),
			),
	);
}

function validSnapshot(value: unknown): value is UsageSnapshot {
	if (!isObject(value)) return false;
	if (
		value.status !== "ok" &&
		value.status !== "unavailable" &&
		value.status !== "error"
	)
		return false;
	if (value.message !== undefined && typeof value.message !== "string")
		return false;
	if (value.fetchedAt !== undefined && typeof value.fetchedAt !== "string")
		return false;
	if (
		value.windows !== undefined &&
		(!Array.isArray(value.windows) || !value.windows.every(validWindow))
	)
		return false;
	if (
		value.metrics !== undefined &&
		(!Array.isArray(value.metrics) || !value.metrics.every(validMetric))
	)
		return false;
	if (
		value.tables !== undefined &&
		(!Array.isArray(value.tables) || !value.tables.every(validTable))
	)
		return false;
	return true;
}

async function invokeProvider(
	pi: ExtensionAPI,
	registration: UsageProviderRegistration,
	ctx: ExtensionCommandContext,
	refresh: boolean,
	parentSignal?: AbortSignal,
): Promise<UsageSnapshot> {
	const timeoutMs = Math.min(
		Math.max(1, registration.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS),
		MAX_PROVIDER_TIMEOUT_MS,
	);
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const parentSignals = [ctx.signal, parentSignal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	const parentAbort = () => {
		const reason = parentSignals.find((signal) => signal.aborted)?.reason;
		controller.abort(reason);
	};
	for (const signal of parentSignals) {
		if (signal.aborted) parentAbort();
		else signal.addEventListener("abort", parentAbort, { once: true });
	}

	try {
		const snapshot = await registration.load({
			signal: controller.signal,
			refresh,
			now: new Date(),
			mode: ctx.mode,
			cwd: ctx.cwd,
			exec: pi.exec,
			modelRegistry: ctx.modelRegistry,
		});
		if (timedOut) {
			return {
				status: "error",
				message: `Provider timed out after ${timeoutMs}ms.`,
			};
		}
		if (!validSnapshot(snapshot)) {
			return {
				status: "error",
				message: "Provider returned an invalid usage snapshot.",
			};
		}
		return {
			...snapshot,
			message:
				snapshot.message === undefined
					? undefined
					: safeMessage(
							snapshot.message,
							"Provider returned an error.",
						),
		};
	} catch (error) {
		debugUsage(`provider '${registration.id}' failed`, error);
		return {
			status: "error",
			message: timedOut
				? `Provider timed out after ${timeoutMs}ms.`
				: "Provider failed while loading usage.",
		};
	} finally {
		clearTimeout(timeout);
		for (const signal of parentSignals) {
			signal.removeEventListener("abort", parentAbort);
		}
	}
}

function windowParts(window: UsageWindow): string[] {
	if (window.unlimited) {
		return [
			window.label.toLowerCase().includes("credit")
				? "unlimited AI credits"
				: "unlimited",
		];
	}
	return [
		window.used !== undefined && window.total !== undefined
			? `${formatCount(window.used)}/${formatCount(window.total)} used`
			: undefined,
		window.remaining !== undefined
			? `${formatCount(window.remaining)} remaining`
			: undefined,
		window.percentRemaining !== undefined
			? `${window.percentRemaining.toFixed(0)}% remaining`
			: undefined,
		window.cost !== undefined
			? `${formatCurrency(window.cost)} cost`
			: undefined,
	].filter((part): part is string => Boolean(part));
}

function usageStatus(snapshot: UsageSnapshot, label: string): QuotaStatus {
	if (snapshot.status === "error") return "error";
	if (snapshot.status === "unavailable") return "warn";
	const windows = snapshot.windows ?? [];
	const limiting = limitingWindow(label, windows);
	if (limiting) {
		const pace = quotaPace(label, limiting);
		if (pace !== undefined) return paceColor(pace);
	}
	const remaining = windows
		.filter((window) => !window.unlimited)
		.map((window) => window.percentRemaining)
		.filter((value): value is number => value !== undefined);
	if (remaining.some((value) => value <= 10)) return "error";
	if (remaining.some((value) => value <= 25)) return "warn";
	return "ok";
}

function windowBarColor(provider: string, window: UsageWindow): string {
	if (window.percentRemaining === undefined) return "muted";
	const status = quotaWindowStatus(provider, window);
	if (status === "error") return "error";
	if (status === "warn") return "warning";
	return "success";
}

function formatDateValue(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	}).format(date);
}

function formatDateTimeValue(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(date);
}

function formatUsageValue(
	value: string | number | null | undefined,
	format: UsageValueFormat = "text",
): string {
	if (value === null || value === undefined) return "—";
	if (format === "count" && typeof value === "number")
		return formatCount(value);
	if (format === "currency" && typeof value === "number")
		return formatCurrency(value);
	if (format === "percent" && typeof value === "number")
		return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
	if (format === "date") return formatDateValue(String(value));
	return String(value);
}

function renderMetric(metric: UsageMetric): string {
	return `${metric.label}: ${formatUsageValue(metric.value, metric.format)}`;
}

function alignTableCell(value: string, width: number, align: "left" | "right") {
	const truncated = truncateToWidth(value, width);
	if (align === "right") return truncated.padStart(width, " ");
	return truncated.padEnd(width, " ");
}

function renderTable(
	table: UsageTable,
	contentWidth: number,
	theme: any,
): string[] {
	const columns = table.columns.filter(
		(column): column is UsageTableColumn =>
			typeof column.key === "string" && typeof column.label === "string",
	);
	if (columns.length === 0) return [];

	const rows = table.rows.slice(0, MAX_TABLE_ROWS);
	const values = [
		columns.map((column) => column.label),
		...rows.map((row) =>
			columns.map((column) =>
				formatUsageValue(row[column.key], column.format),
			),
		),
	];
	const widths = columns.map((_, index) =>
		Math.max(...values.map((row) => row[index].length), 1),
	);
	const separatorWidth = Math.max(0, columns.length - 1) * 3;
	const availableWidth = Math.max(
		columns.length,
		contentWidth - 4 - separatorWidth,
	);
	while (widths.reduce((total, width) => total + width, 0) > availableWidth) {
		const largest = widths.indexOf(Math.max(...widths));
		if (widths[largest] <= 4) break;
		widths[largest] -= 1;
	}

	const rowText = (row: string[]) =>
		row
			.map((value, index) =>
				alignTableCell(
					value,
					widths[index],
					columns[index].align ??
						(columns[index].format &&
						columns[index].format !== "text"
							? "right"
							: "left"),
				),
			)
			.join(" | ");

	const lines = [
		truncateToWidth(
			`  ${theme.fg("dim", table.title ?? table.id)}`,
			contentWidth,
		),
		truncateToWidth(`  ${rowText(values[0])}`, contentWidth),
		truncateToWidth(
			`  ${widths.map((width) => "─".repeat(width)).join("─┼─")}`,
			contentWidth,
		),
	];
	if (rows.length === 0) {
		lines.push(truncateToWidth("  (no rows)", contentWidth));
	} else {
		lines.push(
			...values
				.slice(1)
				.map((row) =>
					truncateToWidth(`  ${rowText(row)}`, contentWidth),
				),
		);
	}
	if (table.rows.length > MAX_TABLE_ROWS) {
		lines.push(
			truncateToWidth(
				`  … ${table.rows.length - MAX_TABLE_ROWS} more rows omitted`,
				contentWidth,
			),
		);
	}
	return lines;
}

function renderUsageContent(
	providers: UsageProviderView[],
	localUsage: string,
	theme: any,
) {
	return {
		invalidate() {},
		render(contentWidth: number): string[] {
			const meterWidth = Math.max(8, Math.min(24, contentWidth - 34));
			const lines = [theme.fg("dim", "Subscription quotas and usage")];

			for (const provider of providers) {
				const status = provider.loading
					? "loading"
					: usageStatus(provider.snapshot, provider.label);
				const statusColor = provider.loading
					? gruvbox.aqua
					: status === "ok"
						? gruvbox.green
						: status === "warn"
							? gruvbox.yellow
							: gruvbox.red;
				const statusText = provider.loading
					? "loading"
					: provider.snapshot.status === "ok"
						? status
						: provider.snapshot.status;
				const statusBadge = renderBadge({
					text: statusText,
					fg: gruvbox.bg,
					bg: statusColor,
					theme,
				});
				lines.push(
					truncateToWidth(
						`${statusBadge} ${theme.fg("customMessageLabel", provider.label)}`,
						contentWidth,
					),
				);

				if (provider.loading) {
					lines.push(
						truncateToWidth(
							`  ${theme.fg("muted", "Loading…")}`,
							contentWidth,
						),
					);
					continue;
				}

				if (provider.snapshot.status !== "ok") {
					lines.push(
						truncateToWidth(
							`  ${theme.fg("muted", provider.snapshot.message ?? "No usage available")}`,
							contentWidth,
						),
					);
					continue;
				}

				for (const window of provider.snapshot.windows ?? []) {
					const resetDateText = resetDate(window);
					const parts =
						[
							...windowParts(window),
							resetDateText
								? `resets ${resetDateText}`
								: undefined,
						]
							.filter((part): part is string => Boolean(part))
							.join(" · ") || "available";
					if (window.unlimited) {
						lines.push(
							truncateToWidth(
								`  ${theme.fg("muted", parts)}`,
								contentWidth,
							),
						);
						continue;
					}
					const meter = renderMeter({
						value:
							window.percentRemaining === undefined
								? undefined
								: 1 - window.percentRemaining / 100,
						width: meterWidth,
						fg: windowBarColor(provider.label, window),
						emptyFg: gruvbox.bg3,
						theme,
					});
					const label = renderBadge({
						text: resetEta(window) ?? window.label,
						fg: gruvbox.fg0,
						bg: gruvbox.bg2,
						theme,
						paddingX: 1,
					});
					lines.push(
						truncateToWidth(
							`  ${meter} ${label} ${parts}`,
							contentWidth,
						),
					);
				}

				for (const metric of provider.snapshot.metrics ?? []) {
					lines.push(
						truncateToWidth(
							`  ${renderMetric(metric)}`,
							contentWidth,
						),
					);
				}
				for (const table of provider.snapshot.tables ?? []) {
					lines.push(...renderTable(table, contentWidth, theme));
				}
				if (provider.snapshot.fetchedAt) {
					lines.push(
						truncateToWidth(
							`  ${theme.fg("dim", `updated ${formatDateTimeValue(provider.snapshot.fetchedAt)}`)}`,
							contentWidth,
						),
					);
				}
			}

			lines.push("", theme.fg("dim", "Local Pi session usage"));
			lines.push(
				...localUsage
					.split("\n")
					.map((line) => truncateToWidth(`  ${line}`, contentWidth)),
			);
			return lines;
		},
	};
}

function decodePlaywrightString(value: string): string {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "string" ? parsed : value;
	} catch {
		return value;
	}
}

function workspaceIdFromUrl(url: string): string | undefined {
	const normalized = decodePlaywrightString(url);
	const match = /\/workspace\/([^/?#]+)(?:\/go)?(?:[?#].*)?$/.exec(
		normalized,
	);
	return match ? decodeURIComponent(match[1]) : undefined;
}

async function execText(
	pi: ExtensionAPI,
	command: string,
	args: string[],
): Promise<string | undefined> {
	const result = await pi.exec(command, args, { timeout: 30_000 });
	if (result.code !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

async function browserCookie(
	pi: ExtensionAPI,
	name: string,
): Promise<string | undefined> {
	const raw = await execText(pi, "playwright-cli", [
		"--raw",
		"run-code",
		"async page => JSON.stringify(await page.context().cookies(['https://opencode.ai', 'https://auth.opencode.ai']))",
	]);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		const cookies = (
			typeof parsed === "string" ? JSON.parse(parsed) : parsed
		) as Array<{
			name?: string;
			value?: string;
		}>;
		const cookie = cookies.find(
			(item) =>
				item.name === name && item.value && item.value.length >= 40,
		);
		return cookie?.value;
	} catch {
		return undefined;
	}
}

async function writeOpenCodeGoConfig(
	workspaceId: string,
	authCookie: string,
): Promise<string> {
	const { mkdir, writeFile, chmod } = await import("node:fs/promises");
	const { dirname } = await import("node:path");
	const path = configWritePath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({ workspaceId, authCookie }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	await chmod(path, 0o600);
	return path;
}

export default function usageExtension(pi: ExtensionAPI) {
	const registry = createProviderRegistry(pi);

	pi.registerCommand("usage", {
		description: "Show AI subscription quota and usage data",
		getArgumentCompletions: (prefix) => {
			const commands = ["--refresh", "auth opencode-go"];
			const matches = commands.filter((command) =>
				command.startsWith(prefix),
			);
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (trimmedArgs === "auth opencode-go") {
				ctx.ui.notify("Opening OpenCode in a browser…", "info");
				const opened = await pi.exec(
					"playwright-cli",
					[
						"open",
						"--headed",
						"--persistent",
						"https://opencode.ai/workspace-picker",
					],
					{ timeout: 30_000 },
				);
				if (opened.code !== 0) {
					ctx.ui.notify(
						`Could not open browser: ${opened.stderr || opened.stdout}`,
						"error",
					);
					return;
				}

				const ready = await ctx.ui.confirm(
					"OpenCode Go auth",
					"Sign in in the opened browser, then navigate to your workspace's Go page (https://opencode.ai/workspace/<id>/go). Continue when it is loaded.",
				);
				if (!ready) return;

				const href =
					(await execText(pi, "playwright-cli", [
						"--raw",
						"eval",
						"location.href",
					])) ?? "";
				let workspaceId = workspaceIdFromUrl(href);
				if (!workspaceId) {
					const entered = await ctx.ui.input(
						"Workspace ID",
						"Paste the workspace id from https://opencode.ai/workspace/<id>/go",
					);
					workspaceId = entered?.trim() || undefined;
				}
				if (!workspaceId) {
					ctx.ui.notify("No workspace id provided.", "error");
					return;
				}

				const authCookie = await browserCookie(pi, "auth");
				if (!authCookie) {
					ctx.ui.notify(
						"Could not read a valid OpenCode auth cookie. Make sure you are signed in on opencode.ai in the opened browser, then try again.",
						"error",
					);
					return;
				}

				const path = await writeOpenCodeGoConfig(
					workspaceId,
					authCookie,
				);
				ctx.ui.notify(
					`Saved OpenCode Go usage auth to ${path}`,
					"info",
				);
				return;
			}

			if (trimmedArgs !== "" && trimmedArgs !== "--refresh") {
				ctx.ui.notify("Usage: /usage [--refresh]", "error");
				return;
			}

			const refresh = trimmedArgs === "--refresh";
			const providerRegistrations = [...registry.providers.values()];
			const registeredProviderViews: UsageProviderView[] =
				providerRegistrations.map((provider) => ({
					id: provider.id,
					label: provider.label,
					description: provider.description,
					loading: true,
					snapshot: {
						status: "unavailable" as const,
						message: "Loading…",
					},
				}));
			const providerViews: UsageProviderView[] = [
				...registry.errors.map((message, index) => ({
					id: `registration-error-${index}`,
					label: "Usage provider registration",
					loading: false,
					snapshot: {
						status: "error" as const,
						message: safeMessage(
							message,
							"Invalid provider registration.",
						),
					},
				})),
				...registeredProviderViews,
			];
			const providerViewsByProvider = new Map(
				providerRegistrations.map((provider, index) => [
					provider,
					registeredProviderViews[index]!,
				]),
			);
			const localUsage = localSessionUsage(ctx);
			const providerController = new AbortController();
			let usageViewActive = true;
			let requestRender: (() => void) | undefined;
			const updateProvider = (
				provider: UsageProviderRegistration,
				snapshot: UsageSnapshot,
			) => {
				if (!usageViewActive) return;
				const view = providerViewsByProvider.get(provider);
				if (!view) return;
				view.loading = false;
				view.snapshot = snapshot;
				requestRender?.();
			};

			for (const provider of providerRegistrations) {
				void invokeProvider(
					pi,
					provider,
					ctx,
					refresh,
					providerController.signal,
				).then(
					(snapshot) => updateProvider(provider, snapshot),
					(error) => {
						debugUsage(`provider '${provider.id}' failed`, error);
						updateProvider(provider, {
							status: "error",
							message: "Provider failed while loading usage.",
						});
					},
				);
			}

			try {
				await ctx.ui.custom<void>(
					(tui, theme, kb, done) => {
						requestRender = () => tui.requestRender();
						const content = renderUsageContent(
							providerViews,
							localUsage,
							theme,
						);
						return {
							render(width: number) {
								const loadingCount = providerViews.filter(
									(provider) => provider.loading,
								).length;
								return new BlockFrame(
									{
										invalidate() {},
										render(contentWidth: number) {
											const help = new KeyHintLine(
												[
													{
														key: "esc",
														label: "close",
													},
												],
												{
													theme,
													accent: gruvbox.aqua,
												},
											).render(contentWidth);
											const body =
												content.render(contentWidth);
											return [...help, "", ...body];
										},
									},
									{
										title: {
											title: "AI Usage",
											icon: "󰚩",
											accent: gruvbox.aqua,
											badges: [
												{
													text:
														loadingCount > 0
															? `${loadingCount} loading`
															: `${providerViews.length} providers`,
													bg: gruvbox.bg2,
												},
											],
											theme,
										},
										borderColor: gruvbox.aqua,
										background: gruvbox.bg1,
										theme,
										paddingX: 1,
										paddingY: 1,
									},
								).render(width);
							},
							invalidate() {},
							handleInput(data: string) {
								if (kb.matches(data, "tui.select.cancel")) {
									done();
									return;
								}
								if (
									matchesKey(data, Key.enter) ||
									data === "q"
								) {
									done();
									return;
								}
								tui.requestRender();
							},
						};
					},
					{ overlay: false },
				);
			} finally {
				usageViewActive = false;
				requestRender = undefined;
				providerController.abort();
			}
		},
	});
}
