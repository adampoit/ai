# AI Skills and Prompts

This repository contains reusable agent assets:

- `agents/` - agent profiles and behavior instructions
- `prompts/` - task-specific prompt templates
- `skills/` - tool-integrated skills with usage docs and scripts

## Requirements

- `opencode` CLI available on `PATH`
- .NET SDK (for C# script skills)

Some skills integrate with third-party tools or APIs and may require local credentials (for example, `SLACK_API_TOKEN` for Slack queries).

## Home Manager Module

This repository exports a Home Manager module at `homeManagerModules.opencode`.

Example flake input:

```nix
inputs.ai.url = "github:adampoit/ai";
```

Example usage:

```nix
home-manager.sharedModules = [
	inputs.ai.homeManagerModules.opencode
];
```

## License

MIT.
