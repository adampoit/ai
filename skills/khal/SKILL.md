---
name: khal
description: Read calendar events with the `khal` CLI. Use when the user asks about meetings, schedule, upcoming events, or calendar searches.
---

# Khal

Read calendar events from the terminal with `khal`.

```bash
khal list --format '{calendar}|{start}|{end}|{title}|{location}|{description}|{status}' today eod
```

## List Events

Today's events:

```bash
khal list --format '{calendar}|{start}|{end}|{title}|{location}|{description}|{status}' today eod
```

Next 7 days:

```bash
khal list --format '{calendar}|{start}|{end}|{title}|{location}|{description}|{status}' today 7d
```

Custom range:

```bash
khal list --format '{calendar}|{start}|{end}|{title}|{location}|{description}|{status}' "start-date" "end-date"
```

Common date examples: `now`, `today`, `tomorrow`, `eod`, `7d`, `2026-02-21`.

## Search Events

`khal` does not provide a native full-text search command.

Use a wide date range and filter results in your response:

```bash
khal list --format '{calendar}|{start}|{end}|{title}|{location}|{description}|{status}' today 365d
```

Filter by keyword in `title`, `description`, or `location` after collecting the output.

## Parsing Notes

- Event rows use `|` separators in the format above
- `khal` may print date header lines (for example `Monday, 2026-02-23`); treat those as section headers, not events
- Return at most the number of events requested by the user
