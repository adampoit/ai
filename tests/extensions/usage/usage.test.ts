import assert from "node:assert/strict";
import test from "node:test";
import usageExtension, {
	copilotUsage,
	openAiUsage,
	quotaPace,
	quotaWindowStatus,
	resetDate,
	resetEta,
} from "../../../nix/pi-coding-agent/extensions/usage.ts";
import {
	assertPublicSurface,
	createContext,
	loadExtension,
	runCommand,
} from "../helpers.ts";

test("usage extension registers its public surface", () => {
	const pi = loadExtension(usageExtension);

	assertPublicSurface(pi, { commands: ["usage"] });
});

test("usage command renders subscription and local session usage", async () => {
	const pi = loadExtension(usageExtension);
	const rendered: string[] = [];
	const ctx = await createContext();
	ctx.sessionManager.getEntries = () => [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 1000,
					output: 2000,
					cacheRead: 300,
					cacheWrite: 400,
					cost: { total: 0.0456 },
				},
			},
		},
	];
	ctx.ui.custom = async (factory: any, options?: unknown) => {
		assert.deepEqual(options, { overlay: false });
		const view = factory(
			{ requestRender() {} },
			ctx.ui.theme,
			{ matches: () => false },
			() => {},
		);
		rendered.push(...view.render(120));
		return undefined as never;
	};

	await runCommand(pi, "usage", "", ctx);

	const output = rendered.join("\n");
	assert.ok(output.includes("Subscription quotas"), output);
	assert.ok(output.includes("OpenAI"), output);
	assert.ok(output.includes("GitHub Copilot"), output);
	assert.ok(output.includes("Local Pi session usage"), output);
	assert.ok(output.includes("3.7k tokens"), output);
	assert.ok(output.includes("$0.05"), output);
});

test("quota windows expose exact reset dates alongside reset ETAs", () => {
	const resetAt = "2030-01-02T03:04:05.000Z";
	const options: Intl.DateTimeFormatOptions = {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	};
	assert.equal(
		resetDate({ label: "primary", resetAt }),
		new Intl.DateTimeFormat(undefined, options).format(new Date(resetAt)),
	);
	assert.equal(resetDate({ label: "primary" }), undefined);
	assert.equal(
		resetDate({ label: "primary", resetAt: "not-a-date" }),
		undefined,
	);
});

test("usage renders the reset date after the quota percentage", async () => {
	const originalFetch = globalThis.fetch;
	const resetAt = "2030-01-02T03:04:05.000Z";
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 25,
						reset_at: resetAt,
					},
				},
			}),
			{ status: 200 },
		);
	try {
		const pi = loadExtension(usageExtension);
		const rendered: string[] = [];
		const ctx = await createContext();
		ctx.modelRegistry.authStorage.list = () => ["openai"];
		ctx.modelRegistry.authStorage.get = (key) =>
			key === "openai"
				? { type: "oauth", access: "test-token" }
				: undefined;
		ctx.ui.custom = async (factory: any, options?: unknown) => {
			assert.deepEqual(options, { overlay: false });
			const view = factory(
				{ requestRender() {} },
				ctx.ui.theme,
				{ matches: () => false },
				() => {},
			);
			rendered.push(...view.render(160));
			return undefined as never;
		};

		await runCommand(pi, "usage", "", ctx);

		const output = rendered.join("\n");
		const formattedResetDate = resetDate({ label: "primary", resetAt });
		assert.ok(formattedResetDate);
		assert.ok(
			output.includes(`75% remaining · resets ${formattedResetDate}`),
			output,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("quota windows use reset ETAs without inferring OpenAI window durations", () => {
	assert.equal(
		resetEta({
			label: "primary",
			resetAt: new Date(Date.now() + 23 * 60_000).toISOString(),
		}),
		"23m",
	);
	const openAiWindow = {
		label: "primary",
		percentRemaining: 20,
		resetAt: new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString(),
	};
	assert.equal(quotaPace("OpenAI", openAiWindow), undefined);
	assert.equal(quotaWindowStatus("OpenAI", openAiWindow), "warn");
	const dynamicWeeklyWindow = {
		...openAiWindow,
		percentRemaining: 40,
		durationMs: 7 * 24 * 60 * 60_000,
		resetAt: new Date(Date.now() + 3.5 * 24 * 60 * 60_000).toISOString(),
	};
	assert.ok(quotaPace("OpenAI", dynamicWeeklyWindow) !== undefined);
	assert.equal(quotaWindowStatus("OpenAI", dynamicWeeklyWindow), "warn");
	assert.equal(
		quotaWindowStatus("OpenAI", {
			...openAiWindow,
			percentRemaining: 10,
		}),
		"error",
	);
	assert.equal(
		quotaWindowStatus("GitHub Copilot", {
			...openAiWindow,
			percentRemaining: 0,
			unlimited: true,
		}),
		"ok",
	);
});

test("OpenAI reads the window duration reported by the usage API", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 25,
						limit_window_seconds: 7 * 24 * 60 * 60,
						reset_after_seconds: 5 * 24 * 60 * 60,
					},
				},
			}),
			{ status: 200 },
		);
	try {
		const ctx = await createContext();
		ctx.modelRegistry.authStorage.list = () => ["openai"];
		ctx.modelRegistry.authStorage.get = () => ({
			type: "oauth",
			access: "test-token",
		});

		const result = await openAiUsage(ctx as never);

		assert.equal(result.status, "ok");
		assert.equal(result.windows?.[0]?.durationMs, 7 * 24 * 60 * 60_000);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OpenAI supports the model registry without legacy auth storage", async () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const ctx = await createContext();
	delete (ctx.modelRegistry as { authStorage?: unknown }).authStorage;
	ctx.modelRegistry.getAll = () => [{ provider: "openai" }];
	process.env.PI_CODING_AGENT_DIR = ctx.cwd;
	try {
		const result = await openAiUsage(ctx as never);

		assert.equal(result.status, "unavailable");
	} finally {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
	}
});

test("Copilot token-based AI credits are treated as unlimited", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				quota_snapshots: {
					premium_models: {
						token_based_billing: true,
						entitlement: 100,
						used: 25,
						remaining: 75,
					},
				},
			}),
			{ status: 200 },
		);
	try {
		const ctx = await createContext();
		ctx.modelRegistry.authStorage.list = () => ["github"];
		ctx.modelRegistry.authStorage.get = () => ({
			type: "api_key",
			key: "test-token",
		});

		const result = await copilotUsage(ctx as never);

		assert.equal(result.status, "ok");
		assert.equal(result.windows?.[0]?.label, "ai credits");
		assert.equal(result.windows?.[0]?.unlimited, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("usage command exposes expected completions", () => {
	const pi = loadExtension(usageExtension);
	const command = pi.commands.get("usage");

	assert.deepEqual(command?.getArgumentCompletions?.("auth"), [
		{ value: "auth opencode-go", label: "auth opencode-go" },
	]);
});
