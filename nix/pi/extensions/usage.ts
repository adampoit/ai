import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Box, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

const REQUEST_TIMEOUT_MS = 12_000;
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const OPENCODE_GO_DASHBOARD_PREFIX = "https://opencode.ai/workspace/";
const OPENCODE_GO_DASHBOARD_SUFFIX = "/go";

export type UsageWindow = {
	label: string;
	used?: number;
	total?: number;
	remaining?: number;
	percentRemaining?: number;
	resetAt?: string;
	unlimited?: boolean;
};

export type ProviderUsage = {
	provider: string;
	status: "ok" | "unavailable" | "error";
	message?: string;
	windows?: UsageWindow[];
};

type JsonObject = Record<string, unknown>;

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

function firstNumber(value: unknown, paths: string[][]): number | undefined {
	for (const path of paths) {
		const item = nested(value, path);
		if (typeof item === "number" && Number.isFinite(item)) return item;
	}
}

function firstString(value: unknown, paths: string[][]): string | undefined {
	for (const path of paths) {
		const item = nested(value, path);
		if (typeof item === "string" && item.trim()) return item.trim();
	}
}

function firstBoolean(value: unknown, paths: string[][]): boolean | undefined {
	for (const path of paths) {
		const item = nested(value, path);
		if (typeof item === "boolean") return item;
	}
}

function clampPercent(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, value));
}

function formatCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1000000).toFixed(2)}M`;
}

function formatCurrency(value: number): string {
	if (value === 0) return "$0.00";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function formatReset(value: string | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return `, resets ${value}`;
	return `, resets ${date.toLocaleString()}`;
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
		const message = entry.message as AssistantMessage;
		input += message.usage.input;
		output += message.usage.output;
		cacheRead += message.usage.cacheRead;
		cacheWrite += message.usage.cacheWrite;
		cost += message.usage.cost.total;
	}

	const total = input + output + cacheRead + cacheWrite;
	if (total === 0)
		return "No local token usage recorded in this Pi session yet.";

	return [
		`${formatCount(total)} tokens, ${formatCurrency(cost)} estimated cost`,
		`input ${formatCount(input)} · output ${formatCount(output)} · cache read ${formatCount(cacheRead)} · cache write ${formatCount(cacheWrite)}`,
	].join("\n");
}

async function fetchText(
	url: string,
	headers: Record<string, string>,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers,
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			return {
				ok: false,
				message: `HTTP ${response.status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 160)}` : ""}`,
			};
		}
		return { ok: true, text };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchJson(
	url: string,
	headers: Record<string, string>,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			const text = (await response.text())
				.replace(/\s+/g, " ")
				.slice(0, 160);
			return {
				ok: false,
				message: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
			};
		}
		return { ok: true, data: await response.json() };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

function authKeysMatching(ctx: ExtensionContext, patterns: RegExp[]): string[] {
	return ctx.modelRegistry.authStorage
		.list()
		.filter((key) => patterns.some((pattern) => pattern.test(key)))
		.sort();
}

export async function openAiUsage(
	ctx: ExtensionContext,
): Promise<ProviderUsage> {
	const keys = [
		"openai-codex",
		"openai",
		"codex",
		"chatgpt",
		"opencode",
		...authKeysMatching(ctx, [/openai/i, /codex/i, /chatgpt/i]),
	].filter((key, index, all) => all.indexOf(key) === index);
	const credential = keys
		.map((key) => ctx.modelRegistry.authStorage.get(key))
		.find((candidate) => candidate?.type === "oauth" && candidate.access);
	if (!credential || credential.type !== "oauth" || !credential.access) {
		return {
			provider: "OpenAI",
			status: "unavailable",
			message: `No ChatGPT/OpenAI OAuth credential found. Checked: ${keys.join(", ")}.`,
		};
	}
	if (credential.expires && credential.expires < Date.now()) {
		return {
			provider: "OpenAI",
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

	const response = await fetchJson(OPENAI_USAGE_URL, headers);
	if (!response.ok)
		return {
			provider: "OpenAI",
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
		openAiWindow("primary", primary),
		openAiWindow("secondary", secondary),
		openAiWindow("code review", codeReview),
	].filter((window): window is UsageWindow => Boolean(window));

	return windows.length > 0
		? { provider: "OpenAI", status: "ok", windows }
		: {
				provider: "OpenAI",
				status: "error",
				message: "Usage response did not include quota windows.",
			};
}

function openAiWindow(label: string, value: unknown): UsageWindow | undefined {
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
							Date.now() + value.reset_after_seconds * 1000,
						).toISOString()
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
			Date.now() + Math.max(0, resetInSec) * 1000,
		).toISOString(),
	};
}

