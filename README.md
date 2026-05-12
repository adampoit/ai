# AI Agent Assets

Reusable assets for AI agents: shared instructions, agent profiles, prompts, and tool-integrated skills.
This repo also ships Home Manager modules for OpenCode and Pi on Nix-based setups.

## What's Included

- `global-instructions.md`: shared cross-agent rules and guidance
- `agents/`: agent profiles and behavior guidance
- `prompts/`: reusable command prompt templates
- `skills/`: local skills with docs and helper scripts
- `nix/opencode.nix`: OpenCode Home Manager module export
- `nix/pi.nix`: Pi Home Manager module export

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

## Pi Home Manager Module

If you use Pi with Home Manager, this repository exports `homeManagerModules.pi`.
It installs shared prompts, skills, extensions, a gruvbox theme, and formatter/LSP helper packages.

Enable the module in Home Manager:

```nix
home-manager.sharedModules = [
  inputs.ai.homeManagerModules.pi
];
```

Optionally customize the models written to `~/.pi/agent/settings.json`:

```nix
programs.pi.enabledModels = [
  "github-copilot/claude-opus-4.6"
  "openai-codex/gpt-5.5"
];
```

## Requirements

- `opencode` on `PATH` (only needed when using the OpenCode module/CLI)
- Pi on `PATH` (only needed when using the Pi module/CLI)
- .NET SDK (required by C#-based skills)
- Any tool-specific credentials needed by individual skills (for example, `SLACK_API_TOKEN` for Slack)
- Any model-provider credentials needed by Pi/OpenCode

## Validation

For module-related edits, validate syntax with:

```bash
nix flake show --no-write-lock-file
nix-instantiate --parse ./nix/opencode.nix
nix-instantiate --parse ./nix/pi.nix
```

For Pi TypeScript extension edits, run:

```bash
npm run typecheck
```

## License

MIT
