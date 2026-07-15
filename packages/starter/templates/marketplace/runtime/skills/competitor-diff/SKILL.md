---
name: competitor-diff
description: Daily competitor-watch loop for {{watch_list}}. Fetches each tracked page, diffs it against the last run's stored snapshot, filters cosmetic edits from meaningful ones, and posts a short summary to {{slack_channel}} — or nothing on a quiet day.
---

<skill name="competitor-diff">

<overview>
Watch competitor sites, changelogs, and pricing pages without turning into an
alert firehose. A daily cron re-prompts a persistent session that fetches each
page on the watch list, diffs it against the stored snapshot from the previous
run, filters out cosmetic noise, and posts a short summary of what actually
changed to {{slack_channel}}. On a day nothing moved, the channel stays quiet.

Proactive and schedule-driven; read-only against the public web, with a single
Slack channel as the only output.
</overview>

<when-to-load>
- The daily cron fires the competitor-watch run.
- A human asks for a manual check of the watch list.
- The watch list itself needs updating (a competitor added, dropped, or a
  tracked page's URL changed).
</when-to-load>

<workflow>

## Step 0 — Orient and resume

```sh
cat .kortix/memory/competitor-watch-log.md 2>/dev/null || echo "(no ledger yet — first run)"
```

Read the last snapshot recorded for each tracked page. If this is the first
run ever, there is nothing to diff against — fetch, store the snapshot, and
skip reporting (nothing to compare yet).

## Step 1 — Load the watch list

The watch list lives in {{watch_list}} (competitor name → URL, one per line,
e.g. `Acme — pricing: https://acme.com/pricing`). Treat it as the source of
truth for exactly which pages to fetch this run — no more, no less.

## Step 2 — Fetch each tracked page

Fetch every URL in the watch list over plain HTTP(S) GET. No auth, no
credentials — these are public pages.

```sh
curl -sL --max-time 20 "$URL"
```

If a fetch fails (timeout, 404, page moved), note it in the ledger as a
blocker for next run rather than failing the whole sweep.

## Step 3 — Normalize before comparing

Strip what varies without meaning anything: nav, footer, ads, timestamps,
session-specific query params, whitespace. Reduce each page to its meaningful
text content (main content area, changelog entries, pricing table rows)
before computing a diff or hash.

## Step 4 — Diff against the last snapshot

Compare the normalized content to the snapshot stored in
`.kortix/memory/competitor-watch-log.md` for that URL. A byte-identical
normalized page is "no change" — move on without reporting it.

## Step 5 — Filter cosmetic from meaningful

Not every text diff is worth a Slack message. Report:

- A pricing tier, price point, or plan name that changed.
- A new changelog entry or shipped feature.
- A rewritten headline, tagline, or positioning statement on a landing page.

Drop:

- Typo fixes, formatting, reflowed layout with the same words.
- Date/time stamps, view counts, or other page furniture.
- Reordering of existing content with no wording change.

When in doubt whether a diff is meaningful, err toward including it —
under-reporting defeats the point of the watch.

## Step 6 — Compose and post the summary

One message to {{slack_channel}} per run:

- Something changed: a short bullet per meaningful change — competitor, what
  changed, and the page it happened on. Keep it scannable, not a raw diff
  dump.
- Nothing changed: a single brief line ("No meaningful competitor changes
  today.") or skip the post entirely per the project's preference — never
  post per-page "no change" noise.

## Step 7 — Update the ledger

Update `.kortix/memory/competitor-watch-log.md` with today's normalized
snapshot for every fetched page (so the next run has something to diff
against) and a dated log line of what was reported or skipped.

</workflow>

<ledger-format>
Lives at `.kortix/memory/competitor-watch-log.md`. Every run updates, per
tracked URL: the competitor name, the URL, the normalized snapshot (or a hash
of it) from this run, and the timestamp it was fetched. Below that, dated
**Run log** entries with what was reported to {{slack_channel}} (or "quiet —
no meaningful changes") and any fetch failures to retry next time.
</ledger-format>

<guardrails>
- **Read-only against the web.** GET requests to public pages only — no
  login, no credentials, no write of any kind to any external site.
- **One output surface.** {{slack_channel}} is the only place this agent
  writes. It has no access to internal systems and takes no action beyond
  posting the summary.
- **No noise.** Cosmetic edits are filtered before they ever reach a human;
  only pricing, feature, and messaging changes are worth a message.
- **Watch list is code.** Changes to which competitors/pages are tracked go
  through the watch-list file and a reviewed change request, not an ad hoc
  edit mid-run.
- **Secrets scoped.** If a future watch-list page needs auth, that credential
  is encrypted in the secrets manager and injected at runtime — never shown
  to the model or logged. (None are needed today.)
</guardrails>

</skill>
