import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function execute(command, args, capture = false) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});
}

const version =
	process.argv[2] ||
	process.env.UPDATE_VERSION ||
	execute(
		"npm",
		["view", "@earendil-works/pi-coding-agent", "version"],
		true,
	).trim();
if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version)) {
	throw new Error(`Invalid Pi version: ${version}`);
}

const flake = readFileSync("flake.nix", "utf8");
const pin = /pi\.url = "github:earendil-works\/pi\/v[^"\n]+";/g;
if ([...flake.matchAll(pin)].length !== 1) {
	throw new Error("Expected exactly one tagged upstream Pi flake input");
}
const updated = flake.replace(
	pin,
	`pi.url = "github:earendil-works/pi/v${version}";`,
);
if (updated !== flake) {
	writeFileSync("flake.nix", updated);
	execute("nix", ["flake", "update", "pi"]);
}
const runtimeVersion = execute(
	"nix",
	["eval", "--raw", ".#pi-coding-agent.version"],
	true,
).trim();
if (runtimeVersion !== version) {
	throw new Error(`Pi flake provides ${runtimeVersion}, expected ${version}`);
}
execute("npm", [
	"install",
	"--save-dev",
	"--save-exact",
	...["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"].map(
		(name) => `@earendil-works/${name}@${version}`,
	),
]);