function genericQuotaWindows(data: unknown): UsageWindow[] {
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
									Date.now() + value.resetInSec * 1000,
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
	ctx: ExtensionContext,
): Promise<ProviderUsage | undefined> {
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
		const response = await fetchJson(endpoint, {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": "pi-usage/1.0",
		});
		if (!response.ok) {
			failures.push(`${endpoint.split("/").pop()}: ${response.message}`);
			continue;
		}
		const windows = genericQuotaWindows(response.data);
		if (windows.length > 0) {
			return { provider: "OpenCode Go", status: "ok", windows };
		}
		failures.push(`${endpoint.split("/").pop()}: no quota fields`);
	}

	return {
		provider: "OpenCode Go",
		status: "unavailable",
		message: `No API-key quota endpoint discovered (${failures.join("; ")}). Dashboard cookie fallback may still work.`,
	};
}

export async function openCodeGoUsage(
	ctx: ExtensionContext,
): Promise<ProviderUsage> {
	const apiProbe = await probeOpenCodeGoApiKey(ctx);
	if (apiProbe?.status === "ok") return apiProbe;

	const config = await readOpenCodeGoConfig();
	if (config.state !== "configured") {
		return (
			apiProbe ?? {
				provider: "OpenCode Go",
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
	);
	if (!response.ok) {
		return {
			provider: "OpenCode Go",
			status: "error",
			message: response.message,
		};
	}

	const windows = [
		parseOpenCodeGoWindow(response.text, "rollingUsage", "~5h"),
		parseOpenCodeGoWindow(response.text, "weeklyUsage", "weekly"),
		parseOpenCodeGoWindow(response.text, "monthlyUsage", "monthly"),
	].filter((window): window is UsageWindow => Boolean(window));

	return windows.length > 0
		? { provider: "OpenCode Go", status: "ok", windows }
		: {
				provider: "OpenCode Go",
				status: "error",
				message:
					"Dashboard did not include recognizable usage windows.",
			};
}

type CopilotToken = {
	token: string;
	scheme: "bearer" | "token";
	source: string;
};

async function copilotTokens(ctx: ExtensionContext): Promise<CopilotToken[]> {
	const keys = [
		"github-copilot",
		"copilot",
		"github",
		...authKeysMatching(ctx, [/github/i, /copilot/i]),
	].filter((key, index, all) => all.indexOf(key) === index);
	const tokens = await Promise.all(
		keys.map(async (key): Promise<CopilotToken[]> => {
			const credential = ctx.modelRegistry.authStorage.get(key);
			if (credential?.type === "oauth") {
				return [
					credential.refresh
						? {
								token: credential.refresh,
								scheme: "token" as const,
								source: `${key}:refresh`,
							}
						: undefined,
					credential.access
						? {
								token: credential.access,
								scheme: "bearer" as const,
								source: `${key}:access`,
							}
						: undefined,
				].filter((item): item is CopilotToken => Boolean(item));
			}
			if (credential?.type === "api_key" && credential.key) {
				return [
					{
						token: credential.key,
						scheme: "token" as const,
						source: `${key}:api_key`,
					},
				];
			}
			const token = await ctx.modelRegistry.getApiKeyForProvider(key);
			return token
				? [
						{
							token,
							scheme: "bearer" as const,
							source: `${key}:resolved`,
						},
					]
				: [];
		}),
	);
	return [
		...tokens.flat(),
		process.env.COPILOT_GITHUB_TOKEN
			? {
					token: process.env.COPILOT_GITHUB_TOKEN,
					scheme: "token" as const,
					source: "COPILOT_GITHUB_TOKEN",
				}
			: undefined,
		process.env.GH_TOKEN
			? {
					token: process.env.GH_TOKEN,
					scheme: "token" as const,
					source: "GH_TOKEN",
				}
			: undefined,
		process.env.GITHUB_TOKEN
			? {
					token: process.env.GITHUB_TOKEN,
					scheme: "token" as const,
					source: "GITHUB_TOKEN",
				}
			: undefined,
	]
		.filter((item): item is CopilotToken => Boolean(item))
		.filter(
			(item, index, all) =>
				all.findIndex(
					(other) =>
						other.token === item.token &&
						other.scheme === item.scheme,
				) === index,
		);
}

export async function copilotUsage(
	ctx: ExtensionContext,
): Promise<ProviderUsage> {
	const tokens = await copilotTokens(ctx);
	if (tokens.length === 0) {
		return {
			provider: "GitHub Copilot",
			status: "unavailable",
			message:
				"No GitHub/Copilot token found in Pi auth or GitHub token environment variables.",
		};
	}

	let response: Awaited<ReturnType<typeof fetchJson>> | undefined;
	for (const token of tokens) {
		response = await fetchJson(COPILOT_USER_URL, {
			Authorization: `${token.scheme === "token" ? "token" : "Bearer"} ${token.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2025-04-01",
			"User-Agent": "GitHubCopilotChat/0.47.1",
			"X-Vscode-User-Agent-Library-Version": "electron-fetch",
		});
		if (response.ok) break;
	}
	if (!response?.ok)
		return {
			provider: "GitHub Copilot",
			status: "error",
			message: `${response?.message ?? "Unknown error"}. Tried ${tokens.length} token source(s); Copilot model access tokens are not accepted by GitHub REST quota endpoints, but the original GitHub OAuth token should be.`,
		};

	const total = firstNumber(response.data, [
		["quota", "limit"],
		["quota", "total"],
		["monthly_quota", "limit"],
		["monthly_premium_requests", "limit"],
		["premium_requests", "limit"],
		["quota_snapshots", "premium_interactions", "entitlement"],
		["limit"],
		["quota_limit"],
	]);
	const used = firstNumber(response.data, [
		["quota", "used"],
		["monthly_quota", "used"],
		["monthly_premium_requests", "used"],
		["premium_requests", "used"],
		["used"],
		["quota_used"],
		["premium_requests_used"],
	]);
	const remaining = firstNumber(response.data, [
		["quota", "remaining"],
		["monthly_quota", "remaining"],
		["monthly_premium_requests", "remaining"],
		["premium_requests", "remaining"],
		["quota_snapshots", "premium_interactions", "remaining"],
		["remaining"],
		["quota_remaining"],
	]);
	const resetAt = firstString(response.data, [
		["quota", "reset_at"],
		["monthly_quota", "reset_at"],
		["monthly_premium_requests", "reset_at"],
		["premium_requests", "reset_at"],
		["reset_at"],
		["quota_reset_date_utc"],
		["quota_reset_date"],
		["quota_reset_at"],
	]);
	const explicitPercent = firstNumber(response.data, [
		["quota", "percent_remaining"],
		["monthly_quota", "percent_remaining"],
		["monthly_premium_requests", "percent_remaining"],
		["premium_requests", "percent_remaining"],
		["quota_snapshots", "premium_interactions", "percent_remaining"],
		["percent_remaining"],
	]);
	const unlimited = firstBoolean(response.data, [
		["quota", "unlimited"],
		["monthly_quota", "unlimited"],
		["monthly_premium_requests", "unlimited"],
		["premium_requests", "unlimited"],
		["quota_snapshots", "premium_interactions", "unlimited"],
		["unlimited"],
	]);

	const resolvedTotal =
		total ??
		(used !== undefined && remaining !== undefined
			? used + remaining
			: undefined);
	const resolvedUsed =
		used ??
		(resolvedTotal !== undefined && remaining !== undefined
			? Math.max(0, resolvedTotal - remaining)
			: undefined);
	const percentRemaining =
		explicitPercent ??
		(resolvedTotal && resolvedUsed !== undefined
			? ((resolvedTotal - resolvedUsed) / resolvedTotal) * 100
			: undefined);

	if (
		!unlimited &&
		resolvedTotal === undefined &&
		resolvedUsed === undefined &&
		remaining === undefined
	) {
		return {
			provider: "GitHub Copilot",
			status: "error",
			message: "Usage response did not include quota fields.",
		};
	}

	return {
		provider: "GitHub Copilot",
		status: "ok",
		windows: [
			{
				label: "premium requests",
				used: resolvedUsed,
				total: resolvedTotal,
				remaining,
				percentRemaining: clampPercent(percentRemaining),
				resetAt,
				unlimited,
			},
		],
	};
}

function windowParts(window: UsageWindow): string[] {
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
		window.unlimited ? "unlimited" : undefined,
	].filter((part): part is string => Boolean(part));
}

function usageBar(percentRemaining: number | undefined, width: number): string {
	const barWidth = Math.max(4, width);
	if (percentRemaining === undefined) return "·".repeat(barWidth);
	const usedPercent = 100 - clampPercent(percentRemaining)!;
	const filled = Math.round((usedPercent / 100) * barWidth);
	return `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
}

function usageStatus(result: ProviderUsage): "ok" | "warn" | "error" {
	if (result.status === "error") return "error";
	if (result.status === "unavailable") return "warn";
	const remaining = (result.windows ?? [])
		.map((window) => window.percentRemaining)
		.filter((value): value is number => value !== undefined);
	if (remaining.some((value) => value <= 10)) return "error";
	if (remaining.some((value) => value <= 25)) return "warn";
	return "ok";
}

function renderUsageReport(
	providers: ProviderUsage[],
	localUsage: string,
	theme: any,
) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild({
		invalidate() {},
		render(width: number): string[] {
			const contentWidth = Math.max(20, width - 2);
			const barWidth = Math.max(8, Math.min(24, contentWidth - 34));
			const lines = [
				theme.fg("accent", theme.bold("AI Usage")),
				theme.fg("dim", "Subscription quotas"),
			];

			for (const provider of providers) {
				const status = usageStatus(provider);
				const color =
					status === "ok"
						? "success"
						: status === "warn"
							? "warning"
							: "error";
				const icon =
					status === "ok" ? "●" : status === "warn" ? "▲" : "●";
				lines.push(
					truncateToWidth(
						`${theme.fg(color, icon)} ${theme.fg("customMessageLabel", provider.provider)}${provider.status === "ok" ? "" : ` — ${provider.status}`}`,
						contentWidth,
					),
				);

				if (provider.status !== "ok") {
					lines.push(
						truncateToWidth(
							`  ${theme.fg("muted", provider.message ?? "No usage available")}`,
							contentWidth,
						),
					);
					continue;
				}

				for (const window of provider.windows ?? []) {
					const used = theme.fg(
						color,
						usageBar(window.percentRemaining, barWidth),
					);
					const parts =
						windowParts(window).join(" · ") || "available";
					lines.push(
						truncateToWidth(
							`  ${used} ${window.label}: ${parts}${formatReset(window.resetAt)}`,
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
	});
	return box;
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
	pi.registerCommand("usage", {
		description: "Show AI subscription quota and local Pi token usage",
		getArgumentCompletions: (prefix) => {
			const commands = ["auth opencode-go"];
			const matches = commands.filter((command) =>
				command.startsWith(prefix),
			);
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			if (args.trim() === "auth opencode-go") {
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

			ctx.ui.notify("Checking AI usage…", "info");

			const providers = await Promise.all([
				openAiUsage(ctx),
				copilotUsage(ctx),
				openCodeGoUsage(ctx),
			]);
			const localUsage = localSessionUsage(ctx);

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const report = renderUsageReport(providers, localUsage, theme);
				return {
					invalidate: () => report.invalidate(),
					render: (width: number) => [
						...report.render(width),
						theme.fg("dim", "esc/enter/q close"),
					],
					handleInput: (data: string) => {
						if (
							matchesKey(data, Key.escape) ||
							matchesKey(data, Key.enter) ||
							data === "q"
						) {
							done();
							return;
						}
						tui.requestRender();
					},
				};
			});
		},
	});
}
