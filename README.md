# AI Agent Assets

Reusable assets for AI agents: shared instructions, agent profiles, prompts, and tool-integrated skills.
This repo also ships an OpenCode Home Manager module for Nix-based setups.

## What's Included

- `global-instructions.md`: shared cross-agent rules and guidance
- `agents/`: agent profiles and behavior guidance
- `prompts/`: reusable command prompt templates
- `skills/`: local skills with docs and helper scripts
- `nix/opencode.nix`: Home Manager module export

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

## Requirements

- `opencode` on `PATH` (only needed when using the OpenCode module/CLI)
- .NET SDK (required by C#-based skills)
- Any tool-specific credentials needed by individual skills (for example, `SLACK_API_TOKEN` for Slack)

## Validation

For module-related edits, validate syntax with:

```bash
nix flake show --no-write-lock-file
nix-instantiate --parse ./nix/opencode.nix
```

## License

MIT
