import assert from "node:assert/strict";
import test from "node:test";
import usageExtension, {
	openAiUsage,
	quotaPace,
	quotaWindowStatus,
	resetDate,
	resetEta,
} from "../../../nix/pi-coding-agent/extensions/usage.ts";
import { registerUsageProvider } from "../../../nix/pi-coding-agent/usage-contract.ts";
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
	assert.ok(output.includes("OpenCode Go"), output);
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
			let view: any;
			const tui = {
				requestRender() {
					rendered.push(...view.render(160));
				},
			};
			view = factory(
				tui,
				ctx.ui.theme,
				{ matches: () => false },
				() => {},
			);
			rendered.push(...view.render(160));
			await new Promise<void>((resolve) => setImmediate(resolve));
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

test("registered providers render metrics, bounded tables, and timestamps", async () => {
	const pi = loadExtension(usageExtension);
	let refresh = false;
	const fetchedAt = "2030-01-02T03:04:05.000Z";
	registerUsageProvider(pi as never, {
		id: "test-provider",
		label: "Test provider",
		load: async (context) => {
			refresh = context.refresh;
			return {
				status: "ok",
				fetchedAt,
				metrics: [{ label: "Spend", value: 12.5, format: "currency" }],
				tables: [
					{
						id: "users",
						columns: [
							{ key: "name", label: "User" },
							{
								key: "spend",
								label: "Spend",
								format: "currency",
							},
						],
						rows: [{ name: "Ada", spend: 12.5 }],
					},
				],
			};
		},
	});

	const rendered: string[] = [];
	const ctx = await createContext();
	ctx.ui.custom = async (factory: any) => {
		let view: any;
		const tui = {
			requestRender() {
				rendered.push(...view.render(120));
			},
		};
		view = factory(tui, ctx.ui.theme, { matches: () => false }, () => {});
		rendered.push(...view.render(120));
		await new Promise<void>((resolve) => setImmediate(resolve));
		rendered.push(...view.render(120));
		return undefined as never;
	};
	await runCommand(pi, "usage", "--refresh", ctx);

	const output = rendered.join("\n");
	assert.equal(refresh, true);
	assert.ok(output.includes("Test provider"), output);
	assert.ok(output.includes("Spend: $12.50"), output);
	assert.ok(output.includes("Ada"), output);
	const formattedFetchedAt = new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(fetchedAt));
	assert.ok(output.includes(`updated ${formattedFetchedAt}`), output);
});

test("usage opens immediately and updates providers as they finish", async () => {
	const pi = loadExtension(usageExtension);
	let resolveSlow!: (snapshot: {
		status: "ok";
		metrics: Array<{ label: string; value: number; format: "currency" }>;
	}) => void;
	const slowSnapshot = new Promise<{
		status: "ok";
		metrics: Array<{
			label: string;
			value: number;
			format: "currency";
		}>;
	}>((resolve) => {
		resolveSlow = resolve;
	});
	registerUsageProvider(pi as never, {
		id: "slow-provider",
		label: "Slow provider",
		load: async () => slowSnapshot,
	});
	registerUsageProvider(pi as never, {
		id: "fast-provider",
		label: "Fast provider",
		load: async () => ({
			status: "ok" as const,
			metrics: [
				{ label: "Fast metric", value: 7, format: "count" as const },
			],
		}),
	});

	const ctx = await createContext();
	const renders: string[][] = [];
	let view: any;
	let resolveCustom!: () => void;
	let resolveOpened!: () => void;
	const opened = new Promise<void>((resolve) => {
		resolveOpened = resolve;
	});
	ctx.ui.custom = async (factory: any) => {
		const customClosed = new Promise<void>((resolve) => {
			resolveCustom = resolve;
		});
		view = factory(
			{
				requestRender() {
					renders.push(view.render(120));
				},
			},
			ctx.ui.theme,
			{ matches: () => false },
			() => {},
		);
		renders.push(view.render(120));
		resolveOpened();
		await customClosed;
		return undefined as never;
	};

	const command = runCommand(pi, "usage", "", ctx);
	await opened;
	const initial = renders[0]?.join("\n") ?? "";
	assert.ok(initial.includes("Slow provider"), initial);
	assert.ok(initial.includes("Loading…"), initial);

	resolveSlow({
		status: "ok",
		metrics: [{ label: "Slow metric", value: 42, format: "currency" }],
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	const updated = renders.at(-1)?.join("\n") ?? "";
	assert.ok(updated.includes("Fast metric: 7"), updated);
	assert.ok(updated.includes("Slow metric: $42.00"), updated);

	resolveCustom();
	await command;
});

test("usage command exposes expected completions", () => {
	const pi = loadExtension(usageExtension);
	const command = pi.commands.get("usage");

	assert.deepEqual(command?.getArgumentCompletions?.("auth"), [
		{ value: "auth opencode-go", label: "auth opencode-go" },
	]);
	assert.deepEqual(command?.getArgumentCompletions?.("--"), [
		{ value: "--refresh", label: "--refresh" },
	]);
});
