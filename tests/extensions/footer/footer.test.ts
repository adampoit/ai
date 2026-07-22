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

	assertPublicSurface(pi, {
		handlers: [
			"agent_end",
			"before_agent_start",
			"before_provider_request",
			"message_end",
			"session_start",
		],
	});
});

test("footer extension installs a footer during session start", async () => {
	const pi = loadExtension(footerExtension);
	const ctx = await createContext();

	await pi.emit("session_start", { reason: "startup" }, ctx);

	assert.equal(ctx.footers.length, 1);
	assert.equal(typeof ctx.footers[0], "function");
});

test("footer renders project, branch, status, context, model, cost, and turn throughput", async (t) => {
	let now = 1_000;
	t.mock.method(performance, "now", () => now);

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
	let renderRequests = 0;
	const footer = footerFactory(
		{
			requestRender() {
				renderRequests++;
			},
		},
		ctx.ui.theme,
		{
			onBranchChange: () => () => {},
			getGitBranch: () => "feature/test-footer",
			getExtensionStatuses: () => new Map([["lsp", "lsp: ✓ ts"]]),
			getAvailableProviderCount: () => 2,
		},
	);

	await pi.emit("before_agent_start", {}, ctx);
	const rendersAfterReset = renderRequests;
	await pi.emit("before_provider_request", { payload: {} }, ctx);
	now = 2_000;
	await pi.emit(
		"message_end",
		{
			message: {
				role: "assistant",
				usage: { output: 10 },
			},
		},
		ctx,
	);
	assert.ok(renderRequests > rendersAfterReset);
	assert.ok(footer.render(200).join("\n").includes("10.0 t/s"));

	now = 3_000;
	await pi.emit("before_provider_request", { payload: {} }, ctx);
	now = 5_000;
	await pi.emit(
		"message_end",
		{
			message: {
				role: "assistant",
				usage: { output: 40 },
			},
		},
		ctx,
	);

	const output = footer.render(200).join("\n");
	assert.ok(output.includes(ctx.cwd), output);
	assert.ok(output.includes("feature/test-footer"), output);
	assert.ok(output.includes("lsp"), output);
	assert.ok(output.includes("12%/200k"), output);
	assert.ok(output.includes("copilot/test-model • medium"), output);
	assert.ok(output.includes("$0.123"), output);
	assert.ok(output.includes("16.7 t/s"), output);

	await pi.emit("before_agent_start", {}, ctx);
	assert.ok(!footer.render(200).join("\n").includes("t/s"));
	footer.dispose();
});
