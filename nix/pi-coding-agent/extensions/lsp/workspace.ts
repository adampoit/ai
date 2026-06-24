import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { languageByExtension } from "./languages.ts";

export function languagesForFiles(files: string[]) {
	return new Set(languageReasonsForFiles(files).keys());
}

export function languageForFile(file: string): string | undefined {
	return languageByExtension.get(path.extname(file).toLowerCase());
}

export function languageReasonsForFiles(files: string[]): Map<string, string> {
	const reasons = new Map<string, string>();
	for (const file of files) {
		const language = languageForFile(file);
		if (language && !reasons.has(language)) reasons.set(language, file);
	}
	return reasons;
}

export function formatLanguageDetectionReason(
	languages: string[],
	reasons: Map<string, string>,
): string | undefined {
	const detected = languages
		.map((language) => {
			const file = reasons.get(language);
			return file ? { language, file } : undefined;
		})
		.filter((entry): entry is { language: string; file: string } =>
			Boolean(entry),
		);
	if (detected.length === 0) return undefined;
	if (detected.length === 1) return `detected because of ${detected[0].file}`;
	return `detected because of ${detected
		.map((entry) => `${entry.language}: ${entry.file}`)
		.join(", ")}`;
}

export async function discoverFiles(
	cwd: string,
	scope: "changed" | "all",
	signal?: AbortSignal,
): Promise<string[]> {
	const jjFiles = await discoverJjFiles(cwd, scope, signal);
	if (jjFiles) return jjFiles;

	const command =
		scope === "all"
			? "git ls-files"
			: "git diff --name-only --diff-filter=ACMR HEAD && git ls-files --others --exclude-standard";
	const result = await runShell(cwd, command, signal);
	if (result.exitCode !== 0) return [];
	return uniqueLines(result.stdout);
}

async function discoverJjFiles(
	cwd: string,
	scope: "changed" | "all",
	signal?: AbortSignal,
): Promise<string[] | undefined> {
	const root = await runShell(cwd, "jj root --ignore-working-copy", signal);
	if (root.exitCode !== 0) return undefined;

	const command =
		scope === "all"
			? "jj file list --ignore-working-copy"
			: "jj diff --name-only --ignore-working-copy -r @";
	const result = await runShell(cwd, command, signal);
	return result.exitCode === 0 ? uniqueLines(result.stdout) : undefined;
}

function uniqueLines(value: string): string[] {
	return [
		...new Set(
			value
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
}

export async function fileExists(file: string) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

export async function commandPath(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await runShell(
		cwd,
		`command -v ${shellQuote(command)}`,
		signal,
	);
	const path = result.stdout.trim();
	return result.exitCode === 0 && path ? path : undefined;
}

export async function commandExists(
	command: string,
	cwd: string,
	signal?: AbortSignal,
) {
	return Boolean(await commandPath(command, cwd, signal));
}

export async function commandVersion(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const quoted = shellQuote(command);
	const result = await runShell(
		cwd,
		`${quoted} --version 2>&1 | head -n 1 || ${quoted} version 2>&1 | head -n 1`,
		signal,
	);
	const version = result.stdout.trim();
	return result.exitCode === 0 && version ? version : "unknown";
}

async function runShell(cwd: string, command: string, signal?: AbortSignal) {
	return await new Promise<{ stdout: string; exitCode: number }>(
		(resolve) => {
			const proc = spawn("/bin/sh", ["-lc", command], { cwd, signal });
			let stdout = "";
			proc.stdout.on("data", (data) => (stdout += data));
			proc.on("error", () => resolve({ stdout, exitCode: 1 }));
			proc.on("close", (code) =>
				resolve({ stdout, exitCode: code ?? 1 }),
			);
		},
	);
}

export async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	callback: (item: T, index: number) => Promise<void>,
) {
	let nextIndex = 0;
	const workerCount = Math.min(Math.max(1, concurrency), items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				await callback(items[index], index);
			}
		}),
	);
}

export async function delay(ms: number, signal?: AbortSignal) {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		});
	});
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
