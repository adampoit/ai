---
name: agents-md
description: Create and maintain AGENTS.md files that provide AI coding agents with project context, commands, code style, and boundaries. Use when updating an existing AGENTS.md, creating a new AGENTS.md for a repository, or improving agent instructions for a codebase.
---

# Agents Md

AGENTS.md is a README for AI agents: a dedicated place to provide context and instructions to help AI coding agents work effectively on a project.

## Important: Keep It Minimal

**Key principle**: Include only what agents cannot infer from the codebase itself. Redundant documentation is harmful—agents already read files, search code, and understand common patterns.

## When to Create/Update

- **Create**: When the project has non-obvious tooling, specific commands, or critical boundaries agents must know
- **Update**: When commands change, new critical constraints are added, or tooling requirements evolve
- **Omit**: If your repository has standard structure and common tooling (React, Python, etc.) that agents already understand

## What to Include

Focus only on information agents cannot discover themselves:

### 1. Essential Commands (Required)

Specific commands with full flags. Include only if non-standard or critical.

```markdown
## Commands

- Install: `pnpm install`
- Dev: `pnpm dev --port 3000`
- Test: `pnpm test --coverage`
- Build: `pnpm build`
```

**Skip this section if using standard commands** (e.g., `npm install`, `npm test`).

### 2. Tooling Requirements (If Non-Standard)

Specify tools agents should use. Research shows agents DO follow specific tool instructions (e.g., `uv` usage increases 1.6x when mentioned).

```markdown
## Tooling

- Use `uv` for Python dependency management
- Use `ruff` for linting (not flake8)
- Use `just` for task running (not Make)
```

**Only include if different from defaults** agents would assume.

### 3. Boundaries (Critical)

What agents must NEVER do. This is the highest-value content.

```markdown
## Boundaries

- Never commit secrets, API keys, or `.env` files
- Never modify `vendor/`, `node_modules/`, or lock files
- Never remove failing tests—fix or ask first
- Ask before changing database schemas
```

**Always include this section.** It prevents costly mistakes.

### 4. Project-Specific Patterns (If Unusual)

Only document patterns that differ from standard conventions in your stack.

```markdown
## Patterns

- Use functional React components, not classes
- Place tests in `__tests__/` folders (not `.test.ts` files)
- Import order: React, third-party, `@/`, relative
```

**Skip if following standard conventions** for your framework/language.

## What to Avoid

Based on research findings, do NOT include:

### ❌ Codebase Overviews

Research shows "context files do not provide effective overviews"—agents don't discover files faster with overviews present. They already search and explore code effectively.

**Don't write:**

```markdown
## Overview

This is a React application with a component-based architecture...
```

### ❌ Comprehensive Structure Documentation

Listing every directory is redundant. Agents can explore the filesystem.

**Don't write:**

```markdown
## Structure

- `src/components/` - React components
- `src/hooks/` - Custom hooks
- `src/utils/` - Utility functions
```

### ❌ Obvious Style Guidelines

Agents already know common patterns (camelCase, functional components, etc.).

**Don't write:**

```markdown
## Code Style

- Use camelCase for functions
- Use PascalCase for components
- Prefer const over let
```

### ❌ Verbose Explanations

Code examples are clearer than paragraphs. One snippet beats three paragraphs.

**Prefer:**

```markdown
## Commands

- Test: `pytest -xvs tests/`
```

**Over:**

```markdown
## Testing

To run tests, use the pytest command. This will discover all tests in the tests directory and execute them with verbose output and fail-fast behavior...
```

## Workflow

1. **Check if needed**: Does the repo have non-obvious tooling or critical constraints?
2. **If yes, create minimal file**: Include only Commands (if non-standard), Tooling (if non-standard), Boundaries (always), and Patterns (if unusual)
3. **If updating existing**: Remove redundant sections, keep only high-value content
4. **Validate**: Ensure every line provides information agents cannot infer

## Examples

### Good: Minimal and Specific

```markdown
# AGENTS.md

## Commands

- Install: `uv pip install -e ".[dev]"`
- Dev: `uvicorn app.main:app --reload --port 8000`
- Test: `pytest -xvs`
- Lint: `ruff check --fix .`

## Tooling

- Use `uv` for dependencies (not pip)
- Use `ruff` for linting and formatting

## Boundaries

- Never commit `.env` files
- Never modify `alembic/versions/` after merge
- Ask before schema changes
```

### Bad: Redundant and Verbose

```markdown
# AGENTS.md

## Overview

This is a FastAPI backend application with SQLAlchemy ORM.

## Tech Stack

- Python 3.12
- FastAPI 0.109
- SQLAlchemy 2.0
- PostgreSQL

## Structure

- `app/` - Application code
  - `api/` - Route handlers
  - `models/` - SQLAlchemy models
- `tests/` - Test files

## Code Style

- Use type hints on all functions
- Write docstrings for public functions
- Use async where possible

## Commands

- Install: `pip install -e ".[dev]"`
- Dev: `uvicorn app.main:app --reload`
- Test: `pytest`
```

**Why it's bad**: Stack and structure are discoverable from files. Style guidelines are standard Python practices. Overview is unnecessary.

## Monorepos

For monorepos, place minimal AGENTS.md files at subproject roots:

```
repo/
├── AGENTS.md (root - only if repo-wide constraints exist)
├── packages/
│   ├── api/
│   │   └── AGENTS.md (API-specific tooling/boundaries)
│   └── web/
│       └── AGENTS.md (web-specific tooling/boundaries)
```

Keep each file focused on what differs from defaults.

## References

- **Best practices and anti-patterns**: See [references/best-practices.md](references/best-practices.md)
- **Real-world examples**: See [references/examples.md](references/examples.md)
