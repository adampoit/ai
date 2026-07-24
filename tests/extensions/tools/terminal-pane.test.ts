import assert from "node:assert/strict";
import test from "node:test";
import { TerminalPane } from "../../../nix/pi-coding-agent/components/index.ts";

const WIDTH = 80;

async function waitForRender(request: (invalidate: () => void) => void) {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("xterm.js did not finish parsing output")),
			2000,
		);
		request(() => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

function renderedLines(pane: TerminalPane): string[] {
	return pane.render(WIDTH).map((line) => line.trimEnd());
}

test("TerminalPane renders continuous progress updates in place", async () => {
	const frames = [
		"Downloading assets\n\x1b[?25l\r\x1b[2K⠋ 10%",
		"\r\x1b[2K⠙ 60%",
		"\r\x1b[2K✓ complete\x1b[?25h",
	];
	let output = frames[0]!;
	let pane!: TerminalPane;

	await waitForRender((invalidate) => {
		pane = new TerminalPane({ output, requestRender: invalidate });
		pane.render(WIDTH);
	});
	assert.deepEqual(renderedLines(pane), ["Downloading assets", "⠋ 10%"]);

	for (const [frame, expected] of [
		[frames[1]!, "⠙ 60%"],
		[frames[2]!, "✓ complete"],
	] as const) {
		output += frame;
		await waitForRender((invalidate) => {
			pane.setOptions({ output, requestRender: invalidate });
		});
		assert.deepEqual(renderedLines(pane), ["Downloading assets", expected]);
	}
});

test("TerminalPane applies multi-line dashboard rewrites", async () => {
	const output = [
		"Files 1/3\nBytes 10%\n",
		"\x1b[2F\x1b[2KFiles 3/3\n",
		"\x1b[2KBytes 100%",
	].join("");
	let pane!: TerminalPane;

	await waitForRender((invalidate) => {
		pane = new TerminalPane({ output, requestRender: invalidate });
		pane.render(WIDTH);
	});

	assert.deepEqual(renderedLines(pane), ["Files 3/3", "Bytes 100%"]);
});
