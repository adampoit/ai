import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

interface EventRecord {
	type: string;
	at: number;
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	pi.registerCommand("renderstats", {
		description: "Toggle rendering stats footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (!enabled) {
				ctx.ui.setWidget("render-stats", undefined);
				ctx.ui.notify("Render stats disabled", "info");
				return;
			}

			const startTime = Date.now();
			let totalRenders = 0;
			let lastRenderTime = 0;
			let lastRenderDuration = 0;
			let lastEventLag = 0;
			let initialFullRedraws = -1;
			const timestamps: number[] = [];
			const events: EventRecord[] = [];
			const WINDOW_MS = 2000;
			const MAX_EVENTS = 50;

			function recordEvent(type: string) {
				events.push({ type, at: Date.now() });
				if (events.length > MAX_EVENTS) events.shift();
			}

			let acceptEvents = true;
			pi.on("input", () => {
				if (acceptEvents) recordEvent("input");
			});
			pi.on("message_update", () => {
				if (acceptEvents) recordEvent("msg_upd");
			});
			pi.on("message_start", () => {
				if (acceptEvents) recordEvent("msg_start");
			});
			pi.on("message_end", () => {
				if (acceptEvents) recordEvent("msg_end");
			});
			pi.on("tool_execution_start", () => {
				if (acceptEvents) recordEvent("tool_start");
			});
			pi.on("tool_execution_update", () => {
				if (acceptEvents) recordEvent("tool_upd");
			});
			pi.on("tool_execution_end", () => {
				if (acceptEvents) recordEvent("tool_end");
			});

			ctx.ui.setWidget(
				"render-stats",
				(tui, theme) => {
					// Force periodic refresh so we can see idle/delays even between keystrokes
					const interval = setInterval(() => {
						tui.requestRender();
					}, 100);

					if (initialFullRedraws < 0) {
						initialFullRedraws = tui.fullRedraws;
					}

					return {
						dispose() {
							clearInterval(interval);
							acceptEvents = false;
							events.length = 0;
						},
						invalidate() {},
						render(width: number): string[] {
							const renderStart = performance.now();
							const now = Date.now();
							totalRenders++;

							// Sliding window for render-rate calculation
							timestamps.push(now);
							const cutoff = now - WINDOW_MS;
							while (
								timestamps.length > 0 &&
								timestamps[0] < cutoff
							) {
								timestamps.shift();
							}

							const rps = timestamps.length / (WINDOW_MS / 1000);
							const frameMs =
								lastRenderTime > 0 ? now - lastRenderTime : 0;

							// Event lag: time from most recent event to this render
							const lastEvent = events[events.length - 1];
							lastEventLag = lastEvent ? now - lastEvent.at : 0;

							// Full redraws since monitoring started
							const fullRedraws =
								tui.fullRedraws - initialFullRedraws;

							const elapsed = now - startTime;
							const uptime =
								elapsed < 60000
									? `${(elapsed / 1000).toFixed(0)}s`
									: `${(elapsed / 60000).toFixed(1)}m`;

							const parts = [
								`#${totalRenders}`,
								`~${rps.toFixed(1)} r/s`,
								frameMs > 0
									? `${Math.round(frameMs)}ms frame`
									: null,
								lastRenderDuration > 0
									? `${Math.round(lastRenderDuration)}µs render`
									: null,
								lastEventLag > 0 && lastEvent
									? `${lastEvent.type}→render ${Math.round(lastEventLag)}ms`
									: null,
								fullRedraws > 0 ? `${fullRedraws} full` : null,
								`${width} cols`,
								`up ${uptime}`,
							].filter((p): p is string => Boolean(p));

							lastRenderTime = now;
							lastRenderDuration =
								performance.now() - renderStart;

							const text = theme.fg("dim", parts.join(" · "));
							return [truncateToWidth(text, width)];
						},
					};
				},
				{ placement: "belowEditor" },
			);

			ctx.ui.notify("Render stats enabled", "info");
		},
	});
}
