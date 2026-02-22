---
name: slack
description: Search Slack messages and read Slack threads. Use when the user asks to search Slack, find messages, look up conversations, read thread replies, or retrieve Slack content. Triggers on requests involving Slack message lookup, conversation history, or thread reading.
---

# Slack

Search Slack messages and read thread replies using `./scripts/slack.cs`.

```bash
dotnet run ./scripts/slack.cs search --query "deployment issue" --max-results 10
```

## Prerequisites

Requires `SLACK_API_TOKEN` environment variable with a bot or user OAuth token that has appropriate scopes (e.g., `search:read`, `channels:history`, `users:read`).

## Search Messages

Search for messages matching a query:

```bash
dotnet run ./scripts/slack.cs search --query "deployment issue" --max-results 10
```

Options:

- `--query` (required): Search terms
- `--max-results`: Number of results (default 10)

Returns JSON array with `position`, `text`, `channel`, `ts`, `permalink`, `user_id`, `user_name`.

## Read Thread

Read all replies in a thread using channel ID and thread timestamp:

```bash
dotnet run ./scripts/slack.cs thread --channel C12345678 --thread-ts 1763045400.882969
```

Or use a permalink URL:

```bash
dotnet run ./scripts/slack.cs thread --permalink "https://example.com/archives/C12345678/p1763045400882969"
```

Options:

- `--channel` (required unless using permalink): Channel ID
- `--thread-ts` (required unless using permalink): Parent message timestamp
- `--permalink`: Slack permalink URL (extracts channel and thread_ts automatically)
- `--max-results`: Max replies to return (default 100)

Returns JSON array with `index`, `user_id`, `user_name`, `text`, `ts`, `thread_ts`.

## Typical Workflow

1. Search for relevant messages with `search --query "..."`
2. Review results to find threads of interest (note the `permalink` or `channel`/`ts`)
3. Use `thread` with the channel and timestamp to read full thread context
