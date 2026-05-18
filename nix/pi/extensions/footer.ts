import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	copilotUsage,
	openAiUsage,
	openCodeGoUsage,
	type ProviderUsage,
	type UsageWindow,
} from "./usage.js";

const LEFT_SEPARATOR = "";
const RIGHT_SEPARATOR = "";
const RIGHT_NARROW_SEPARATOR = "";
const RESET = "\x1b[0m";

const gruvbox = {
	bg: "#282828",
	bg1: "#3c3836",
	bg2: "#504945",
	fg0: "#fbf1c7",
	gray: "#a89984",
	green: "#98971a",
	yellow: "#d79921",
	red: "#cc241d",
	blue: "#458588",
};

type Block = {
	text: string;
	fg: string;
	bg: string;
};

function hexToRgb(hex: string): [number, number, number] {
	const value = hex.replace(/^#/, "");
	return [
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
	];
}

function fg(hex: string, text: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}`;
}

function bg(hex: string, text: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[48;2;${r};${g};${b}m${text}`;
}

function style(text: string, foreground: string, background?: string): string {
	return `${background ? bg(background, "") : ""}${fg(foreground, text)}${RESET}`;
}

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

function block(item: Block): string {
	return style(` ${item.text} `, item.fg, item.bg);
}

function renderLeftBlocks(blocks: Block[]): string {
	const items = blocks.filter((item) => item.text.length > 0);
	return items
		.map((item, index) => {
			const next = items[index + 1];
			const separator = next
				? style(LEFT_SEPARATOR, item.bg, next.bg)
				: style(LEFT_SEPARATOR, item.bg);
			return block(item) + separator;
		})
		.join("");
}

function renderRightBlocks(blocks: Block[]): string {
	const items = blocks.filter((item) => item.text.length > 0);
	return items
		.map((item, index) => {
			const previous = items[index - 1];
			const separator = previous
				? style(RIGHT_SEPARATOR, item.bg, previous.bg)
				: style(RIGHT_SEPARATOR, item.bg);
			return separator + block(item);
		})
		.join("");
}

