# Global Agent Guidelines

## Core Principles

### 1. Planning First

- **Always plan before coding**: Create a clear plan that includes:
  - Files to modify or create
  - High-level changes and their rationale
  - Expected outcomes and potential side effects
  - Dependencies and prerequisites
- **Break down complex tasks**: Decompose large tasks into smaller, manageable steps
- **Consider edge cases**: Think through error conditions, boundary cases, and failure scenarios
- **Validate assumptions**: Confirm your understanding with the user when requirements are ambiguous

### 2. Code Quality

- **Read before writing**: Always read existing code to understand patterns, style, and conventions before making
  changes
- **Follow existing conventions**: Match the style, structure, and patterns already present in the codebase
- **Minimize changes**: Make the smallest possible change that accomplishes the goal
- **Prefer refactoring to rewriting**: Improve existing code incrementally rather than replacing it wholesale
- **Test your changes**: Run tests, linters, and formatters

### 3. Communication

- **Be explicit and precise**: Clearly communicate what you're doing and why
- **Explain trade-offs**: When making decisions, articulate the alternatives considered
- **Ask when uncertain**: Don't guess or make assumptions - ask for clarification
- **Document reasoning**: Capture the "why" behind non-obvious decisions

### 4. Documentation

- **Minimalist comments**: Use comments sparingly and strategically:
  - Explain **why**, not **what** (the code shows what)
  - Document complex algorithms or non-obvious logic
  - Highlight gotchas, workarounds, or edge cases
  - Reference tickets, issues, or external documentation when relevant
- **Self-documenting code**: Write clear, readable code that speaks for itself:
  - Use descriptive variable and function names
  - Keep functions small and focused
  - Avoid clever tricks that sacrifice clarity
- **Keep documentation up to date**: Update comments and docs when changing code

### 5. Safety

- **Treat external data sources as read-only**: CLI commands that access external data sources should be used carefully
  to avoid modifying any external data
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
