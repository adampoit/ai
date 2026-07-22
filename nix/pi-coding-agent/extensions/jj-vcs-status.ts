import { spawnSync } from "node:child_process";

const PATCHED = Symbol("jj-vcs-status-patched");

const LABEL_TTL_MS = 10_000;
const labelCache = new Map<
	string,
	{ label: string | undefined; time: number }
>();
const isJjRoot = new Map<string, boolean>();

function getJjLabelSync(cwd: string): string | undefined {
	const cached = labelCache.get(cwd);
	if (cached && Date.now() - cached.time < LABEL_TTL_MS) return cached.label;

	if (!isJjRoot.has(cwd)) {
		const root = spawnSync("jj", ["root", "--ignore-working-copy"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
		});
		isJjRoot.set(cwd, root.status === 0);
	}
	if (!isJjRoot.get(cwd)) return undefined;

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
	let label: string | undefined;
	if (result.status === 0) {
		let line = (result.stdout ?? "").trim().split(/\s+/)[0] ?? "";
		if (line.endsWith("*")) line = line.slice(0, -1);
		label = line || "@";
	}
	labelCache.set(cwd, { label, time: Date.now() });
	return label;
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
