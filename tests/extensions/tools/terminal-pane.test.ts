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

function renderedLines(pane: TerminalPane, width = WIDTH): string[] {
	return pane.render(width).map((line) => line.trimEnd());
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

test("TerminalPane resets xterm when output is replaced", async () => {
	let pane!: TerminalPane;

	await waitForRender((invalidate) => {
		pane = new TerminalPane({
			output: "original",
			requestRender: invalidate,
		});
		pane.render(WIDTH);
	});
	await waitForRender((invalidate) => {
		pane.setOptions({ output: "replacement", requestRender: invalidate });
	});

	assert.deepEqual(renderedLines(pane), ["replacement"]);
});

test("TerminalPane handles empty output and trims trailing empty lines", async () => {
	let renderRequests = 0;
	const pane = new TerminalPane({
		output: undefined,
		requestRender: () => renderRequests++,
	});

	assert.deepEqual(renderedLines(pane), []);
	pane.setOptions({ output: "", requestRender: () => renderRequests++ });
	assert.deepEqual(renderedLines(pane), []);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(renderRequests, 0);

	await waitForRender((invalidate) => {
		pane.setOptions({ output: "content\n\n", requestRender: invalidate });
	});
	assert.deepEqual(renderedLines(pane), ["content"]);
});

test("TerminalPane resizes xterm before parsing additional output", async () => {
	let pane!: TerminalPane;
	let output = "abc\n";

	await waitForRender((invalidate) => {
		pane = new TerminalPane({ output, requestRender: invalidate });
		pane.render(6);
	});
	pane.render(3);

	output += "defg";
	await waitForRender((invalidate) => {
		pane.setOptions({ output, requestRender: invalidate });
	});

	assert.deepEqual(renderedLines(pane, 3), ["abc", "def", "g"]);
});

test("TerminalPane ignores write callbacks from a reset terminal", async () => {
	let renderRequests = 0;
	let pane!: TerminalPane;

	await waitForRender((invalidate) => {
		const requestRender = () => {
			renderRequests++;
			invalidate();
		};
		pane = new TerminalPane({ output: "stale", requestRender });
		pane.render(WIDTH);
		pane.setOptions({ output: "current", requestRender });
	});
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(renderRequests, 1);
	assert.deepEqual(renderedLines(pane), ["current"]);
});

test("TerminalPane preserves xterm attributes and color modes as SGR", async () => {
	const output = [
		"\x1b[1;2;3;4;5;7;8;9;53;31;44mA",
		"\x1b[22;23;24;25;27;28;29;55;91;104mB",
		"\x1b[38;5;200;48;5;100mC",
		"\x1b[38;2;1;2;3;48;2;4;5;6mD",
		"\x1b[0m",
	].join("");
	let pane!: TerminalPane;

	await waitForRender((invalidate) => {
		pane = new TerminalPane({ output, requestRender: invalidate });
		pane.render(WIDTH);
	});

	assert.deepEqual(renderedLines(pane), [
		[
			"\x1b[1;2;3;4;5;7;8;9;53;31;44mA\x1b[0m",
			"\x1b[91;104mB\x1b[0m",
			"\x1b[38;5;200;48;5;100mC\x1b[0m",
			"\x1b[38;2;1;2;3;48;2;4;5;6mD\x1b[0m",
		].join(""),
	]);
});
