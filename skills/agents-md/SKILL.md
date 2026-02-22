---
name: agents-md
description: Create and maintain AGENTS.md files that provide AI coding agents with project context, commands, code style, and boundaries. Use when updating an existing AGENTS.md, creating a new AGENTS.md for a repository, or improving agent instructions for a codebase.
---

# Agents Md

AGENTS.md is a README for AI agents: a dedicated place to provide context and instructions to help AI coding agents work effectively on a project.

## Workflow

1. **Check for existing file**: Look for AGENTS.md at repository root
2. **If exists**: Read and analyze for gaps or outdated information
3. **If missing**: Gather project information to create one
4. **Update/Create**: Write or improve the file following best practices
5. **Validate**: Ensure all six core areas are covered

## Core Areas to Cover

Every effective AGENTS.md addresses these six areas:

### 1. Commands

Put executable commands early. Include flags and options, not just tool names.

```markdown
## Commands

- Install: `pnpm install`
- Dev: `pnpm dev`
- Test: `pnpm test --coverage`
- Build: `pnpm build`
- Lint: `pnpm lint --fix`
```

### 2. Testing

Specify how to run tests and what's expected before commits.

```markdown
## Testing

- Run `pnpm test` before commits
- Add tests for new functionality
- Fix failing tests before merging
```

### 3. Project Structure

Describe what lives where. Help the agent navigate quickly.

```markdown
## Structure

- `src/` - Application source code
- `tests/` - Unit and integration tests
- `docs/` - Documentation
```

### 4. Code Style

Show examples over explanations. One code snippet beats three paragraphs.

```markdown
## Code Style

- TypeScript strict mode
- Single quotes, no semicolons
- Functional patterns preferred
```

### 5. Git Workflow

Describe commit conventions and PR expectations.

```markdown
## Git

- Commit format: `type(scope): description`
- Run lint and test before commits
- PR title format: `[component] description`
```

### 6. Boundaries

Tell agents what they should never touch. This prevents mistakes.

```markdown
## Boundaries

- Never commit secrets or API keys
- Never modify `vendor/` or `node_modules/`
- Ask before changing database schemas
```

## Updating an Existing AGENTS.md

When improving an existing file:

1. **Identify gaps**: Check which of the 6 core areas are missing or weak
2. **Update outdated commands**: Verify build/test commands still work
3. **Add specifics**: Replace vague guidance with concrete examples
4. **Strengthen boundaries**: Add any missing "never do" rules
5. **Keep it concise**: Remove redundant or obvious information

## Creating a New AGENTS.md

When creating from scratch:

1. **Explore the codebase**: Check package.json, Makefile, or build configs for commands
2. **Identify the stack**: Note languages, frameworks, and versions
3. **Find existing conventions**: Look at recent commits, linting configs, existing docs
4. **Start minimal**: Cover the 6 core areas briefly, then expand as needed

## Monorepos and Nested Files

For monorepos, use nested AGENTS.md files in subprojects:

```
repo/
├── AGENTS.md (root - general guidance)
├── packages/
│   ├── api/
│   │   └── AGENTS.md (API-specific)
│   └── web/
│       └── AGENTS.md (web-specific)
```

The closest AGENTS.md to the edited file takes precedence.

## References

- **Best practices and anti-patterns**: See [references/best-practices.md](references/best-practices.md)
- **Real-world examples**: See [references/examples.md](references/examples.md)
