# Pi UI components

Small, local TUI primitives for Pi extensions.

## Modules

- `ansi.ts`: ANSI-safe truecolor helpers, width-aware padding, background reapplication.
- `gruvbox.ts`: shared Gruvbox palette.
- `theme.ts`: adapters for raw Gruvbox colors and Pi theme tokens.
- `layout.ts`: simple layout components (`Stack`, `StaticLines`).
- `powerline.ts`: lualine/powerline-inspired status-line segments.
- `blocks.ts`: framed blocks, panes, badges, invocation lines, and `ToolShell`.
- `tool-presentation.ts`: the declarative `ToolPresentation` marker used by tool renderers.
- `TerminalPane` in `blocks.ts`: an xterm.js-backed viewport for shell output and in-place progress updates.

## Tool rendering responsibilities

Tool presentation has two layers:

1. `extensions/global-tool-framing.ts` owns the outer `ToolShell` for every tool using Pi's default shell. It derives generic titles, lifecycle state, and invocation arguments for ordinary package tools while preserving their renderer components and images.
2. Specialized tools return a `ToolPresentation`. Its symbol-marked model supplies richer status, telemetry, invocation data, and body panes to the same global shell.

Specialized renderers must set `renderShell: "default"`; they must not instantiate `ToolShell` directly. Keep the presentation in `context.state` so `renderResult()` can update the same component after Pi renders the call slot.

```ts
const presentation =
	state.presentation ?? new ToolPresentation({ title: "bash" });
state.presentation = presentation;
presentation.setOptions({
	title: "bash",
	icon: "",
	accent: gruvbox.orange,
	state: "pending",
	status: "running",
	telemetry: [{ text: "12 lines", bg: gruvbox.bg1 }],
	children: new TerminalPane({ output }),
});
return presentation;
```

`ToolPresentation.render()` emits only its rich body as a safe fallback. The adapter recognizes it through `Symbol.for(...)`, not `instanceof`, so reloads and duplicate module instances remain safe.

The prototype adapter is intentionally limited to `ToolExecutionComponent` and validated against Pi 0.80.5, which is pinned in `package.json`. Incompatible internals produce a focused startup error rather than mixed framing.

## Conventions

- Keep collapsed tool views compact; show richer panes when `expanded` is true.
- Use stable accents: bash/orange, read/blue, grep/purple, edit/orange, success/green, error/red.
- Keep block interiors inset from rounded borders.
- Always truncate, wrap, or fill lines with width-aware helpers.
- Keep images outside textual frames; Pi retains ownership of image conversion and sizing.
