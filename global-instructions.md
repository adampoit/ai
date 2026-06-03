# Global Agent Guidelines

## Core Principles

### 1. Documentation

- **Minimalist comments**: Use comments sparingly and strategically:
    - Explain **why**, not **what** (the code shows what)
    - Document complex algorithms or non-obvious logic
    - Highlight gotchas, workarounds, or edge cases
    - Reference tickets, issues, or external documentation when relevant
- **Self-documenting code**: Write clear, readable code that speaks for itself:
    - Use descriptive variable and function names
    - Avoid clever tricks that sacrifice clarity
- **Keep documentation up to date**: Update comments and docs when changing code

### 2. Safety

- **Treat external data sources as read-only**: CLI commands that access external data sources should be used carefully to avoid modifying any external data
- **Avoid sudo**: You do not have elevated permissions to run commands with sudo

## Tooling

### Package Discovery & Verification

- **Search before installing**: Always query package registries or use package-manager search commands to find the latest versions, metadata, and compatibility rather than relying on training data.
- **Use ecosystem CLIs and registries**: Examples:
    - **npm**: `npm view <package> version` or `npm show <package> versions`.
    - **Nix**: `nh search <query>` for channel-aware Nix package discovery.
    - **dotnet**: `dotnet package search <query>`.
    - **Other ecosystems**: use `pip index versions <package>`, `cargo search <query>`, etc., or check official registry websites.
- **Prefer official sources**: When in doubt, reference the official package registry page rather than third-party mirrors or memory.

### Version Control

- **Prefer `jj` over `git`**: If `jj` (Jujutsu) is initialized in a repository, use it instead of `git` for all version control operations.

### Interactive Processes

- **Use tmux for long-running or interactive terminal processes**: Do not use background bash for development servers, watch commands, REPLs, debuggers, log tails, or commands that need later inspection/input. Use the `tmux-interactive-processes` skill.
