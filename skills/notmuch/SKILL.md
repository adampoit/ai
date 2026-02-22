---
name: notmuch
description: Search and read local email with the `notmuch` CLI. Use when the user asks to find messages, inspect threads, or review email tags.
---

# Notmuch

Search local email and inspect message threads with `notmuch`.

```bash
notmuch search --format=json --limit=20 'tag:unread'
```

## Search Threads

Preferred command (machine-readable JSON):

```bash
notmuch search --format=json --limit=20 'from:alice subject:"design review" date:2026-02-01..'
```

Common query terms:

- `from:<email-or-name>`
- `to:<email-or-name>`
- `subject:<term>`
- `tag:<tag-name>`
- `date:YYYY-MM-DD..YYYY-MM-DD`
- `thread:<thread-id>`

## Read Messages

Headers-only summary for a thread/query:

```bash
notmuch show --format=json --body=false 'thread:0000000000000123'
```

Full text output:

```bash
notmuch show --format=text 'thread:0000000000000123'
```

Structured output with bodies:

```bash
notmuch show --format=json 'thread:0000000000000123'
```

## List Tags

```bash
notmuch search --output=tags '*'
```

## Guardrails

Prefer read-only commands in this skill:

- `notmuch search ...`
- `notmuch show ...`

Avoid mutating commands unless the user explicitly requests them (for example `notmuch new`, `notmuch tag`, `notmuch insert`).
