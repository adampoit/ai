# AI Agent Assets

Reusable assets for AI agents: shared instructions, agent profiles, prompts, and tool-integrated skills.
This repo also ships Home Manager customizations for OpenCode and Pi Coding Agent on Nix-based setups.

## What's Included

- `global-instructions.md`: shared cross-agent rules and guidance
- `agents/`: agent profiles and behavior guidance
- `prompts/`: reusable command prompt templates
- `skills/`: local skills with docs and helper scripts
- `nix/opencode.nix`: OpenCode Home Manager module export
- `nix/pi-coding-agent.nix`: Pi Coding Agent Home Manager customizations

## OpenCode Home Manager Module

If you use OpenCode with Home Manager, this repository exports `homeManagerModules.opencode`.

### Quick Start (Nix Flakes)

Add this repo as a flake input:

```nix
inputs.ai.url = "github:adampoit/ai";
```

Enable the module in Home Manager:

```nix
home-manager.sharedModules = [
  inputs.ai.homeManagerModules.opencode
];
```

## Pi Coding Agent Home Manager Customizations

If you use Pi Coding Agent with Home Manager, this repository exports
`homeManagerModules.pi-coding-agent`. It configures Home Manager's upstream
`programs.pi-coding-agent` module, installs a pinned Pi package, shared prompts,
skills, extensions, a gruvbox theme, and formatter/LSP helper packages.

Enable the module in Home Manager:

```nix
home-manager.sharedModules = [
  inputs.ai.homeManagerModules.pi-coding-agent
];
```

The Pi package defaults to pinned version `0.75.4`, which avoids the current nixpkgs Darwin build failure in `0.78.0`. Customize models with the upstream module setting:

```nix
programs.pi-coding-agent.settings.enabledModels = [
  "github-copilot/claude-opus-4.6"
  "openai-codex/gpt-5.5"
];
```

## Requirements

- `opencode` on `PATH` (only needed when using the OpenCode module/CLI)
- Any model-provider credentials needed by Pi/OpenCode
- .NET SDK (required by C#-based skills)
- Any tool-specific credentials needed by individual skills (for example, `SLACK_API_TOKEN` for Slack)

## Validation

For module-related edits, validate syntax with:

```bash
nix flake show
nix-instantiate --parse ./nix/opencode.nix
nix-instantiate --parse ./nix/pi-coding-agent.nix
```

For Pi TypeScript extension edits, run typechecking and tests from the dev shell so the expected language servers are available:

```bash
nix develop -c npm run typecheck
nix develop -c npm test
```

## License

MIT
