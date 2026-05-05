---
name: jj
description: Use Jujutsu (`jj`) for version control operations including status, history, diffs, commits, rebases, splits, squashes, and Git interop. Use when a repository is initialized for jj or the user asks for jj/Jujutsu workflows.
---

# jj

Use `jj` for version control when a repository has a `.jj/` directory or `jj status` succeeds.

```bash
jj status
```

## Core Model

- There is no staging area; commands operate on the current change or selected revisions.
- The working copy is a mutable commit/change. Use `jj describe` to set its message.
- Change IDs are stable across rewrites; commit IDs change when contents or metadata change.
- Most history edits are safe because jj records operations in the operation log.

## Inspect State

Start with these read-only commands:

```bash
jj status
jj log --limit 20
jj diff --git
```

Inspect a specific revision:

```bash
jj show <revset>
jj evolog -r <revset>
```

Useful revsets:

- `@`: current working-copy commit
- `@-`: parent of the working-copy commit
- `::@`: ancestors of the working-copy commit
- `@::`: descendants of the working-copy commit
- `trunk()`: repository trunk/main baseline
- `mine()`: changes authored by the current user
- `conflicted()`: changes with conflicts
- `mutable()`: changes that can be rewritten

Quote revsets in shell commands when they contain special characters:

```bash
jj log -r 'trunk()..@'
```

## Make Commits

Describe the current change before creating a new one:

```bash
jj describe -m "Explain why this change exists"
jj new
```

Create a new change from a specific parent:

```bash
jj new <revset>
```

Prefer small, atomic changes. If the working copy mixes concerns, split it before describing or submitting.

`jj desc` is the common shorthand for `jj describe`; use either form consistently with nearby docs or commands.

## Refine History

Move selected changes from the working copy into its parent:

```bash
jj squash
```

Absorb modifications into matching mutable ancestors:

```bash
jj absorb
```

Split a mixed change:

```bash
jj split
```

Split whole files or filesets non-interactively by passing paths and a message:

```bash
jj split -r @ path/to/file1 path/to/file2 -m "Move focused changes into their own commit"
jj split -r @ 'glob:src/**/*.rs' -m "Update Rust sources"
```

## Rebase

Use `--onto`/`-o` for destinations:

```bash
jj rebase -r <revset> -o <destination>
```

Common forms:

```bash
jj rebase -r @ -o trunk()
jj rebase -s <source> -o <destination>
jj rebase -b <branch> -o <destination>
```

Avoid deprecated `--destination`/`-d` examples unless an installed jj version requires them.

## Git Interop

Fetch and push through jj in colocated Git repositories:

```bash
jj git fetch
jj git push
```

Create or update a Git bookmark before pushing when needed:

```bash
jj bookmark set <name> -r <revset>
jj git push --bookmark <name>
```

Do not use `git add`, `git commit`, or Git staging workflows in a jj repository unless the user explicitly asks for Git commands.

## Operation Log

Inspect recent jj operations:

```bash
jj op log
```

Undo or redo the most recent operation:

```bash
jj undo
jj redo
```

Recover from a bad operation by restoring a previous operation only when the user explicitly approves:

```bash
jj op restore <operation-id>
```

## Non-Interactive Safety

Prefer explicit messages and non-interactive flags:

```bash
jj describe -m "Message"
jj new --no-edit <revset>
jj --no-pager log --limit 20
```

Use `jj diff --git` for familiar unified diffs; jj's default diff format can be harder for agents to read.

## Guardrails

- Only push, restore operations, abandon changes, or rewrite unrelated user changes when explicitly requested.
- Before mutating history, inspect `jj status` and `jj log --limit 20` so you understand the current stack.
