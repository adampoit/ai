import { spawnSync } from "node:child_process";

const PATCHED = Symbol("jj-vcs-status-patched");

function getJjLabelSync(cwd: string): string | undefined {
	const root = spawnSync("jj", ["root", "--ignore-working-copy"], {
		cwd,
		encoding: "utf8",
		timeout: 2000,
	});
	if (root.status !== 0) return undefined;

	const result = spawnSync(
		"jj",
		[
			"--ignore-working-copy",
			"--at-op=@",
			"--no-pager",
			"--color=never",
			"log",
			"--no-graph",
			"--limit",
			"1",
			"-r",
			"coalesce(heads(::@ & (bookmarks() | remote_bookmarks() | tags())), heads(@:: & (bookmarks() | remote_bookmarks() | tags())), trunk())",
			"-T",
			"separate(' ', bookmarks, tags)",
		],
		{ cwd, encoding: "utf8", timeout: 3000 },
	);
	if (result.status !== 0) return undefined;

	let line = (result.stdout ?? "").trim().split(/\s+/)[0] ?? "";
	if (line.endsWith("*")) line = line.slice(0, -1);
	return line || "@";
}

export default async function () {
	// Locate pi's internal FooterDataProvider module.
	// process.argv[1] points to pi's CLI entry (dist/cli.js).
	const piCli = process.argv[1];
	if (!piCli) {
		console.error("jj-vcs-status: unable to locate pi CLI path");
		return;
	}
	const footerPath = piCli.replace(
		/[/\\]cli\.js$/,
		"/core/footer-data-provider.js",
	);

	let FooterDataProvider: any;
	try {
		({ FooterDataProvider } = await import(footerPath));
	} catch (e) {
		console.error("jj-vcs-status: failed to import FooterDataProvider:", e);
		return;
	}

	if (FooterDataProvider.prototype[PATCHED]) return;

	const origGetGitBranch = FooterDataProvider.prototype.getGitBranch;
	const origResolveGitBranchAsync =
		FooterDataProvider.prototype.resolveGitBranchAsync;

	FooterDataProvider.prototype.getGitBranch = function () {
		const label = getJjLabelSync(this.cwd);
		if (label !== undefined) return label;
		return origGetGitBranch.call(this);
	};

	FooterDataProvider.prototype.resolveGitBranchAsync = async function () {
		const label = getJjLabelSync(this.cwd);
		if (label !== undefined) return label;
		return origResolveGitBranchAsync.call(this);
	};

	FooterDataProvider.prototype[PATCHED] = true;
}
