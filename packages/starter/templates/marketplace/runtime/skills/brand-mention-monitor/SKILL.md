---
name: brand-mention-monitor
description: Daily brand-mention monitoring loop for {{brand_terms}}. Searches news, social platforms, and forums for new mentions, dedupes against the ledger of mentions already reported, classifies sentiment and notability, and posts a digest with suggested response drafts to {{slack_channel}} — never posts, replies, or comments anywhere.
---

<skill name="brand-mention-monitor">

<overview>
Watch what's being said about the brand across the open web without turning into
either silence or an alert firehose. A daily cron re-prompts a persistent session
that searches news, social platforms, and forums for {{brand_terms}}, dedupes
each candidate against the ledger of mentions already reported, classifies
sentiment and notability, and posts one digest to {{slack_channel}} — a one-line
rollup for routine mentions, a full callout with a suggested response draft for
anything negative or notable.

Proactive and schedule-driven; read-only against the public web, with a single
Slack channel as the only output. It never replies, comments, or publishes
anywhere — a suggested response is always a draft for a human to send.
</overview>

<when-to-load>
- The daily cron fires the brand-monitor run.
- A human asks for a manual sweep of current brand mentions.
- The brand terms or watch scope need updating (a new alias, product name, or
  common misspelling starts showing up).
</when-to-load>

<workflow>

## Step 0 — Orient and resume

```sh
cat .kortix/memory/brand-monitor-log.md 2>/dev/null || echo "(no ledger yet — first run)"
```

Read every mention already reported before searching. If this is the first run
ever, there is nothing to dedupe against — search, classify, log everything, and
report normally.

## Step 1 — Load the brand terms

{{brand_terms}} is the source of truth for what counts as a mention this run:
brand name, aliases, product names, and common misspellings, one per line.
Search for exactly these terms — no more, no less.

## Step 2 — Search the web

Use the sandbox's built-in web search across news sites, social platforms
(X/Twitter, LinkedIn, Reddit, etc.), and forums (Reddit threads, Hacker News,
industry forums). Run one search per term in {{brand_terms}}, plus a
news-specific pass. No login, no connector credential — public search only.

## Step 3 — Fetch and normalize each candidate

Fetch the full text (or a substantial excerpt) of anything that looks like a
genuine mention rather than an unrelated result. Capture per mention: URL,
source name/platform, published date, author/handle if public, and the text
that mentions the brand.

## Step 4 — Dedupe against the ledger

Compute a stable fingerprint per mention (the URL, or a hash of URL plus the
first few hundred characters). Compare against
`.kortix/memory/brand-monitor-log.md`. Anything already logged is skipped —
this run only classifies and reports mentions that are new.

## Step 5 — Classify sentiment and notability

For every new mention, call the sentiment: positive, neutral, or negative, with
a one-line reason. Flag as **notable** anything that is:

- Negative in sentiment.
- High reach (large follower count, high upvotes/comments/shares).
- From an influential source (press outlet, verified or large account).
- Factually wrong about the brand in a way that could spread.

Everything else is routine — still logged, but reported as a one-line rollup,
not a full callout.

## Step 6 — Draft a suggested response for flagged mentions

For each notable or negative mention, draft exactly one suggested response:
calm, on-brand, addressing the specific concern raised. Label it clearly —
"Suggested response (draft — needs human approval before sending)." Never post
it, reply with it, or publish it anywhere. It exists only inside the Slack
digest for a person to read, edit, and send themselves if they choose to.

## Step 7 — Compose and post the digest

One message to {{slack_channel}} per run:

- A count of new mentions found and the sentiment breakdown.
- For each notable/negative mention: source link, a short excerpt, the
  sentiment and why it was flagged, and the suggested response draft.
- Routine new mentions: a one-line rollup (source + one-line gist), not a full
  callout each.
- A quiet run (no new mentions): a brief note, not a wall of "nothing found."

## Step 8 — Update the ledger

Append today's mentions to `.kortix/memory/brand-monitor-log.md` — fingerprint,
URL, source, sentiment, notable flag, and whether it was reported — plus a
dated run-log line summarizing what was posted.

</workflow>

<ledger-format>
Lives at `.kortix/memory/brand-monitor-log.md`. Per mention: fingerprint (URL or
URL+content hash), source/platform, date first seen, sentiment classification,
notable flag (y/n), and whether it was reported in the digest. Below that,
dated **Run log** entries: how many new mentions were found, the sentiment
breakdown, and which ones got a suggested response draft.
</ledger-format>

<guardrails>
- **Monitor and alert only.** The agent never replies, comments, or posts on
  any external platform — not the source of a mention, not anywhere else —
  under any circumstance.
- **Draft, not send.** A suggested response is always a labeled draft inside
  the Slack digest, for a human to review, edit, and send themselves. The
  agent never sends it on its own.
- **Read-only against the web.** Public search and fetch only — no login, no
  auth, no write of any kind to any external site.
- **One output surface.** {{slack_channel}} is the only place this agent
  writes. It has no access to internal systems and takes no action beyond
  posting the digest.
- **Brand terms are code.** Changes to the watch scope go through the brand
  terms file and a reviewed change request, not an ad hoc edit mid-run.
- **Secrets scoped.** No credential is needed for public search and fetch
  today. If a future source requires auth, that credential is encrypted in the
  secrets manager and injected at runtime — never shown to the model or
  logged.
</guardrails>

</skill>
