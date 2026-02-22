---
name: chatgpt-share-markdown
description: Convert public ChatGPT share links into clean Markdown transcripts for agent context. Use when a user provides a https://chatgpt.com/share/... URL and wants the conversation summarized, archived, or reused as input context.
---

# Chatgpt Share Markdown

Convert shared ChatGPT conversations into role-labeled Markdown using `./scripts/chatgpt-share-markdown.cs`.

```bash
dotnet run --file ./scripts/chatgpt-share-markdown.cs -- "https://chatgpt.com/share/<id>"
```

## Workflow

1. Run the script with a public `chatgpt.com/share/...` URL.
2. Inspect the generated Markdown for media placeholders and formatting.
3. Use the Markdown directly as context, or trim it to only the relevant turns.

## Commands

Export to stdout:

```bash
dotnet run --file ./scripts/chatgpt-share-markdown.cs -- "https://chatgpt.com/share/<id>"
```

Export to a file:

```bash
dotnet run --file ./scripts/chatgpt-share-markdown.cs -- "https://chatgpt.com/share/<id>" --output "/tmp/chat-context.md"
```

## Output

- Conversation title as H1
- Metadata block with source URL and optional update timestamp/model
- One section per turn: `## User` and `## Assistant` by default (`## Tool` optional)
- Markdown-friendly content with fenced code blocks and basic multimodal placeholders
- Internal tool-action payloads and reasoning recaps are omitted by default to keep context clean

Optional flags:

```bash
--include-tool-turns --include-internal-actions --include-reasoning
```

## Troubleshooting

- If the URL is not a public share link, request `https://chatgpt.com/share/...`.
- If parsing fails, rerun once; share page payload shape can change.
- If output looks incomplete, keep the parser output and supplement manually only for missing turns.
