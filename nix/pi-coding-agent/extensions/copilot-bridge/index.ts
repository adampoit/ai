import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHookBridge } from "./hooks.ts";
import { registerInstructionBridge } from "./instructions.ts";
import { registerPromptBridge } from "./prompts.ts";

export default function copilotBridgeExtension(pi: ExtensionAPI) {
	registerInstructionBridge(pi);
	registerPromptBridge(pi);
	registerHookBridge(pi);
}
