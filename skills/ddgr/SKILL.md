---
name: ddgr
description: Search the web with DuckDuckGo using the `ddgr` CLI. Use when the user asks to look something up online, verify facts, or gather source links.
---

# Ddgr

Search the web from the terminal with `ddgr`.

```bash
ddgr --noprompt --noua --json --num 10 "query terms"
```

## Search Web

Preferred command (machine-readable JSON):

```bash
ddgr --noprompt --noua --json --num 10 "query terms"
```

Search with region targeting:

```bash
ddgr --noprompt --noua --json --num 10 -r us-en "query terms"
```

Common options:

- `--json`: Return JSON results for deterministic parsing
- `--num <N>`: Maximum number of results
- `-r <region>`: Region code such as `us-en` or `gb-en`
- `--noprompt`: Non-interactive mode
- `--noua`: Disable random user-agent behavior

## Fallback

If `--json` is not supported by the installed `ddgr` version, use plain output:

```bash
ddgr --noprompt --noua --num 10 "query terms"
```

Summarize results with title, URL, and snippet for each entry.
