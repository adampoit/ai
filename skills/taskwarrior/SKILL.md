---
name: taskwarrior
description: Manage tasks with the `task` (Taskwarrior) CLI. Use when the user asks to review tasks, get task summaries, add work items, or complete tasks.
---

# Taskwarrior

Inspect and manage tasks with `task`.

```bash
task +PENDING export
```

## List Tasks

Preferred command (JSON output):

```bash
task +PENDING export
```

With custom filters:

```bash
task project:work due:today +PENDING export
```

For tasks that fall between two dates (entry, completion, due, or modified time), use Bash variables:

```bash
start_date="<start-date>"
end_date="<end-date>"
task "((entry.after:${start_date} and entry.before:${end_date}) or (end.after:${start_date} and end.before:${end_date}) or (due.after:${start_date} and due.before:${end_date}) or (modified.after:${start_date} and modified.before:${end_date}))" export
```

Use `task rc.verbose=nothing ...` for concise text output when not using `export`.

## Task Summary

Build summary counts with these commands:

```bash
task +PENDING export
task +OVERDUE export
task due:today +PENDING export
task due:tomorrow +PENDING export
task priority:H +PENDING export
```

Summarize counts plus notable tasks (for example overdue or high priority).

## Task Details

Get one task by ID or UUID:

```bash
task <task-id-or-uuid> export
```

## Add Task

Create a task (mutating):

```bash
task add "Write Q1 planning notes" project:planning due:tomorrow priority:M +work +writing
```

## Complete Task

Mark task done (mutating):

```bash
task <task-id-or-uuid> done
```

## Guardrails

- Read-only operations: `task ... export` and `task ...` listing/info commands
- Mutating operations: `task add`, `task <id> done`, `task modify`, `task delete`
- Only run mutating commands when the user explicitly asks for changes
