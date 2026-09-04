import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	gruvbox,
	PowerlineStatusLine,
	renderPowerlineLeft,
	renderPowerlineRight,
	stripAnsi,
	type PowerlineSegment,
	type PowerlineTextSpan,
} from "../components/ui/index.ts";
import {
	limitingWindow,
	openAiUsage,
	openCodeGoUsage,
	quotaBar,
	quotaWindowStatus,
	resetEta,
	type ProviderUsage,
	type UsageProviderContext,
	type UsageWindow,
} from "./usage.ts";

const BUDGET_BACKGROUND = gruvbox.bg1;
const FOOTER_PRIORITY = {
	diagnostics: 10,
	performance: 20,
	quota: 30,
	cost: 40,
	branch: 80,
	project: 90,
	model: 100,
} as const;

function projectPath(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function formatCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

type CacheUsage = {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

type CacheStats = {
	hasCache: boolean;
	latestHitRate?: number;
};

function sessionCacheStats(ctx: ExtensionContext): CacheStats {
	const stats: CacheStats = { hasCache: false };

	function addUsage(usage: CacheUsage | undefined, latest = false): void {
		if (!usage) return;
		const input = usage.input ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		stats.hasCache ||= cacheRead > 0 || cacheWrite > 0;

		if (latest) {
			const promptTokens = input + cacheRead + cacheWrite;
			stats.latestHitRate =
				promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
		}
	}

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addUsage(entry.message.usage, true);
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.usage
		) {
			addUsage(entry.message.usage);
		} else if (
			(entry.type === "branch_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			addUsage(entry.usage);
		}
	}

	return stats;
}

function cacheStatsText(stats: CacheStats): string {
	if (!stats.hasCache) return "";
	return stats.latestHitRate !== undefined
		? `hit ${stats.latestHitRate.toFixed(1)}%`
		: "cache";
}

function cacheColor(hitRate: number | undefined): string {
	if (hitRate === undefined) return gruvbox.brightBlue;
	if (hitRate >= 80) return gruvbox.brightGreen;
	if (hitRate >= 50) return gruvbox.brightYellow;
	return gruvbox.brightRed;
}

type PerformanceVariant = PowerlineSegment[];

function performanceVariants(
	cacheStats: CacheStats,
	tokensPerSecond: number | undefined,
	contextText: string | undefined,
	contextPercent: number | null | undefined,
): PerformanceVariant[] {
	const cacheText = cacheStatsText(cacheStats);
	const throughput =
		tokensPerSecond === undefined
			? ""
			: formatTokensPerSecond(tokensPerSecond);
	const makeVariant = (
		includeCache: boolean,
		includeThroughput: boolean,
		includeContext: boolean,
	): PerformanceVariant => {
		const spans = [
			includeCache && cacheText
				? {
						text: cacheText,
						fg: cacheColor(cacheStats.latestHitRate),
					}
				: undefined,
			includeThroughput && throughput
				? { text: throughput, fg: gruvbox.brightBlue }
				: undefined,
			includeContext && contextText
				? {
						text: contextText,
						fg: contextColor(contextPercent),
					}
				: undefined,
		].filter((span): span is PowerlineTextSpan => span !== undefined);
		if (spans.length === 0) return [];
		return [
			{
				text: spans.map((span) => span.text).join(" · "),
				fg: spans[0].fg,
				bg: gruvbox.bg2,
				priority: FOOTER_PRIORITY.performance,
				spans: spans.length > 1 ? spans : undefined,
			},
		];
	};

	const variants =
		cacheText && throughput && contextText
			? [
					makeVariant(true, true, true),
					makeVariant(true, false, true),
					makeVariant(false, false, true),
				]
			: cacheText && throughput
				? [
						makeVariant(true, true, false),
						makeVariant(true, false, false),
						makeVariant(false, true, false),
					]
				: cacheText && contextText
					? [
							makeVariant(true, false, true),
							makeVariant(false, false, true),
						]
					: throughput && contextText
						? [
								makeVariant(false, true, true),
								makeVariant(false, false, true),
							]
						: cacheText
							? [makeVariant(true, false, false)]
							: throughput
								? [makeVariant(false, true, false)]
								: contextText
									? [makeVariant(false, false, true)]
									: [];
	const seen = new Set<string>();
	return variants.filter((variant) => {
		const key = variant.map((part) => part.text).join("\u0000");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function formatStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function compactStatus(key: string, text: string): string {
	const plain = stripAnsi(text);
	const checks = [...plain.matchAll(/|✓/g)].length;
	if (key.includes("format") || plain.startsWith("fmt:"))
		return checks > 0 ? `fmt ✓${checks}` : "fmt";
	if (key.includes("lsp") || plain.startsWith("lsp:"))
		return checks > 0 ? `lsp ✓${checks}` : "lsp";
	return truncateToWidth(plain, 18, "…");
}

function quotaProvider(provider: string): "openai" | "opencode-go" | undefined {
	const normalized = provider.toLowerCase();
	if (normalized.includes("openai") || normalized.includes("codex"))
		return "openai";
	if (normalized.includes("opencode")) return "opencode-go";
}

function usageProviderContext(
	ctx: ExtensionContext,
	exec: ExtensionAPI["exec"],
): UsageProviderContext {
	return {
		signal: ctx.signal ?? new AbortController().signal,
		refresh: false,
		now: new Date(),
		mode: ctx.mode,
		cwd: ctx.cwd,
		exec,
		modelRegistry: ctx.modelRegistry,
	};
}

async function fetchQuota(
	provider: ReturnType<typeof quotaProvider>,
	ctx: ExtensionContext,
	exec: ExtensionAPI["exec"],
): Promise<ProviderUsage | undefined> {
	const providerContext = usageProviderContext(ctx, exec);
	if (provider === "openai") return openAiUsage(providerContext);
	if (provider === "opencode-go") return openCodeGoUsage(providerContext);
}

function formatOverage(count: number): string {
	const absolute = Math.abs(count);
	if (absolute < 1000) return absolute.toString();
	if (absolute < 1000000) return `${(absolute / 1000).toFixed(1)}k`;
	return `${(absolute / 1000000).toFixed(1)}M`;
}

function quotaPercent(window: UsageWindow): string {
	if (window.remaining !== undefined && window.remaining < 0)
		return `+${formatOverage(window.remaining)}`;
	return window.percentRemaining === undefined
		? "?"
		: `${window.percentRemaining.toFixed(0)}%`;
}

function quotaCompact(window: UsageWindow): string {
	if (window.unlimited) return "unlimited";
	return `${resetEta(window) ?? window.label} ${quotaPercent(window)}`;
}

function quotaVisual(
	window: UsageWindow,
	limiting: UsageWindow | undefined,
): string {
	if (window !== limiting || window.unlimited) return quotaCompact(window);
	return `${resetEta(window) ?? window.label} ${quotaBar(window.percentRemaining, 6)} ${quotaPercent(window)}`;
}

function sessionCostVariants(ctx: ExtensionContext): PowerlineSegment[] {
	let totalCost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			totalCost += entry.message.usage.cost.total;
		}
	}
	if (!totalCost) return [];
	return [
		{
			text: `$${totalCost.toFixed(3)}`,
			fg: gruvbox.brightYellow,
			bg: BUDGET_BACKGROUND,
			priority: FOOTER_PRIORITY.cost,
		},
	];
}

function quotaVariants(
	result: ProviderUsage | undefined,
	provider: string,
	loading: boolean,
): PowerlineSegment[] {
	if (loading)
		return [
			{
				text: "quota …",
				fg: gruvbox.fg3,
				bg: BUDGET_BACKGROUND,
				priority: FOOTER_PRIORITY.quota,
			},
		];
	if (!result)
		return [
			{
				text: "quota n/a",
				fg: gruvbox.fg3,
				bg: BUDGET_BACKGROUND,
				priority: FOOTER_PRIORITY.quota,
			},
		];
	if (result.status !== "ok")
		return [
			{
				text: `quota ${result.status}`,
				fg: gruvbox.fg3,
				bg: BUDGET_BACKGROUND,
				priority: FOOTER_PRIORITY.quota,
			},
		];
	const windows = (result.windows ?? [])
		.filter(
			(window) =>
				window.unlimited ||
				window.percentRemaining !== undefined ||
				window.remaining !== undefined,
		)
		.slice(0, 3);
	if (windows.length === 0)
		return [
			{
				text: "quota ?",
				fg: gruvbox.fg3,
				bg: BUDGET_BACKGROUND,
				priority: FOOTER_PRIORITY.quota,
			},
		];

	const limiting = limitingWindow(provider, windows);
	const status = limiting ? quotaWindowStatus(provider, limiting) : "ok";
	const color =
		status === "error"
			? gruvbox.brightRed
			: status === "warn"
				? gruvbox.brightYellow
				: gruvbox.brightGreen;
	const compact = windows.map(quotaCompact);
	return [
		{
			text: windows
				.map((window) => quotaVisual(window, limiting))
				.join(" · "),
			fg: color,
			bg: BUDGET_BACKGROUND,
			priority: FOOTER_PRIORITY.quota,
		},
		{
			text: compact.slice(0, 2).join(" · "),
			fg: color,
			bg: BUDGET_BACKGROUND,
			priority: FOOTER_PRIORITY.quota,
		},
		{
			text: quotaCompact(limiting ?? windows[0]),
			fg: color,
			bg: BUDGET_BACKGROUND,
			priority: FOOTER_PRIORITY.quota,
		},
	];
}

function contextColor(percent: number | null | undefined): string {
	if (percent == null) return gruvbox.fg3;
	if (percent >= 90) return gruvbox.brightRed;
	if (percent >= 70) return gruvbox.brightYellow;
	return gruvbox.brightGreen;
}

function formatTokensPerSecond(tokensPerSecond: number): string {
	return tokensPerSecond < 100
		? `${tokensPerSecond.toFixed(1)} t/s`
		: `${Math.round(tokensPerSecond)} t/s`;
}

function latestThinkingLevel(
	entries: ReadonlyArray<{ type: string; thinkingLevel?: string }>,
): string {
	let level = "off";
	for (const entry of entries) {
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			level = entry.thinkingLevel;
		}
	}
	return level;
}

function projectSegment(cwd: string): PowerlineSegment {
	return {
		text: `π ${projectPath(cwd)}`,
		fg: gruvbox.fg0,
		bg: gruvbox.blue,
		priority: FOOTER_PRIORITY.project,
	};
}

function branchSegment(branch: string | null): PowerlineSegment {
	return branch
		? {
				text: ` ${branch}`,
				fg: gruvbox.green,
				bg: gruvbox.bg2,
				priority: FOOTER_PRIORITY.branch,
			}
		: {
				text: "",
				fg: gruvbox.gray,
				bg: gruvbox.bg2,
				priority: FOOTER_PRIORITY.branch,
			};
}

function modelSegment(text: string): PowerlineSegment {
	return {
		text,
		fg: gruvbox.fg0,
		bg: gruvbox.orange,
		priority: FOOTER_PRIORITY.model,
	};
}

export default function (pi: ExtensionAPI) {
	let requestStartedAt: number | undefined;
	let turnOutputTokens = 0;
	let turnProviderDurationMs = 0;
	let turnTokensPerSecond: number | undefined;
	let markQuotaStale: (() => void) | undefined;
	let requestFooterRender: (() => void) | undefined;

	pi.on("agent_end", () => {
		markQuotaStale?.();
	});

	pi.on("before_agent_start", () => {
		requestStartedAt = undefined;
		turnOutputTokens = 0;
		turnProviderDurationMs = 0;
		turnTokensPerSecond = undefined;
		requestFooterRender?.();
	});

	pi.on("before_provider_request", () => {
		requestStartedAt = performance.now();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const startedAt = requestStartedAt;
		requestStartedAt = undefined;
		if (
			startedAt === undefined ||
			!Number.isFinite(event.message.usage.output) ||
			event.message.usage.output < 0
		)
			return;

		const durationMs = performance.now() - startedAt;
		if (durationMs <= 0) return;
		turnOutputTokens += event.message.usage.output;
		turnProviderDurationMs += durationMs;
		turnTokensPerSecond =
			turnOutputTokens / (turnProviderDurationMs / 1000);
		requestFooterRender?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() =>
				tui.requestRender(),
			);
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;
			let quota: ProviderUsage | undefined;
			let quotaKey: ReturnType<typeof quotaProvider>;
			let quotaLoading = false;
			let quotaStale = true;

			markQuotaStale = () => {
				quotaStale = true;
				tui.requestRender();
			};

			const refreshQuota = () => {
				const provider = ctx.model
					? quotaProvider(ctx.model.provider)
					: undefined;
				if (!provider || quotaLoading) return;
				if (provider === quotaKey && !quotaStale) return;
				const providerChanged = provider !== quotaKey;
				quotaKey = provider;
				if (providerChanged) quota = undefined;
				quotaStale = false;
				quotaLoading = true;
				void fetchQuota(provider, ctx, pi.exec)
					.then((result) => {
						if (quotaKey === provider) quota = result;
					})
					.catch(() => {
						if (quotaKey === provider) quota = undefined;
					})
					.finally(() => {
						quotaLoading = false;
						tui.requestRender();
					});
			};

			return {
				dispose: () => {
					if (markQuotaStale) markQuotaStale = undefined;
					if (requestFooterRender === requestRender)
						requestFooterRender = undefined;
					unsubscribe();
				},
				invalidate() {},
				render(width: number): string[] {
					refreshQuota();

					const context = ctx.getContextUsage();
					const thinkingLevel = latestThinkingLevel(
						ctx.sessionManager.getBranch(),
					);
					const branch = footerData.getGitBranch();
					const statuses = Array.from(
						footerData.getExtensionStatuses().entries(),
					)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([key, text]) =>
							compactStatus(key, formatStatus(text)),
						)
						.filter(Boolean);

					const contextPart = context
						? `${context.percent === null ? "?" : `${context.percent.toFixed(0)}%`}/${formatCount(context.contextWindow)}`
						: "ctx ?";
					const model = ctx.model
						? footerData.getAvailableProviderCount() > 1
							? `${ctx.model.provider}/${ctx.model.id}`
							: ctx.model.id
						: "no-model";
					const modelWithReasoning = `${model} • ${thinkingLevel}`;
					const currentQuotaProvider = ctx.model
						? quotaProvider(ctx.model.provider)
						: undefined;
					const cacheStats = sessionCacheStats(ctx);
					const costOptions = sessionCostVariants(ctx);
					const quotaOptions = quotaVariants(
						quota,
						currentQuotaProvider ?? "quota",
						quotaLoading,
					);

					const importantRight = [modelSegment(modelWithReasoning)];
					const performanceOptions = performanceVariants(
						cacheStats,
						turnTokensPerSecond,
						context ? contextPart : undefined,
						context?.percent,
					);
					const diagnostics =
						statuses.length > 0
							? {
									text: statuses.join(" · "),
									fg: gruvbox.fg3,
									bg: gruvbox.bg1,
									priority: FOOTER_PRIORITY.diagnostics,
								}
							: undefined;
					let quotaIndex = 0;
					let performanceIndex = 0;
					const hasSubscriptionQuota =
						currentQuotaProvider !== undefined &&
						quota?.status === "ok";
					let showCost =
						costOptions.length > 0 && !hasSubscriptionQuota;
					let showQuota =
						quotaOptions.length > 0 &&
						(costOptions.length === 0 ||
							currentQuotaProvider !== undefined);
					let showPerformance = performanceOptions.length > 0;
					let showDiagnostics = diagnostics !== undefined;
					const buildLeft = (): PowerlineSegment[] =>
						[
							projectSegment(ctx.cwd),
							branchSegment(branch),
							showDiagnostics ? diagnostics : undefined,
						].filter(
							(part): part is PowerlineSegment =>
								part !== undefined,
						);
					const buildSecondary = (): PowerlineSegment[] => {
						const performance = showPerformance
							? (performanceOptions[performanceIndex] ?? [])
							: [];
						return [
							showCost ? costOptions[0] : undefined,
							showQuota ? quotaOptions[quotaIndex] : undefined,
							...performance,
						].filter(
							(part): part is PowerlineSegment =>
								part !== undefined,
						);
					};

					let left = buildLeft();
					let right = [...buildSecondary(), ...importantRight];
					let renderedLeft = renderPowerlineLeft(left);
					let renderedRight = renderPowerlineRight(right);

					while (
						visibleWidth(renderedLeft) +
							visibleWidth(renderedRight) +
							1 >
						width
					) {
						if (showDiagnostics) {
							showDiagnostics = false;
						} else if (
							showPerformance &&
							performanceIndex < performanceOptions.length - 1
						) {
							performanceIndex += 1;
						} else if (showPerformance) {
							showPerformance = false;
						} else if (
							showQuota &&
							quotaIndex < quotaOptions.length - 1
						) {
							quotaIndex += 1;
						} else if (showQuota) {
							showQuota = false;
						} else if (showCost) {
							showCost = false;
						} else {
							break;
						}
						left = buildLeft();
						right = [...buildSecondary(), ...importantRight];
						renderedLeft = renderPowerlineLeft(left);
						renderedRight = renderPowerlineRight(right);
					}

					return new PowerlineStatusLine({
						left,
						right,
						ellipsis: theme.fg("dim", "…"),
					}).render(width);
				},
			};
		});
	});
}
