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

const unitOnly = process.argv.includes("--unit");
const testArguments = process.argv.slice(2).filter((argument) => argument !== "--unit");
const testFiles = findTests("tests")
	.filter(
		(file) =>
			!unitOnly ||
			(!file.endsWith("tests/extensions/lsp/lsp.test.ts") &&
				!file.endsWith("tests/extensions/lsp/real-projects.test.ts")),
	)
	.sort();
const result = spawnSync(
	process.execPath,
	["--import", "tsx", "--test", ...testArguments, ...testFiles],
	{ stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
