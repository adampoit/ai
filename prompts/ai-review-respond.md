---
description: "Respond to code review on a pull request"
---

# Responding to PR Code Review Feedback

You are responding to feedback on a GitHub PR and implementing changes that address that feedback.

## Fetching PR Review Feedback

There are two types of review feedback to fetch:

### 1. High-Level Review Comments

These are the overall review comments submitted with an approval, request for changes, or comment. Use `gh pr view`:

```bash
gh pr view --json reviews
```

This returns reviews with:

- `author`: Who left the review
- `body`: The high-level comment text
- `state`: `APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED`

### 2. Inline Review Comments

These are comments on specific lines of code. Use `gh api` to fetch them:

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments
```

When working with GitHub Enterprise instances (or any non-github.com host), use the `--hostname` flag:

```bash
gh api --hostname github.example.com repos/{owner}/{repo}/pulls/{pr_number}/comments
```

## Understanding Inline Comments

The API returns an array of review comments. Key fields to look for:

- `path`: The file the comment is on
- `line` / `original_line`: The line number in the diff
- `body`: The actual comment text (may contain markdown, including code suggestions)
- `diff_hunk`: The surrounding code context
- `in_reply_to_id`: If present, this comment is a reply to another comment (part of a thread)

## Interpreting Code Suggestions

GitHub's suggestion syntax in the `body` field looks like:

````markdown
```suggestion
const { foo, bar } = options;
```
````

This indicates the reviewer is suggesting replacing the code in the diff hunk with the suggested code.

## Workflow for Addressing Feedback

1. **Fetch all feedback**: Use both commands above to get high-level reviews and inline comments.

2. **Group inline comments by thread**: Comments with `in_reply_to_id` are replies. Group them together to understand the full conversation.

3. **Identify actionable items**: Look for:
   - Explicit suggestions (code blocks with `suggestion` language)
   - Requests prefixed with "nit:" (minor style/preference issues)
   - Questions or concerns that may require code changes
   - Approval comments that don't require action

4. **Prioritize changes**:
   - Address blocking feedback first (requests for changes, bugs, security issues)
   - Then address nits and style suggestions
   - Consider whether suggestions align with the codebase conventions

5. **Make changes**: Apply the suggested changes, ensuring:
   - Tests still pass after changes
   - The change doesn't break other functionality
   - The change aligns with the original intent of the PR

6. **Verify**: Run the test suite and linter.

## Example

Given this API response:

````json
{
	"path": "src/utils/example.ts",
	"line": 15,
	"body": "nit:\n\n```suggestion\n\t{ config, options, flags }: ExampleOptions = {}\n) => {\n```",
	"diff_hunk": "@@ -12,7 +12,7 @@ export const exampleFunction = (\n \tparam: string,\n-\toptions: ExampleOptions = {}\n+\t{ config, options, flags }: ExampleOptions = {}\n ) => {"
}
````

This indicates the reviewer suggests destructuring the options directly in the function parameter instead of in a separate line. The "nit:" prefix indicates this is a minor style preference, not a blocking issue.
