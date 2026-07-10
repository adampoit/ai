import { existsSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "visual_fixture_tool",
		label: "Third Party Fixture",
		description: "Deterministic ordinary renderer for global framing tests",
		parameters: Type.Object({
			value: Type.String(),
			mode: Type.Union([
				Type.Literal("success"),
				Type.Literal("wait"),
				Type.Literal("error"),
			]),
		}),
		async execute(_id, args, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: "partial fixture result" }],
				details: { phase: "partial" },
			});
			if (args.mode === "error")
				throw new Error("fixture execution failed");
			if (args.mode === "wait") {
				const ready = process.env.VISUAL_FIXTURE_READY;
				const release = process.env.VISUAL_FIXTURE_RELEASE;
				if (!ready || !release)
					throw new Error("fixture marker paths are missing");
				writeFileSync(ready, "ready");
				while (!existsSync(release)) {
					if (signal?.aborted) throw signal.reason;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `final fixture result: ${args.value}`,
					},
				],
				details: { phase: "final" },
			};
		},
		renderCall(args, theme, context) {
			return new Text(
				theme.fg(
					context.executionStarted ? "warning" : "muted",
					context.executionStarted
						? "plugin progress"
						: `plugin queued: ${args.value}`,
				),
				0,
				0,
			);
		},
		renderResult(result, options, theme) {
			const text = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			return new Text(
				theme.fg(options.isPartial ? "warning" : "success", text),
				0,
				0,
			);
		},
	});
}
