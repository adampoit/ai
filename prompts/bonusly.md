---
description: Recommend coworkers to give Bonusly points to with reasoning.
agent: assistant
---

Help me decide who to recognize on Bonusly by producing a ranked list of coworkers, concise reasons, a points recommendation, and a short summary.

## Gather context

Before doing any recommendation, first fetch context.

- Fetch recent context
  - Slack messages and threads
  - PR reviews
  - Merged PRs
  - Completed tasks
  - JIRA cases
  - Emails (both deleted and non-deleted)
- Consider the past 2 weeks of context (use ISO dates for filters; make the window configurable)

### High-level process (explicit)

1. Fetch Slack messages from the user
   - Query: use `from:me` with the date window to list messages you (the requester) sent. Example: `from:me after:2025-11-26 before:2025-12-10`.
   - Collect the message `ts` and `thread_ts` fields for each hit. If a message has no `thread_ts`, use its own `ts` as the thread root.

2. Resolve messages to threads
   - For each message, fetch the full thread (all replies) using the Slack tool.
   - Aggregate thread contents: root message, all replies, authors, timestamps, and any links to PRs, JIRA issues, commits, or tickets.

3. Extract events from threads
   - Detect messages that contain evidence of collaboration: we are looking for positive interactions.
   - For replies from coworkers, note whether they provided solutions, guidance, or direct code changes (links to PRs or commits). Mark those as collaboration/helping signals.

4. Fetch complementary context
   - JIRA: query issues where you are assignee/reporter/commenter using `currentUser()` and the date window.
   - Email (notmuch): search messages (including deleted) where coworkers appear in from/to/cc within the date window.

5. Normalize and attribute contributions to people
   - From threads and PR/JIRA/email data, build a per-person activity summary for the window:
     - PRs authored/merged that affected product/customer experience
     - Reviews provided (with links and short summaries when available)
     - Threads where the person supplied the fix or decisive guidance
     - Infra/CI fixes or process changes (evidence: settings changed, runner/cache fixes, host updates)
     - Mentorship/help (pairing, detailed explanations, follow-ups)
   - Where evidence is ambiguous, prefer conservative attribution (e.g., credit visible action like a merged PR or an explicit "I fixed this" comment).

6. Score contributions using the rubric
   - For each person, compute subscores:
     - Impact (0-4): based on customer/product effect (merged PRs that change UI/UX, bug fixes affecting customers, metrics improvements)
     - Alignment (0-2): alignment with team/company priorities (calls out goals, reduces technical debt, supports roadmap)
     - Effort (0-2): above-and-beyond time or cross-team work (multiple threads, long debugging sessions)
     - Collaboration/Helping (0-1): mentorship, detailed reviews, or helping other engineers ship
     - Visibility (0-1): visible to stakeholders (announcements, merged PRs, infra changes)
   - Sum into `score` (0-10) and produce a `breakdown` object with each subscore and rationale (one short sentence each).

7. Map `score` to `recommended_points`
   - Use the guidance mapping:
     - 0-3 => 0 or 1 point
     - 4-6 => 1-2 points
     - 7-8 => 3-5 points
     - 9-10 => 6-10 points
   - Prefer awarding points at the higher end of the bracket for especially visible or high-effort contributions.

8. Produce the final output
   - Favor 2-3 recommendations. For each include:
     - `name`: Full Name
     - `reason`: 1-2 sentences, include a concrete example (link or short mention) when possible
     - `tags`: comma-separated short tags
     - `recommended_points`: integer per mapping
   - Output only plain text that matches the schema (no extra commentary). Keep reasons concise.

## Scoring Rubric (use to compute `score` and `recommended_points`)

- Impact (0-4): measurable effect on product, customers, or team velocity
- Alignment (0-2): alignment with company/team values or current goals
- Effort (0-2): extra time/above-and-beyond work
- Collaboration/Helping (0-1): mentorship, pairing, or cross-team assistance
- Visibility (0-1): whether the contribution was visible to stakeholders (higher visibility can merit recognition)

Total score out of 10. Use the rubric to produce both a numeric `score` (0-10) and a short `breakdown` object explaining the subscores.

## Points Recommendation Guidance

- Map `score` to `recommended_points` using either a simple scale or the `default_points_unit`:
  - 0-3 => 0 or 1 point
  - 4-6 => 1-2 units
  - 7-8 => 3-5 units
  - 9-10 => 6-10 units

## Output

Output your results in plain text, using this format:

```
name: Full Name
reason: Concise reason for recognition (1-2 sentences)
tags: mentorship, oncall, customer-impact
recommended_points: 5
```

## Constraints & Response Rules

- Return ONLY the plain text that matches the schema above. Do not include any explanatory text.
- Keep `reason` short and specific; include one concrete example when possible.
- Keep the output list focused: prefer 2-3 recommendations.