function renderPlainRight(parts: Array<string | Block>): string {
	return parts
		.filter((part) =>
			typeof part === "string" ? part.length > 0 : part.text.length > 0,
		)
		.map((part) =>
			typeof part === "string"
				? style(part, gruvbox.gray)
				: style(part.text, part.fg, part.bg),
		)
		.join(style(` ${RIGHT_NARROW_SEPARATOR} `, gruvbox.gray));
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
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

function quotaProvider(
	provider: string,
): "openai" | "copilot" | "opencode-go" | undefined {
	const normalized = provider.toLowerCase();
	if (normalized.includes("openai") || normalized.includes("codex"))
		return "openai";
	if (normalized.includes("copilot") || normalized.includes("github"))
		return "copilot";
	if (normalized.includes("opencode")) return "opencode-go";
}

async function fetchQuota(
	provider: ReturnType<typeof quotaProvider>,
	ctx: ExtensionContext,
): Promise<ProviderUsage | undefined> {
	if (provider === "openai") return openAiUsage(ctx);
	if (provider === "copilot") return copilotUsage(ctx);
	if (provider === "opencode-go") return openCodeGoUsage(ctx);
}

function quotaLabel(label: string): string {
	const normalized = label.toLowerCase();
	if (normalized === "primary" || normalized.includes("5h")) return "5h";
	if (normalized === "secondary" || normalized.includes("week")) return "wk";
	if (normalized.includes("month")) return "mo";
	if (normalized.includes("premium")) return "req";
	return label;
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

function quotaDurationMs(
	provider: string,
	window: UsageWindow,
): number | undefined {
	const label = quotaLabel(window.label);
	if (label === "5h") return 5 * 60 * 60 * 1000;
	if (label === "wk") return 7 * 24 * 60 * 60 * 1000;
	if (label === "mo" || provider === "GitHub Copilot")
		return 30 * 24 * 60 * 60 * 1000;
}

function resetEta(window: UsageWindow): string | undefined {
	if (!window.resetAt) return undefined;
	const ms = new Date(window.resetAt).getTime() - Date.now();
	if (!Number.isFinite(ms)) return undefined;
	const minutes = Math.max(0, Math.round(ms / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function quotaPace(provider: string, window: UsageWindow): number | undefined {
	if (window.remaining !== undefined && window.remaining < 0) return Infinity;
	if (window.percentRemaining === undefined || !window.resetAt)
		return undefined;
	const duration = quotaDurationMs(provider, window);
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

function paceColor(pace: number | undefined): string {
	if (pace === Infinity || (pace !== undefined && pace > 1.25))
		return gruvbox.red;
	if (pace !== undefined && pace > 1) return gruvbox.yellow;
	return gruvbox.green;
}

function burnRateWindows(windows: UsageWindow[]): UsageWindow[] {
	return windows.filter((window) => quotaLabel(window.label) !== "5h");
}

function limitingWindow(
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

function quotaCompact(
	window: UsageWindow,
	limiting: UsageWindow | undefined,
): string {
	const eta = window === limiting ? resetEta(window) : undefined;
	return `${quotaLabel(window.label)} ${quotaPercent(window)}${eta ? ` ↻ ${eta}` : ""}`;
}

function quotaVisual(
	window: UsageWindow,
	limiting: UsageWindow | undefined,
): string {
	if (window !== limiting) return quotaCompact(window, limiting);
	const eta = resetEta(window);
	return `${quotaLabel(window.label)} ${quotaBar(window.percentRemaining, 6)} ${quotaPercent(window)}${eta ? ` ↻ ${eta}` : ""}`;
}

function quotaVariants(
	result: ProviderUsage | undefined,
	loading: boolean,
): Block[] {
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
				window.percentRemaining !== undefined ||
				window.remaining !== undefined,
		)
		.slice(0, 3);
	if (windows.length === 0)
		return [{ text: "quota ?", fg: gruvbox.gray, bg: gruvbox.bg }];

	const limiting = limitingWindow(result.provider, windows);
	const pace = limiting ? quotaPace(result.provider, limiting) : undefined;
	const color = paceColor(pace);
	const compact = windows.map((window) => quotaCompact(window, limiting));
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
			text: quotaCompact(limiting ?? windows[0], limiting),
			fg: color,
			bg: gruvbox.bg,
		},
	];
}

function quotaBar(percentRemaining: number | undefined, width: number): string {
	if (percentRemaining === undefined) return "·".repeat(width);
	const used = Math.max(0, Math.min(100, 100 - percentRemaining));
	const filled = Math.round((used / 100) * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function contextColor(percent: number | null | undefined): string {
	if (percent == null) return gruvbox.gray;
	if (percent >= 90) return gruvbox.red;
	if (percent >= 70) return gruvbox.yellow;
	return gruvbox.green;
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

export default function (pi: ExtensionAPI) {
	let markQuotaStale: (() => void) | undefined;

	pi.on("agent_end", () => {
		markQuotaStale?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() =>
				tui.requestRender(),
			);
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
				void fetchQuota(provider, ctx)
					.then((result) => {
						if (quotaKey === provider) quota = result;
					})
					.finally(() => {
						quotaLoading = false;
						tui.requestRender();
					});
			};

			return {
				dispose: () => {
					if (markQuotaStale) markQuotaStale = undefined;
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

					const left = renderLeftBlocks([
						{
							text: `π ${projectPath(ctx.cwd)}`,
							fg: gruvbox.fg0,
							bg: gruvbox.blue,
						},
						branch
							? {
									text: ` ${branch}`,
									fg: gruvbox.green,
									bg: gruvbox.bg2,
								}
							: {
									text: "",
									fg: gruvbox.gray,
									bg: gruvbox.bg2,
								},
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
					const quotaOptions = quotaVariants(quota, quotaLoading);

					const importantRight = renderRightBlocks([
						{
							text: modelWithReasoning,
							fg: gruvbox.fg0,
							bg: gruvbox.bg2,
						},
						{
							text: contextPart,
							fg: contextColor(context?.percent),
							bg: gruvbox.bg1,
						},
					]);
					const secondaryParts = [...statuses];
					let quotaIndex = 0;
					let showQuota = quotaOptions.length > 0;
					const buildSecondary = () =>
						renderPlainRight([
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

					const gap =
						width - visibleWidth(left) - visibleWidth(right);
					if (gap >= 1) return [left + " ".repeat(gap) + right];

					const availableLeft = Math.max(
						0,
						width - visibleWidth(importantRight) - 1,
					);
					if (availableLeft >= 12) {
						return [
							truncateToWidth(
								left,
								availableLeft,
								theme.fg("dim", "…"),
							) +
								" " +
								importantRight,
						];
					}

					return [
						truncateToWidth(
							importantRight,
							width,
							theme.fg("dim", "…"),
						),
					];
				},
			};
		});
	});
}
