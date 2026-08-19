import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	gruvbox,
	PowerlineStatusLine,
	renderPlainStatusParts,
	renderPowerlineLeft,
	renderPowerlineRight,
	stripAnsi,
	type PowerlineSegment,
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
			fg: gruvbox.aqua,
			bg: gruvbox.bg,
		},
	];
}

function quotaVariants(
	result: ProviderUsage | undefined,
	provider: string,
	loading: boolean,
): PowerlineSegment[] {
	if (loading) return [{ text: "quota …", fg: gruvbox.gray, bg: gruvbox.bg }];
	if (!result)
		return [{ text: "quota n/a", fg: gruvbox.gray, bg: gruvbox.bg }];
	if (result.status !== "ok")
		return [
			{
				text: `quota ${result.status}`,
				fg: gruvbox.gray,
				bg: gruvbox.bg,
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
		return [{ text: "quota ?", fg: gruvbox.gray, bg: gruvbox.bg }];

	const limiting = limitingWindow(provider, windows);
	const status = limiting ? quotaWindowStatus(provider, limiting) : "ok";
	const color =
		status === "error"
			? gruvbox.red
			: status === "warn"
				? gruvbox.yellow
				: gruvbox.green;
	const compact = windows.map(quotaCompact);
	return [
		{
			text: windows
				.map((window) => quotaVisual(window, limiting))
				.join(" · "),
			fg: color,
			bg: gruvbox.bg,
		},
		{
			text: compact.slice(0, 2).join(" · "),
			fg: color,
			bg: gruvbox.bg,
		},
		{
			text: quotaCompact(limiting ?? windows[0]),
			fg: color,
			bg: gruvbox.bg,
		},
	];
}

function contextColor(percent: number | null | undefined): string {
	if (percent == null) return gruvbox.gray;
	if (percent >= 90) return gruvbox.red;
	if (percent >= 70) return gruvbox.yellow;
	return gruvbox.green;
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
	};
}

function branchSegment(branch: string | null): PowerlineSegment {
	return branch
		? {
				text: ` ${branch}`,
				fg: gruvbox.green,
				bg: gruvbox.bg2,
			}
		: {
				text: "",
				fg: gruvbox.gray,
				bg: gruvbox.bg2,
			};
}

function modelSegment(text: string): PowerlineSegment {
	return { text, fg: gruvbox.fg0, bg: gruvbox.bg2 };
}

function contextSegment(
	text: string,
	percent: number | null | undefined,
): PowerlineSegment {
	return { text, fg: contextColor(percent), bg: gruvbox.bg1 };
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

					const left = renderPowerlineLeft([
						projectSegment(ctx.cwd),
						branchSegment(branch),
					]);

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
					const costOptions = sessionCostVariants(ctx);
					const quotaOptions =
						costOptions.length > 0
							? costOptions
							: quotaVariants(
									quota,
									currentQuotaProvider ?? "quota",
									quotaLoading,
								);

					const importantRight = renderPowerlineRight([
						modelSegment(modelWithReasoning),
						contextSegment(contextPart, context?.percent),
					]);
					const secondaryParts = [
						...(turnTokensPerSecond === undefined
							? []
							: [
									{
										text: formatTokensPerSecond(
											turnTokensPerSecond,
										),
										fg: gruvbox.aqua,
										bg: gruvbox.bg,
									},
								]),
						...statuses,
					];
					let quotaIndex = 0;
					let showQuota = quotaOptions.length > 0;
					const buildSecondary = () =>
						renderPlainStatusParts([
							showQuota ? quotaOptions[quotaIndex] : "",
							...secondaryParts,
						]);

					let secondary = buildSecondary();
					let right = secondary
						? `${secondary} ${importantRight}`
						: importantRight;

					while (
						visibleWidth(left) + visibleWidth(right) + 1 >
						width
					) {
						if (secondaryParts.length > 0) {
							secondaryParts.pop();
						} else if (
							showQuota &&
							quotaIndex < quotaOptions.length - 1
						) {
							quotaIndex += 1;
						} else if (showQuota) {
							showQuota = false;
						} else {
							break;
						}
						secondary = buildSecondary();
						right = secondary
							? `${secondary} ${importantRight}`
							: importantRight;
					}

					return new PowerlineStatusLine({
						left,
						right: importantRight,
						rightPrefix: secondary,
						ellipsis: theme.fg("dim", "…"),
					}).render(width);
				},
			};
		});
	});
}
