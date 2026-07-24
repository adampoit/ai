import assert from "node:assert/strict";
import test from "node:test";
import { textOutput } from "../../../nix/pi-coding-agent/extensions/tools/shared.ts";

test("textOutput strips controls from terminal progress output", () => {
	const progressOutput = [
		"\x1b[32mDownloading assets\x1b[0m\n",
		"\x1b[?25l\x1b[1G\x1b[2K\x1b[1m⠋ 10%\x1b[0m",
		"\r\x1b[1G\x1b[2K\x1b[1m⠙ 60%\x1b[0m",
		"\r\x1b[1G\x1b[2K\x1b[1m✓ complete\x1b[0m\x1b[?25h",
	].join("");

	const output = textOutput({
		content: [{ type: "text", text: progressOutput }],
		details: undefined,
	});

	assert.equal(output, "Downloading assets\n⠋ 10%⠙ 60%✓ complete");
	assert.doesNotMatch(output, /\x1b/);
});
