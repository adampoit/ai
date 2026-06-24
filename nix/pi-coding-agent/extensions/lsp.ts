import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { gruvbox, ToolShell } from "../components/index.ts";
import {
	diagnosticsFromDetails,
	formatDiagnostics,
	severityCounts,
} from "./lsp/diagnostics.ts";
import {
	getManager,
	LspManager,
	resolveSymbolPosition,
} from "./lsp/manager.ts";
import {
	collapsedDiagnosticMessageLines,
	expandedDiagnosticMessageLines,
	LspResultPane,
	lspToolRenderer,
	severityBadges,
	splitTextLines,
} from "./lsp/rendering.ts";
import type {
	DiagnosticParams,
	JsonToolResult,
	SymbolPositionParams,
} from "./lsp/types.ts";

const diagnosticSchema = Type.Object({
	files: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"Files to check. Defaults to files changed in git.",
			}),
		),
	),
	scope: Type.Optional(
		StringEnum(["changed", "all"] as const, {
			description:
				"Use changed files or all tracked files when files is omitted.",
		}),
	),
});

const symbolPositionSchema = Type.Object({
	file: Type.String({ description: "File to query." }),
	symbol: Type.Optional(
		Type.String({ description: "Symbol name to resolve in the file." }),
	),
	line: Type.Optional(Type.Number({ description: "1-based line number." })),
	character: Type.Optional(
		Type.Number({ description: "1-based character/column number." }),
	),
});

const searchSchema = Type.Object({
	query: Type.String({ description: "Workspace symbol search query." }),
});

const emptySchema = Type.Object({});

