# Examples

Real-world examples of effective AGENTS.md sections.

## Complete Example: TypeScript React Project

````markdown
# AGENTS.md

## Tech Stack

- React 18.2 with TypeScript 5.3
- Vite 5.0 for dev/build
- Tailwind CSS 3.4
- Vitest + React Testing Library

## Commands

- Install: `pnpm install`
- Dev: `pnpm dev`
- Test: `pnpm test`
- Test watch: `pnpm test:watch`
- Build: `pnpm build`
- Lint: `pnpm lint --fix`
- Type check: `pnpm typecheck`

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

```tsx
interface UserCardProps {
	user: User;
	onSelect: (id: string) => void;
}

export function UserCard({ user, onSelect }: UserCardProps) {
	return <div onClick={() => onSelect(user.id)}>{user.name}</div>;
}
```
````

## Testing

- Run `pnpm test` before commits
- Test files: `*.test.tsx` next to source
- Mock API calls with MSW

## Git

- Commit format: `type(scope): description`
- Types: feat, fix, refactor, test, docs, chore
- Example: `feat(auth): add login form validation`

## Boundaries

- Never commit `.env` files
- Never modify `pnpm-lock.yaml` manually
- Ask before adding dependencies
- Never remove failing tests

````

## Complete Example: Python Backend

```markdown
# AGENTS.md

## Tech Stack
- Python 3.12
- FastAPI 0.109
- SQLAlchemy 2.0 with PostgreSQL
- Pytest for testing

## Commands
- Install: `pip install -e ".[dev]"`
- Dev: `uvicorn app.main:app --reload`
- Test: `pytest -v`
- Test coverage: `pytest --cov=app`
- Lint: `ruff check --fix .`
- Format: `ruff format .`
- Type check: `mypy app/`

## Structure
- `app/` - Application code
  - `api/` - Route handlers
  - `models/` - SQLAlchemy models
  - `schemas/` - Pydantic schemas
  - `services/` - Business logic
- `tests/` - Test files
- `migrations/` - Alembic migrations

## Code Style
- Type hints on all functions
- Docstrings for public functions
- Async where possible

```python
async def get_user_by_id(
    user_id: UUID,
    db: AsyncSession
) -> User | None:
    """Fetch a user by their unique identifier."""
    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    return result.scalar_one_or_none()
````

## Database

- Never modify migrations after merging
- Run `alembic upgrade head` after pulling
- Test migrations: `alembic upgrade head && alembic downgrade -1`

## Boundaries

- Never commit `.env` or credentials
- Never modify `alembic/versions/` files after merge
- Ask before schema changes
- Never bypass type checking

````

## Complete Example: Monorepo

```markdown
# AGENTS.md (root)

## Overview
Monorepo containing API, web app, and shared packages.

## Commands
- Install all: `pnpm install`
- Build all: `pnpm build`
- Test all: `pnpm test`
- Run specific: `pnpm --filter @acme/web dev`

## Structure
- `apps/api/` - FastAPI backend (see apps/api/AGENTS.md)
- `apps/web/` - Next.js frontend (see apps/web/AGENTS.md)
- `packages/shared/` - Shared TypeScript types
- `packages/ui/` - Component library

## Boundaries
- Cross-package imports use `@acme/*` aliases
- Never import from `../../../` paths
- Shared types go in `packages/shared`
````
