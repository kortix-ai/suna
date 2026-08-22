---
name: social-post-drafting
description: Daily fresh-session workflow that reads the Notion content calendar for content, launches, and announcements landing within the lookahead window, drafts platform-appropriate social posts for each one, and holds the batch with the scheduled date in the Slack approval channel. Never posts to any social account.
---

<skill name="social-post-drafting">

<overview>
Turn a Notion content calendar entry into copy that's actually ready to post,
before the scheduled date arrives instead of on it. A daily cron spawns a
fresh session with read access to `{{calendar_source}}`; this skill reads
what's coming up, drafts a platform-appropriate post per entry per platform,
and posts the whole batch to `{{approval_channel}}` for a human to review,
edit, and publish. The agent has no connector to any social platform — it
cannot publish even if asked to.
</overview>

<when-to-load>
- The daily cron fires the social-scheduler run.
- A human asks for drafts for a specific launch, announcement, or calendar
  entry ahead of schedule.
</when-to-load>

<workflow>

## Step 1 — Pull upcoming calendar entries (read-only)

Query `{{calendar_source}}` for entries whose scheduled date falls within
`{{lookahead_days}}` days of today. For each entry, pull:

- Title, description/brief, and content type (blog post, launch, product
  update, announcement, event).
- Scheduled date and any linked asset (the published post, a landing page, a
  changelog entry).
- The `Kortix Drafted` property.

## Step 2 — Skip what's already drafted

Filter out any entry where `Kortix Drafted` is already checked. This is the
dedup mechanism for a fresh session with no local memory — the calendar
itself is the source of truth for what's been handled.

## Step 3 — Draft platform-appropriate copy per entry

For each remaining entry, write one draft per platform in `{{platforms}}`,
following each platform's shape:

| Platform | Length & structure | Tone |
|---|---|---|
| LinkedIn | 3–6 short paragraphs; can explain the "why," not just the "what"; ends with a light call to action | Explanatory, first-person-plural, low hype |
| X | One tight post, single idea, under ~280 characters, or a short 2–4 post thread for launches with real substance | Direct, no throat-clearing, one hook |
| Instagram | Short caption (2–4 sentences) plus 3–5 relevant hashtags; assumes a visual carries the rest | Casual, visual-forward |

Ground every draft in the entry's actual brief — don't invent details, stats,
or claims the calendar entry doesn't support. If an entry is too thin to draft
well (no brief, no description), skip it and note why in Step 5's post rather
than guessing.

## Step 4 — Attach the scheduled date and platform tag

Label each draft with the calendar entry's title, its scheduled date, and
which platform it's for, so the reviewer can scan the batch and see what's
most urgent.

## Step 5 — Post the batch to the approval channel

Post one message (or a short thread of messages) to `{{approval_channel}}`
containing every draft from this run, grouped by calendar entry. If an entry
was skipped for lack of context, list it separately with the reason. Post
exactly once per run — this is a fresh session, so there is nothing from a
prior run to update or merge with.

## Step 6 — Mark each drafted entry in Notion

For every calendar entry you drafted for (not the skipped ones), set
`Kortix Drafted` to true on that entry so tomorrow's fresh run doesn't
draft it again.

</workflow>

<guardrails>
- **No path to publish.** The agent has no connector or credential for any
  social platform. This is a scope limit, not a rule the agent has to
  remember — publishing is not something this agent is capable of doing.
- **Draft only, one output.** The Slack post to `{{approval_channel}}` is the
  only thing that leaves the sandbox. No post is scheduled, queued, or sent
  anywhere else.
- **Read-mostly on Notion.** The only write back to Notion is the
  `Kortix Drafted` checkbox used for dedup — never edit the calendar entry's
  content, date, or any other field.
- **No memory between runs.** Each run is a fresh session; the `Kortix
  Drafted` property on the calendar entry (not local memory) is what prevents
  duplicate drafts.
- **Ground drafts in real content.** Never fabricate details, numbers, or
  claims beyond what the calendar entry's brief supports.
- **People decide, not the agent.** A human reviews, edits, and publishes
  every draft through whatever tool the team already uses.
</guardrails>

</skill>
