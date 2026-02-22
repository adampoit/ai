---
name: jira
description: Search Jira issues with JQL or free text, and read Jira issue details with comments using the external jira-cli (`jira`) command. Use when the user asks to find Jira tickets, inspect issue details, review comments, or run Jira queries.
---

# Jira

Search Jira issues and read issue details with `jira`.

```bash
jira issue list --jql 'text ~ "workflow runner failure"' --paginate 0:10 --raw
```

## Search Issues

Search with free text:

```bash
jira issue list "build failure" --paginate 0:10 --raw
```

Search with explicit JQL:

```bash
jira issue list --jql "project = PROJ AND statusCategory != Done ORDER BY updated DESC" --paginate 0:10 --raw
```

Common options:

- `--jql`: Raw JQL query
- positional text: Free-text query
- `--paginate 0:10`: Offset/limit style pagination
- `--raw`: JSON output for deterministic parsing

## Read Issue

Read one issue with comments:

```bash
jira issue view PROJ-1234 --comments 20 --raw
```

Read plain text output (non-JSON):

```bash
jira issue view PROJ-1234 --comments 5 --plain
```

## Guardrails

Prefer read-only commands in this skill:

- `jira issue list ...`
- `jira issue view ...`

Avoid mutating commands unless the user explicitly requests edits (for example `jira issue create`, `jira issue edit`, `jira issue delete`, `jira issue move`, `jira issue assign`, `jira issue comment add`).

Use `--raw` whenever machine-readable output is needed.
