# Best Practices

## What Works

### Be Specific About Your Stack

```markdown
<!-- Good -->

## Tech Stack

- React 18 with TypeScript 5.3
- Vite 5.0 for bundling
- Tailwind CSS 3.4
- Vitest for testing

<!-- Bad -->

## Tech Stack

React project with TypeScript
```

### Put Commands Early with Full Syntax

```markdown
<!-- Good -->

## Commands

- Install: `pnpm install`
- Dev: `pnpm dev --port 3000`
- Test: `pnpm test --coverage --watch`
- Build: `pnpm build --mode production`
- Lint: `pnpm lint --fix --cache`

<!-- Bad -->

## Commands

Use pnpm for package management. Run the dev server to start.
```

### Show Code Examples Over Explanations

````markdown
<!-- Good -->

## Code Style

```typescript
// Naming: camelCase for functions, PascalCase for types
async function fetchUserById(id: string): Promise<User> {
	if (!id) throw new Error("User ID required");
	return api.get(`/users/${id}`);
}

// Prefer arrow functions for callbacks
const users = data.map((item) => transformUser(item));
```
````

<!-- Bad -->

## Code Style

Use camelCase for function names. Prefer arrow functions.
Functions should have proper error handling.

````

### Use Three-Tier Boundaries

```markdown
## Boundaries

**Always do:**
- Run tests before commits
- Follow naming conventions
- Update tests when changing behavior

**Ask first:**
- Database schema changes
- Adding new dependencies
- Modifying CI/CD config

**Never do:**
- Commit secrets or API keys
- Edit `node_modules/` or `vendor/`
- Force push to main
- Remove failing tests
````

### Include Real File Paths

```markdown
## Structure

- `src/components/` - React components (one per file)
- `src/hooks/` - Custom React hooks
- `src/services/` - API clients and business logic
- `src/types/` - TypeScript type definitions
- `tests/unit/` - Unit tests (mirror src/ structure)
- `tests/e2e/` - Playwright end-to-end tests
```

## What Doesn't Work

### Vague Personas

```markdown
<!-- Bad -->

You are a helpful coding assistant that writes clean code.

<!-- Why it fails -->

Too generic. Doesn't tell the agent anything specific about this project.
```

### Missing Boundaries

```markdown
<!-- Bad -->

Feel free to make any changes you think are necessary.

<!-- Why it fails -->

Agents may modify critical files, remove tests, or commit secrets.
```

### Abstract Descriptions

```markdown
<!-- Bad -->

We follow best practices for code quality and testing.

<!-- Why it fails -->

"Best practices" means different things to different projects.
Agents need concrete examples, not abstract principles.
```

### Outdated Commands

```markdown
<!-- Bad -->

Run `npm run test` to run tests.
(But package.json uses pnpm and the script is `pnpm vitest`)

<!-- Why it fails -->

Agent will fail when running commands. Verify commands work.
```

## Quality Checklist

Before finalizing an AGENTS.md, verify:

- [ ] Commands are executable (tested on current codebase)
- [ ] Stack includes version numbers
- [ ] Code examples use actual project syntax/patterns
- [ ] Boundaries include "never" rules for secrets and critical files
- [ ] File structure matches actual directory layout
- [ ] Git workflow matches team conventions
