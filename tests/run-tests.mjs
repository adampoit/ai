import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

function findTests(directory) {
	return readdirSync(directory)
		.flatMap((entry) => {
			const file = path.join(directory, entry);
			return statSync(file).isDirectory() ? findTests(file) : [file];
		})
		.filter((file) => file.endsWith(".test.ts"));
}

const testFiles = findTests("tests").sort();
const result = spawnSync(
	process.execPath,
	[
		"--import",
		"tsx",
		"--test",
		"--test-concurrency=1",
		...process.argv.slice(2),
		...testFiles,
	],
	{ stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
