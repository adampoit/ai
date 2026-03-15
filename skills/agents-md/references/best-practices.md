# Best Practices

Based on research (arXiv:2602.11988v1), comprehensive context files increase costs by 20%+ with minimal benefit. These practices focus on **minimal, high-value content only**.

## Core Principle: Include Only What Agents Cannot Infer

Agents can:
- Read `package.json`, `pyproject.toml`, etc. to understand the stack
- Explore the file system to understand structure
- Follow standard conventions for common frameworks
- Search code to understand patterns

**Don't document what agents can discover themselves.**

## What Works

### 1. Specify Non-Standard Tooling

Research shows agents DO follow specific tool instructions (e.g., `uv` usage increases 1.6x when mentioned).

```markdown
<!-- Good -->

## Tooling

- Use `uv` for Python dependency management (not pip)
- Use `ruff` for linting (not flake8/pylint)
- Use `just` for task running (not Make/npm scripts)

<!-- Bad -->

## Tooling

- Use npm for package management
- Use jest for testing
```

**Why**: Agents already know to use npm/jest for Node projects. They don't know you specifically require `uv` over pip.

### 2. Include Essential Commands with Full Syntax

Only include if non-standard or critical flags are required.

```markdown
<!-- Good -->

## Commands

- Dev: `pnpm dev --port 3000`
- Test: `pytest -xvs tests/unit/`
- Migrations: `alembic upgrade head`

<!-- Skip entirely if standard -->

(If using `npm install`, `npm test`, `npm build`, omit this section)
```

**Why**: Agents know standard commands. They need help with custom ports, specific flags, or non-standard tools.

### 3. Document ONLY Non-Standard Patterns

Skip standard conventions agents already know.

```markdown
<!-- Good - Non-standard pattern -->

## Patterns

- Named exports only (no `export default`)
- Test files use `.spec.ts` (not `.test.ts`)
- Place hooks in `src/composables/` (not `src/hooks/`)

<!-- Bad - Standard conventions -->

## Code Style

- Use camelCase for functions
- Use PascalCase for components
- Prefer const over let
- Use functional components
```

**Why**: The "bad" example states obvious conventions. The "good" example highlights deviations from standard React patterns.

### 4. Use Three-Tier Boundaries (Always Include)

Boundaries are the **highest-value content**. Always include this section.

```markdown
## Boundaries

**Never do:**
- Commit secrets, API keys, or `.env` files
- Modify `node_modules/`, `vendor/`, or lock files
- Remove failing tests
- Force push to main

**Ask first:**
- Database schema changes
- Adding new dependencies
- Modifying CI/CD config
- Changing public APIs

**Always do:**
- Run tests before commits
- Update tests when changing behavior
```

**Why**: Prevents costly mistakes. Agents follow these constraints.

## What to Avoid

### ❌ Tech Stack Sections

```markdown
<!-- Bad -->

## Tech Stack

- React 18 with TypeScript 5.3
- Vite 5.0 for bundling
- Tailwind CSS 3.4

<!-- Why it fails -->
```

Research found context files "do not provide effective overviews." Agents discover stack from config files. Skip this section entirely.

### ❌ Comprehensive Structure Documentation

```markdown
<!-- Bad -->

## Structure

- `src/components/` - React components
- `src/hooks/` - Custom hooks
- `src/utils/` - Helper functions

<!-- Why it fails -->
```

Agents explore the file system. This is redundant. Only document unusual structures (e.g., "Tests live in `__tests__/` subdirectories, not `.test.ts` files").

### ❌ Standard Code Style Guidelines

```markdown
<!-- Bad -->

## Code Style

- Use camelCase for function names
- Prefer arrow functions for callbacks
- Add JSDoc to public functions

<!-- Why it fails -->
```

These are standard conventions for most projects. Agents know this. Only document deviations from your language/framework defaults.

### ❌ Verbose Explanations

```markdown
<!-- Bad -->

## Commands

To install dependencies, run the install command which will read the package.json file and download all necessary packages from the npm registry...

<!-- Why it fails -->
```

One code snippet beats three paragraphs. Be concise.

### ❌ Vague Guidance

```markdown
<!-- Bad -->

You are a helpful coding assistant that writes clean code.

<!-- Why it fails -->

Too generic. Doesn't tell the agent anything specific about this project.
```

### ❌ Missing Boundaries

```markdown
<!-- Bad -->

Feel free to make any changes you think are necessary.

<!-- Why it fails -->

Agents may modify critical files, remove tests, or commit secrets.
```

### ❌ Outdated Commands

```markdown
<!-- Bad -->

Run `npm run test` to run tests.
(But package.json uses pnpm and the script is `pnpm vitest`)

<!-- Why it fails -->

Agent will fail when running commands. Verify commands work.
```

## Quality Checklist

Before finalizing an AGENTS.md, verify:

- [ ] **Minimal size**: File is under 30 lines when possible
- [ ] **No obvious info**: Removed stack versions, structure lists, standard conventions
- [ ] **Tooling specified**: Non-standard tools are explicitly called out
- [ ] **Commands verified**: All commands tested and working
- [ ] **Boundaries present**: "Never do" rules for secrets and critical files
- [ ] **Patterns specific**: Only non-standard patterns documented

## Red Flags (Remove These)

If your AGENTS.md includes these, revise:

- [ ] Tech Stack section with version numbers
- [ ] Structure section listing standard directories
- [ ] Code Style section with standard conventions
- [ ] Overview/Introduction paragraphs
- [ ] Git workflow (unless non-standard)
- [ ] More than 40 lines total

## Remember

Research shows comprehensive context files increase costs by 20%+ while providing only marginal benefits (4% for human-written, -3% for LLM-generated).

**When in doubt, leave it out.**
