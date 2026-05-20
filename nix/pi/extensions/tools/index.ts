import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerEditTool from "./edit.ts";
import registerBashTool from "./bash.ts";
import registerReadTool from "./read.ts";
import registerWriteTool from "./write.ts";
import registerGrepTool from "./grep.ts";
import registerFindTool from "./find.ts";
import registerLsTool from "./ls.ts";

export default function (pi: ExtensionAPI) {
	registerEditTool(pi);
	registerBashTool(pi);
	registerReadTool(pi);
	registerWriteTool(pi);
	registerGrepTool(pi);
	registerFindTool(pi);
	registerLsTool(pi);
}