export default function (pi: ExtensionAPI) {
	let injectedForTurn = false;
	let lastInjectedSignature = "";
	let manager: LspManager | undefined;
	let sessionGeneration = 0;

	pi.registerMessageRenderer(
		"lsp-diagnostics",
		(message, { expanded }, theme) => {
			const content =
				typeof message.content === "string"
					? message.content
					: String(message.content ?? "");
			const diagnostics = diagnosticsFromDetails(message.details);
			const counts = severityCounts(diagnostics);
			const hasErrors = counts.error > 0;
			const hasWarnings = counts.warning > 0;
			const lines = splitTextLines(content);
			const maxLines = expanded
				? expandedDiagnosticMessageLines
				: collapsedDiagnosticMessageLines;
			const hidden = Math.max(0, lines.length - maxLines);
			const telemetry = [...severityBadges(counts)];
			if (hidden > 0) {
				telemetry.push({ text: `${hidden} hidden`, bg: gruvbox.bg1 });
			}
			return new ToolShell({
				title: "LSP Diagnostics",
				icon: "󰒡",
				accent: hasErrors
					? gruvbox.red
					: hasWarnings
						? gruvbox.yellow
						: gruvbox.green,
				state: hasErrors
					? "error"
					: hasWarnings
						? "neutral"
						: "success",
				status: hasErrors
					? "errors"
					: hasWarnings
						? "warnings"
						: "clean",
				telemetry,
				expansion: { expanded },
				theme,
				children: new LspResultPane(content, theme, {
					maxLines,
					expansionLimit: collapsedDiagnosticMessageLines,
				}),
			});
		},
	);

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++sessionGeneration;
		let currentManager: LspManager;
		const isCurrentSession = () =>
			generation === sessionGeneration && manager === currentManager;
		const renderStatus = (status: string) => {
			if (!isCurrentSession()) return;
			ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", status));
		};
		currentManager = new LspManager(ctx.cwd, renderStatus, ctx.ui.notify);
		manager = currentManager;
		renderStatus("lsp: 󰔟 warming");
		currentManager.prewarm().catch((error) => {
			if (!isCurrentSession()) return;
			renderStatus("lsp:  error");
			ctx.ui.notify(
				`LSP prewarm failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		++sessionGeneration;
		const currentManager = manager;
		manager = undefined;
		await currentManager?.stop();
		ctx.ui.setStatus("lsp", "");
	});

	pi.on("agent_start", () => {
		injectedForTurn = false;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (injectedForTurn) return;

		const diagnostics = (
			await getManager(
				ctx.cwd,
				manager,
				ctx.ui.notify,
			).collectDiagnostics({ scope: "changed" }, ctx.signal)
		).filter((d) => d.severity === "error" || d.severity === "warning");
		if (diagnostics.length === 0) return;

		const signature = JSON.stringify(diagnostics);
		if (signature === lastInjectedSignature) return;

		injectedForTurn = true;
		lastInjectedSignature = signature;
		pi.sendMessage(
			{
				customType: "lsp-diagnostics",
				content: formatDiagnostics(
					diagnostics,
					"LSP diagnostics found after your last response",
				),
				display: true,
				details: { diagnostics },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description:
			"Run language-server diagnostics for specific files or changed files.",
		promptSnippet:
			"Run project LSP diagnostics directly against configured language servers",
		promptGuidelines: [
			"Use lsp_diagnostics after editing code or configuration files to catch language-server errors and warnings before reporting completion.",
		],
		parameters: diagnosticSchema,
		renderShell: "self",
		...lspToolRenderer("LSP Diagnostics", "󰒡", gruvbox.yellow),
		async execute(
			_toolCallId,
			params: DiagnosticParams,
			signal,
			onUpdate,
			ctx,
		) {
			onUpdate?.({
				content: [
					{ type: "text", text: "Collecting LSP diagnostics..." },
				],
				details: {},
			});
			const diagnostics = await getManager(
				ctx.cwd,
				manager,
				ctx.ui.notify,
			).collectDiagnostics(params, signal);
			return {
				content: [
					{
						type: "text",
						text: formatDiagnostics(diagnostics, "LSP diagnostics"),
					},
				],
				details: { diagnostics, count: diagnostics.length },
			};
		},
	});

	pi.registerTool({
		name: "lsp_inspect",
		label: "LSP Inspect",
		description:
			"Inspect a symbol using its definition, hover/type info, and reference locations.",
		promptSnippet:
			"Inspect a symbol semantically using definition, type/docs, and usages",
		promptGuidelines: [
			"Use lsp_inspect when you need to understand a symbol's type, docs, definition, or role before modifying code that uses it.",
		],
		parameters: symbolPositionSchema,
		renderShell: "self",
		...lspToolRenderer("LSP Inspect", "󰈙", gruvbox.blue),
		async execute(
			_toolCallId,
			params: SymbolPositionParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const activeManager = getManager(ctx.cwd, manager, ctx.ui.notify);
			const position = await resolveSymbolPosition(
				activeManager,
				params,
				signal,
			);
			if ("error" in position)
				return jsonToolResult({ ok: false, error: position.error });

			const definition = await activeManager.requestAtPosition(
				position,
				"textDocument/definition",
				undefined,
				signal,
			);
			const hover = await activeManager.requestAtPosition(
				position,
				"textDocument/hover",
				undefined,
				signal,
			);
			const usages = await activeManager.requestAtPosition(
				position,
				"textDocument/references",
				{ context: { includeDeclaration: true } },
				signal,
			);
			return jsonToolResult({
				ok: true,
				result: { position, definition, hover, usages },
			});
		},
	});

	pi.registerTool({
		name: "lsp_usages",
		label: "LSP Usages",
		description: "Find usages/references of a symbol.",
		promptSnippet: "Find usages of a symbol before changing or removing it",
		promptGuidelines: [
			"Use lsp_usages before renaming, deleting, changing signatures, or changing exported/public symbols.",
		],
		parameters: symbolPositionSchema,
		renderShell: "self",
		...lspToolRenderer("LSP Usages", "󰈇", gruvbox.purple),
		async execute(
			_toolCallId,
			params: SymbolPositionParams,
			signal,
			_onUpdate,
			ctx,
		) {
			const activeManager = getManager(ctx.cwd, manager, ctx.ui.notify);
			const position = await resolveSymbolPosition(
				activeManager,
				params,
				signal,
			);
			if ("error" in position)
				return jsonToolResult({ ok: false, error: position.error });
			const result = await activeManager.requestAtPosition(
				position,
				"textDocument/references",
				{ context: { includeDeclaration: true } },
				signal,
			);
			return "error" in result
				? jsonToolResult({ ok: false, error: result.error })
				: jsonToolResult({
						ok: true,
						result: { position, usages: result.result },
					});
		},
	});

	pi.registerTool({
		name: "lsp_search",
		label: "LSP Search",
		description: "Search symbols semantically across the workspace.",
		promptSnippet: "Search workspace symbols by name or concept",
		promptGuidelines: [
			"Use lsp_search when you know a symbol or concept name but not the file where it is defined.",
		],
		parameters: searchSchema,
		renderShell: "self",
		...lspToolRenderer("LSP Search", "", gruvbox.aqua),
		async execute(
			_toolCallId,
			params: { query: string },
			signal,
			_onUpdate,
			ctx,
		) {
			const result = await getManager(
				ctx.cwd,
				manager,
				ctx.ui.notify,
			).requestWorkspaceSymbols(params.query, signal);
			return jsonToolResult(result);
		},
	});

	pi.registerTool({
		name: "lsp_refresh",
		label: "LSP Refresh",
		description:
			"Restart language servers and clear cached diagnostics/documents after LSP configuration changes.",
		promptSnippet:
			"Restart language servers when project LSP settings change",
		promptGuidelines: [
			"Use lsp_refresh after editing language-server configuration files (for example .luarc.json) before re-running diagnostics.",
		],
		parameters: emptySchema,
		renderShell: "self",
		...lspToolRenderer("LSP Refresh", "󰑓", gruvbox.orange),
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [{ type: "text", text: "Refreshing LSP servers..." }],
				details: {},
			});
			await getManager(ctx.cwd, manager, ctx.ui.notify).refresh(signal);
			return {
				content: [{ type: "text", text: "LSP servers refreshed." }],
				details: { refreshed: true },
			};
		},
	});

	pi.registerCommand("lsp-diagnostics", {
		description: "Show LSP diagnostics for changed files",
		handler: async (_args, ctx) => {
			const diagnostics = await getManager(
				ctx.cwd,
				manager,
				ctx.ui.notify,
			).collectDiagnostics({ scope: "changed" }, ctx.signal);
			ctx.ui.notify(
				formatDiagnostics(diagnostics, "LSP diagnostics"),
				diagnostics.length ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("lsp-refresh", {
		description: "Restart language servers and clear cached diagnostics",
		handler: async (_args, ctx) => {
			await getManager(ctx.cwd, manager, ctx.ui.notify).refresh(
				ctx.signal,
			);
			ctx.ui.notify("LSP servers refreshed.", "info");
		},
	});

	pi.registerCommand("lsp", {
		description: "Show running language servers",
		handler: async (_args, ctx) => {
			await getManager(ctx.cwd, manager, ctx.ui.notify).show(ctx);
		},
	});
}

function jsonToolResult(result: JsonToolResult) {
	return {
		content: [
			{
				type: "text" as const,
				text:
					"error" in result
						? result.error
						: JSON.stringify(result.result, null, 2),
			},
		],
		details: result,
		isError: !result.ok,
	};
}
