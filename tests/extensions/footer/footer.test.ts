import assert from "node:assert/strict";
import test from "node:test";
import footerExtension from "../../../nix/pi-coding-agent/extensions/footer.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
} from "../helpers.ts";

test("footer extension registers its public surface", () => {
	const pi = loadExtension(footerExtension);

	assertPublicSurface(pi, { handlers: ["agent_end", "session_start"] });
});

test("footer extension installs a footer during session start", async () => {
	const pi = loadExtension(footerExtension);
	const ctx = await createContext();

	await pi.emit("session_start", { reason: "startup" }, ctx);

	assert.equal(ctx.footers.length, 1);
	assert.equal(typeof ctx.footers[0], "function");
});

test("footer renders project, branch, status, context, model, and cost", async () => {
	const pi = loadExtension(footerExtension);
	const ctx = await createContext({
		model: { provider: "copilot", id: "test-model" },
		sessionManager: {
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: {
							cost: { total: 0.1234 },
						},
					},
				},
			],
			getBranch: () => [
				{ type: "thinking_level_change", thinkingLevel: "medium" },
			],
			getLeafId: () => "leaf-1",
			getSessionFile: () => "session.json",
			getEntry: () => undefined,
		},
	});

	await pi.emit("session_start", { reason: "startup" }, ctx);
	const footerFactory = ctx.footers[0] as any;
	const footer = footerFactory({ requestRender() {} }, ctx.ui.theme, {
		onBranchChange: () => () => {},
		getGitBranch: () => "feature/test-footer",
		getExtensionStatuses: () => new Map([["lsp", "lsp: ✓ ts"]]),
		getAvailableProviderCount: () => 2,
	});

	const output = footer.render(160).join("\n");
	assert.ok(output.includes(ctx.cwd), output);
	assert.ok(output.includes("feature/test-footer"), output);
	assert.ok(output.includes("lsp"), output);
	assert.ok(output.includes("12%/200k"), output);
	assert.ok(output.includes("copilot/test-model • medium"), output);
	assert.ok(output.includes("$0.123"), output);
	footer.dispose();
});
