import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
} from "@earendil-works/pi-ai";

const scenarios: Record<
	string,
	{ name: string; arguments: Record<string, unknown> }
> = {
	"fixture:grep-success": {
		name: "grep",
		arguments: { pattern: "needle", path: "." },
	},
	"fixture:generic-success": {
		name: "visual_fixture_tool",
		arguments: { value: "deterministic", mode: "success" },
	},
	"fixture:generic-running": {
		name: "visual_fixture_tool",
		arguments: { value: "waiting", mode: "wait" },
	},
	"fixture:generic-error": {
		name: "visual_fixture_tool",
		arguments: { value: "deterministic", mode: "error" },
	},
	"fixture:bash-running": {
		name: "bash",
		arguments: {
			command:
				'printf "bash started\\n"; touch "$VISUAL_FIXTURE_READY"; while [ ! -e "$VISUAL_FIXTURE_RELEASE" ]; do sleep 0.05; done; printf "bash completed\\n"',
			timeout: 10,
		},
	},
	"fixture:edit-success": {
		name: "edit",
		arguments: {
			path: "editable.txt",
			edits: [{ oldText: "before", newText: "after" }],
		},
	},
	"fixture:web-search-error": {
		name: "web_search",
		arguments: {
			query: "deterministic smoke test",
			provider: "brave",
			workflow: "none",
		},
	},
};

function scriptedStream(model: any, context: any) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: 0,
		};
		stream.push({ type: "start", partial: output });
		const hasToolResult = context.messages.some(
			(message: { role?: string }) => message.role === "toolResult",
		);
		if (hasToolResult) {
			const text = "fixture complete";
			output.content.push({ type: "text", text });
			stream.push({
				type: "text_start",
				contentIndex: 0,
				partial: output,
			});
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: text,
				partial: output,
			});
			stream.push({
				type: "text_end",
				contentIndex: 0,
				content: text,
				partial: output,
			});
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
			return;
		}

		const prompt = findPrompt(context.messages);
		const scenario = scenarios[prompt];
		if (!scenario) {
			const error = new Error(
				`Unknown visual fixture scenario: ${prompt}`,
			);
			output.stopReason = "error";
			output.errorMessage = error.message;
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
			return;
		}
		const toolCall = {
			type: "toolCall" as const,
			id: "visual-call-1",
			name: scenario.name,
			arguments: scenario.arguments,
		};
		output.content.push(toolCall);
		output.stopReason = "toolUse";
		stream.push({
			type: "toolcall_start",
			contentIndex: 0,
			partial: output,
		});
		stream.push({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: JSON.stringify(scenario.arguments),
			partial: output,
		});
		stream.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall,
			partial: output,
		});
		stream.push({ type: "done", reason: "toolUse", message: output });
		stream.end();
	});
	return stream;
}

function findPrompt(messages: any[]): string {
	for (const message of [...messages].reverse()) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const text = message.content?.find(
			(item: any) => item.type === "text",
		)?.text;
		if (text) return text;
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("visual-fixture", {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "fixture-no-network",
		api: "openai-completions",
		models: [
			{
				id: "scripted",
				name: "Scripted Visual Fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 256,
			},
		],
		streamSimple: scriptedStream,
	});
}
