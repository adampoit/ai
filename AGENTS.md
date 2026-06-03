# Repository Guide

This repository contains reusable OpenCode and Pi Coding Agent assets:

- `global-instructions.md` for shared rules
- `agents/` for agent profiles
- `prompts/` for command prompts
- `skills/` for skill docs and helper scripts
- `nix/opencode.nix` for the Home Manager OpenCode configuration module
- `nix/pi-coding-agent.nix` for Pi Coding Agent Home Manager customizations

## Working Principles

- Keep changes small and focused.
- Match existing style and conventions in nearby files.
- Prefer self-documenting code over explanatory comments.
- Do not add secrets, tokens, private URLs, or personal data.

## Validation

For Nix module edits, validate flake/module syntax:

- `nix flake show --no-write-lock-file`
- `nix-instantiate --parse ./nix/opencode.nix`
- `nix-instantiate --parse ./nix/pi-coding-agent.nix`

For Pi TypeScript extension edits, run:

- `npm run typecheck`
