import assert from "node:assert/strict";
import test from "node:test";
import footerExtension from "../../../nix/pi-coding-agent/extensions/footer.ts";
import {
	gruvbox,
	sgrBg,
	sgrFg,
	stripAnsi,
} from "../../../nix/pi-coding-agent/components/ui/index.ts";
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

test("footer renders project, branch, status, context, model, cost, cache, and turn throughput", async (t) => {
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
							input: 1_000,
							cacheRead: 5_000,
							cacheWrite: 100,
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

	ctx.getContextUsage = () => ({
		percent: 80,
		contextWindow: 200_000,
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
	const plainOutput = stripAnsi(output);
	assert.ok(plainOutput.includes("lsp ✓1"), plainOutput);
	assert.ok(
		plainOutput.includes(
			"hit 82.0% · 16.7 t/s · 80%/200k  copilot/test-model",
		),
		plainOutput,
	);
	assert.ok(output.includes(sgrBg(gruvbox.orange)), output);
	assert.ok(
		output.includes(`${sgrFg(gruvbox.brightYellow)}80%/200k`),
		output,
	);
	assert.ok(!output.includes(`${sgrFg(gruvbox.brightYellow)} · `), output);
	assert.ok(output.includes(ctx.cwd), output);
	assert.ok(output.includes("feature/test-footer"), output);
	assert.ok(output.includes("lsp"), output);
	assert.ok(output.includes("80%/200k"), output);
	assert.ok(output.includes("copilot/test-model • medium"), output);
	assert.ok(output.includes("$0.123"), output);
	assert.ok(!output.includes("R5.0k"), output);
	assert.ok(!output.includes("W100"), output);
	assert.ok(!output.includes("CH82.0%"), output);
	assert.ok(output.includes("hit 82.0%"), output);
	assert.ok(output.includes("16.7 t/s"), output);

	await pi.emit("before_agent_start", {}, ctx);
	assert.ok(!footer.render(200).join("\n").includes("t/s"));
	footer.dispose();
});

test("footer prefers subscription quota bars over session cost", async () => {
	const originalFetch = globalThis.fetch;
	const cases = [
		{
			provider: "openai-codex",
			response: {
				rate_limit: {
					primary_window: {
						used_percent: 25,
						limit_window_seconds: 7 * 24 * 60 * 60,
						reset_after_seconds: 6 * 24 * 60 * 60,
					},
				},
			},
			configure: (ctx: any) => {
				ctx.modelRegistry.authStorage.list = () => ["openai"];
				ctx.modelRegistry.authStorage.get = () => ({
					type: "oauth",
					access: "test-token",
				});
			},
		},
		{
			provider: "opencode-go",
			response: {
				weeklyUsage: { usagePercent: 25, resetInSec: 7 * 24 * 60 * 60 },
			},
			configure: (ctx: any) => {
				ctx.modelRegistry.getApiKeyForProvider = async () => "test-key";
			},
		},
	];

	try {
		for (const scenario of cases) {
			globalThis.fetch = async () =>
				new Response(JSON.stringify(scenario.response), {
					status: 200,
				});
			const pi = loadExtension(footerExtension);
			const ctx = await createContext({
				model: { provider: scenario.provider, id: "test-model" },
			});
			ctx.sessionManager.getEntries = () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { cost: { total: 0.1234 } },
					},
				},
			];
			scenario.configure(ctx);

			await pi.emit("session_start", { reason: "startup" }, ctx);
			const footerFactory = ctx.footers[0] as any;
			const footer = footerFactory({ requestRender() {} }, ctx.ui.theme, {
				onBranchChange: () => () => {},
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				getAvailableProviderCount: () => 1,
			});

			footer.render(320);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const output = footer.render(320).join("\n");
			assert.ok(!output.includes("$0.123"), output);
			assert.match(output, /[█░]{6}/, output);
			assert.ok(output.includes("75%"), output);
			footer.dispose();
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});
