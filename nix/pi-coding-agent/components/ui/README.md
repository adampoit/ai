# Pi UI components

Small, local TUI primitives for Pi extensions.

## Modules

- `ansi.ts`: ANSI-safe truecolor helpers, width-aware padding, background reapplication.
- `gruvbox.ts`: shared Gruvbox palette.
- `theme.ts`: adapter helpers for raw Gruvbox hex colors or Pi runtime `theme.fg()` / `theme.bg()` tokens.
- `layout.ts`: simple layout components (`Stack`, `StaticLines`).
- `powerline.ts`: lualine/powerline-inspired status-line segments.
- `blocks.ts`: higher-level primitives (`Pill`, `Badge`, `BlockFrame`, `BlockTitle`, `ToolShell`, `CodePane`, `TerminalPane`, `KeyHintLine`, `Meter`).

Extensions import these with relative `.js` specifiers, for example:

```ts
import { gruvbox, ToolShell, TerminalPane } from "../components/ui/index.ts";
```

## ToolShell pattern

Use `renderShell: "self"` when a renderer owns its full frame. Keep one persistent shell in `context.state`, update it from `renderResult()`, and return an empty component for the result slot to avoid double frames. `ToolShell` uses the neutral Gruvbox `bg1` block background by default; communicate state through the border, status badge, and severity badges instead of tinting the whole block.

```ts
const shell = state.shell ?? new ToolShell({ title: "bash" });
shell.setOptions({
	title: "bash",
	icon: "",
	accent: gruvbox.orange,
	state: "pending",
	status: "running",
	badges: [{ text: "npm test", bg: gruvbox.bg2 }],
	children: new TerminalPane({ output }),
});
```

## Conventions

- Keep collapsed tool views compact; show richer panes when `expanded` is true.
- Use stable accents: bash/orange, read/blue, grep/purple, edit/orange, success/green, error/red.
- Keep block interiors inset from rounded borders. `BlockFrame` reserves an unpainted gutter when a background is present so colored content does not bleed into the line border.
- Always truncate, wrap, or fill lines with width-aware helpers (`truncateToWidth`, `visibleWidth`, `fillAnsiLine`).
- Prefer `ToolShell`/`BlockFrame` over ad-hoc ANSI borders in extensions.
