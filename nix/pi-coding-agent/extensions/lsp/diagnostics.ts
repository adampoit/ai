import { gruvbox } from "../../components/index.ts";
import type { Diagnostic } from "./types.ts";

export type DiagnosticSeverity =
	| "error"
	| "warning"
	| "info"
	| "hint"
	| "unknown";

export function diagnosticsFromDetails(details: unknown): Diagnostic[] {
	if (!details || typeof details !== "object") return [];
	const diagnostics = (details as { diagnostics?: unknown }).diagnostics;
	if (!Array.isArray(diagnostics)) return [];
	return diagnostics.filter(isDiagnostic);
}

export function isFailedLspDetails(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		(details as { ok?: unknown }).ok === false
	);
}

function isDiagnostic(value: unknown): value is Diagnostic {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Diagnostic).file === "string" &&
		typeof (value as Diagnostic).line === "number" &&
		typeof (value as Diagnostic).character === "number" &&
		typeof (value as Diagnostic).severity === "string" &&
		typeof (value as Diagnostic).message === "string"
	);
}

export function severityCounts(
	diagnostics: Diagnostic[],
): Record<DiagnosticSeverity, number> {
	const counts: Record<DiagnosticSeverity, number> = {
		error: 0,
		warning: 0,
		info: 0,
		hint: 0,
		unknown: 0,
	};
	for (const diagnostic of diagnostics) {
		const severity = normalizeDiagnosticSeverity(diagnostic.severity);
		counts[severity] += 1;
	}
	return counts;
}

function normalizeDiagnosticSeverity(severity: string): DiagnosticSeverity {
	if (
		severity === "error" ||
		severity === "warning" ||
		severity === "info" ||
		severity === "hint"
	) {
		return severity;
	}
	return "unknown";
}

export function severityColor(severity: DiagnosticSeverity): string {
	if (severity === "error") return gruvbox.red;
	if (severity === "warning") return gruvbox.yellow;
	if (severity === "info") return gruvbox.blue;
	if (severity === "hint") return gruvbox.aqua;
	return gruvbox.bg3;
}

export function severityThemeToken(
	severity: DiagnosticSeverity,
): "error" | "warning" | "accent" | "success" | "muted" {
	if (severity === "error") return "error";
	if (severity === "warning") return "warning";
	if (severity === "info") return "accent";
	if (severity === "hint") return "success";
	return "muted";
}

export function lspDiagnosticsToDiagnostics(
	file: string,
	diagnostics: unknown[],
) {
	return diagnostics
		.filter(
			(
				diagnostic,
			): diagnostic is {
				range: { start: { line: number; character: number } };
				severity?: number;
				source?: string;
				message: string;
			} => {
				return (
					typeof diagnostic === "object" &&
					diagnostic !== null &&
					typeof (diagnostic as any).range?.start?.line ===
						"number" &&
					typeof (diagnostic as any).range?.start?.character ===
						"number" &&
					typeof (diagnostic as any).message === "string"
				);
			},
		)
		.map((diagnostic) => ({
			file,
			line: diagnostic.range.start.line + 1,
			character: diagnostic.range.start.character + 1,
			severity: severityName(diagnostic.severity),
			source: diagnostic.source,
			message: diagnostic.message,
		}));
}

function severityName(severity?: number) {
	if (severity === 1) return "error";
	if (severity === 2) return "warning";
	if (severity === 3) return "info";
	if (severity === 4) return "hint";
	return "unknown";
}

export function formatDiagnostics(diagnostics: Diagnostic[], title: string) {
	if (diagnostics.length === 0) return `${title}: none.`;
	const shown = diagnostics.slice(0, 80).map((diagnostic) => {
		const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
		return `- ${diagnostic.file}:${diagnostic.line}:${diagnostic.character}: ${diagnostic.severity}${source}: ${diagnostic.message}`;
	});
	const suffix =
		diagnostics.length > shown.length
			? `\n... ${diagnostics.length - shown.length} more diagnostics omitted.`
			: "";
	return `${title} (${diagnostics.length}):\n${shown.join("\n")}${suffix}`;
}
