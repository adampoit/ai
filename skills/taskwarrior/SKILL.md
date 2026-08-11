---
name: taskwarrior
description: Manage tasks with the `task` (Taskwarrior) CLI, including attaching notes with `task-note`. Use when the user asks to review tasks, get task summaries, add work items, complete tasks, or attach notes.
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

## Attach Notes

`task-note` is an external Taskwarrior helper, not a built-in `task` command. Confirm it is installed before using it:

```bash
command -v task-note
```

It takes exactly one argument. It ensures the task has a `Notes file: <notes-dir>/<uuid>.md (read this file for full content)` annotation, then opens the note in an interactive editor via `taskopen`:

```bash
task-note <task-id-or-uuid>
```

Notes live in `$XDG_DATA_HOME/tasknotes/<uuid>.md` (default `~/.local/share/tasknotes/<uuid>.md`).

### Non-interactive (agents)

`task-note <task>` with no subcommand opens an editor, so agents should use the subcommands instead:

```bash
task-note <task-id-or-uuid> set <<'EOF'
# Note title

Note body...
EOF

task-note <task-id-or-uuid> append <<'EOF'
More details...
EOF

task-note <task-id-or-uuid> show   # print the note contents
task-note <task-id-or-uuid> path   # print the note file path
```

`set`, `append`, and `path` create the `Notes file:` annotation automatically; UUID resolution and file placement are handled by the script.

Use a plain annotation only when a short inline note is sufficient:

Use a plain annotation only when a short inline note is sufficient:

```bash
task <task-id-or-uuid> annotate "Short note"
```

## Complete Task

Mark task done (mutating):

```bash
task <task-id-or-uuid> done
```

## Guardrails

- Read-only operations: `task ... export` and `task ...` listing/info commands; `task-note <id> show` and `task-note <id> path` (path may add the notes annotation)
- Mutating operations: `task add`, `task <id> done`, `task modify`, `task <id> annotate`, `task <id> delete`, `task-note <id>`, and `task-note <id> set|append`
- Only run mutating commands when the user explicitly asks for changes
