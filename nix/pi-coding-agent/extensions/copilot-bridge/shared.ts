import { stat } from "node:fs/promises";
import path from "node:path";

export type Frontmatter = {
	metadata: Record<string, string>;
	body: string;
};

export function parseFrontmatter(content: string): Frontmatter {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return { metadata: {}, body: content };
	}

	const newline = content.startsWith("---\r\n") ? "\r\n" : "\n";
	const endMarker = `${newline}---${newline}`;
	const end = content.indexOf(endMarker, 3);
	if (end === -1) return { metadata: {}, body: content };

	const rawMetadata = content.slice(3 + newline.length, end);
	const body = content.slice(end + endMarker.length);
	const metadata: Record<string, string> = {};

	for (const line of rawMetadata.split(/\r?\n/)) {
		const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		metadata[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, "");
	}

	return { metadata, body };
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

export function normalizeRelativePath(cwd: string, filePath: string): string {
	const absolute = path.isAbsolute(filePath)
		? filePath
		: path.resolve(cwd, filePath);
	return path.relative(cwd, absolute).replaceAll(path.sep, "/");
}
