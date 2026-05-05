---
name: tmux-interactive-processes
description: Use tmux instead of background bash for long-running, interactive, inspectable, or user-attachable terminal processes. Use for development servers, watch-mode tests, REPLs, debuggers, interactive CLIs, log tailing, and commands that may run indefinitely or need later input/inspection.
---

# Tmux Interactive Processes

Use tmux when a command needs to keep running, accept later input, show ongoing output, or remain available for human attachment.

Prefer tmux over raw background shell patterns because the process stays visible, inspectable, attachable, and controllable.

## Avoid Background Bash

Do not use these patterns for long-running or interactive work:

```bash
command &
nohup command &
command > log.txt 2>&1 &
disown
tail -f log.txt
```

Use normal shell execution only when the command runs to completion and prints final output.

## Session Names

Use stable, descriptive names:

```bash
agent-<repo-or-project>-<purpose>
```

Examples:

```bash
agent-myapp-dev
agent-myapp-tests
agent-myapp-debug
agent-myapp-repl
```

Check existing sessions before creating a new one:

```bash
tmux list-sessions
```

Reuse a matching session when appropriate.

## Start Commands

Create a detached session from the current working directory:

```bash
tmux new-session -d -s agent-myapp-dev -c "$PWD" 'npm run dev'
```

For commands with tricky quoting, start a shell first:

```bash
tmux new-session -d -s agent-myapp-dev -c "$PWD" bash
tmux send-keys -t agent-myapp-dev 'npm run dev' C-m
```

Inspect the pane after startup before claiming success.

## Inspect Output

Capture recent output:

```bash
tmux capture-pane -pt agent-myapp-dev -S -200
```

Capture more history:

```bash
tmux capture-pane -pt agent-myapp-dev -S -1000
```

Use `capture-pane` to verify readiness, failures, prompts, and current state.

## Send Input

Send text followed by Enter:

```bash
tmux send-keys -t agent-myapp-dev 'help' C-m
```

Send control keys:

```bash
tmux send-keys -t agent-myapp-dev C-c
```

Use `send-keys` for REPLs, debuggers, prompts, and graceful shutdown.

## User Attachment

When useful, report the session name and attach command:

```bash
tmux attach -t agent-myapp-dev
```

## Stop Sessions

Prefer graceful shutdown first:

```bash
tmux send-keys -t agent-myapp-dev C-c
```

Inspect after shutdown:

```bash
tmux capture-pane -pt agent-myapp-dev -S -100
```

Remove the session only when it is no longer needed:

```bash
tmux kill-session -t agent-myapp-dev
```

## Checklist

1. Run `tmux list-sessions`.
2. Reuse a matching session or create a detached session.
3. Capture pane output after startup.
4. Report the session name to the user.
5. Inspect with `capture-pane` before making claims about state.
6. Interact with `send-keys` when input is needed.
7. Clean up sessions that are no longer needed.

## Decision Rule

If a command is expected to run continuously, wait for input, display ongoing output, or require later interaction, use tmux.

If a command runs to completion and only prints final output, use normal shell execution.
