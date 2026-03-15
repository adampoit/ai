# Examples

Real-world examples of minimal, effective AGENTS.md files.

## Example 1: TypeScript React Project

**Scenario**: Standard React + TypeScript + Vite setup. Only non-standard patterns need documentation.

```markdown
# AGENTS.md

## Commands

- Install: `pnpm install`
- Dev: `pnpm dev --port 3000`
- Test: `pnpm test`
- Build: `pnpm build`

## Patterns

- Named exports only (no `export default`)
- Props interfaces named `{Component}Props`
- Test files: `*.test.tsx` next to source (not in `__tests__/`)

## Boundaries

- Never commit `.env` files
- Never modify `pnpm-lock.yaml` manually
- Never remove failing tests
- Ask before adding dependencies
```

**Why this works**: 
- Stack info removed (discoverable from `package.json`)
- Structure removed (standard `src/` layout)
- Code style minimized (only non-standard patterns: named exports, props naming)
- Git workflow removed (standard conventional commits)

---

## Example 2: Python Backend

**Scenario**: FastAPI project using `uv` (non-standard tooling) with Alembic migrations.

```markdown
# AGENTS.md

## Commands

- Install: `uv pip install -e ".[dev]"`
- Dev: `uvicorn app.main:app --reload`
- Test: `pytest -xvs`
- Lint: `ruff check --fix .`
- Migrations: `alembic upgrade head`

## Tooling

- Use `uv` for dependency management (not pip)
- Use `ruff` for linting and formatting

## Boundaries

- Never commit `.env` or credentials
- Never modify `alembic/versions/` files after merge
- Ask before database schema changes
```

**Why this works**:
- Tech stack removed (discoverable from `pyproject.toml`)
- Structure removed (discoverable from file tree)
- Tooling section added (critical: specifies `uv` vs pip)
- Only migration-specific boundaries included

---

## Example 3: Monorepo

**Scenario**: Monorepo with specific cross-package import rules.

```markdown
# AGENTS.md (root)

## Commands

- Install all: `pnpm install`
- Build all: `pnpm build`
- Run specific package: `pnpm --filter @acme/web dev`

## Boundaries

- Cross-package imports must use `@acme/*` aliases
- Never use relative imports like `../../../` between packages
- Shared types belong in `packages/shared` only
```

**Why this works**:
- Overview removed (obvious from structure)
- Structure list removed (discoverable)
- Only package-specific rules included (aliases, no relative imports)

---

## Example 4: Minimal (When to Skip Most Sections)

**Scenario**: Standard Python project with no unusual tooling.

```markdown
# AGENTS.md

## Boundaries

- Never commit `.env` files
- Never remove failing tests
```

**Why this works**: 
- Standard `pip install` / `pytest` commands omitted
- No special tooling to specify
- Structure is standard
- Only critical boundaries documented

---

## Before & After Comparison

### Before (Verbose - Don't Do This)

```markdown
# AGENTS.md

## Overview
This is a React application built with Vite and TypeScript.

## Tech Stack
- React 18.2 with TypeScript 5.3
- Vite 5.0 for dev/build
- Tailwind CSS 3.4
- Vitest + React Testing Library

## Structure
- `src/components/` - React components
- `src/hooks/` - Custom hooks
- `src/services/` - API clients
- `src/types/` - TypeScript types
- `src/utils/` - Helper functions
- `tests/` - Test files (mirrors src/)

## Code Style
- Functional components only
- Named exports (no default exports)
- Props interfaces named `{Component}Props`
- Use camelCase for functions
- Use PascalCase for components

## Commands
- Install: `pnpm install`
- Dev: `pnpm dev`
- Test: `pnpm test`
- Build: `pnpm build`

## Testing
- Run tests before commits
- Test files: `*.test.tsx` next to source
- Mock API calls with MSW

## Git
- Commit format: `type(scope): description`
- Types: feat, fix, refactor, test, docs, chore

## Boundaries
- Never commit `.env` files
- Never modify `pnpm-lock.yaml` manually
- Ask before adding dependencies
- Never remove failing tests
```

### After (Minimal - Do This)

```markdown
# AGENTS.md

## Commands

- Dev: `pnpm dev --port 3000`

## Patterns

- Named exports only (no `export default`)
- Props interfaces named `{Component}Props`

## Boundaries

- Never commit `.env` files
- Never modify `pnpm-lock.yaml`
- Never remove failing tests
- Ask before adding dependencies
```

**Reduction**: ~40 lines → ~15 lines (62% smaller)

**What was removed**:
- Overview (obvious)
- Tech Stack (in `package.json`)
- Structure (discoverable)
- Most Code Style (standard React patterns)
- Standard Commands (`pnpm install`, `pnpm test`, `pnpm build`)
- Testing section (standard Vitest usage)
- Git section (standard conventional commits)
