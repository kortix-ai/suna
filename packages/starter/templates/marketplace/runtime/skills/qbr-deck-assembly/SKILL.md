---
name: qbr-deck-assembly
description: Weekly QBR-prep runbook. Finds every account whose next QBR falls within {{lookahead_days}} days of HubSpot's {{qbr_date_property}} field, pulls usage trends from Postgres and account/CSM data from HubSpot, and assembles a draft deck plus a briefing doc under {{decks_folder}} — read-only across every source system.
---

<skill name="qbr-deck-assembly">

<overview>
Turn two read-only sources — Postgres and HubSpot — into a finished first
draft of a quarterly business review, for every account that's due one this
week. A weekly cron spawns a fresh session with no memory of prior runs; this
skill is what makes the prep consistent account over account: how to find
who's due, what each section of the deck means, how to write a support
summary that surfaces the one thing that matters instead of a ticket count,
and how to tell a credible expansion signal from a guess.

The agent never writes back to a source system — the new deck and the new
briefing doc are the only things it produces, one pair per due account.
</overview>

<when-to-load>
- The weekly cron fires the QBR-prep sweep.
- A human asks the agent to prep a specific account's QBR ahead of schedule.
- A human asks why an account was or wasn't included in this week's sweep.
</when-to-load>

<workflow>

## Step 1 — Find who's due this cycle (HubSpot, read-only)

Read `{{qbr_date_property}}` on every account in HubSpot and select those
whose date falls within `{{lookahead_days}}` days from today. For each
selected account, also pull:

- The assigned CSM (owner field) — the deck's audience and presenter.
- The account tier / ARR — to size how much detail the review warrants.
- The most recent prior QBR, if one exists, for continuity.

If an account has no `{{qbr_date_property}}` value at all, skip it and note
the gap in the run summary rather than guessing a cadence.

## Step 2 — Pull usage trends (Postgres, read-only)

For each due account, query the current quarter and the two prior quarters:

| Metric | Definition |
|---|---|
| Active usage | Core product activity (logins, key actions) per period |
| Adoption | Breadth of features/seats used vs. what's licensed |
| Trend | Direction and magnitude of change quarter over quarter |

Flag a declining trend explicitly — that's a topic the CSM needs to be ready
to address, not a number to bury in a table.

## Step 3 — Pull account health, support, and expansion signals (HubSpot, read-only)

For each due account, read:

- **Account health** — the current health score/status and its trend since
  the last QBR.
- **Support summary** — ticket volume for the quarter, the split between
  resolved and open, and the one or two threads (by severity or recurrence)
  worth calling out by name rather than folded into a count.
- **CSM notes** — anything the CSM has logged about goals, blockers, or
  sentiment since the last review.
- **Expansion signals** — usage against licensed seats/tier, product areas
  the account touches but hasn't purchased, and any open deal or expansion
  note already on the record. Only surface a signal that's backed by a
  specific data point (a seat gap, a feature touch, a stated goal) — never
  invent an upsell angle the data doesn't support.

## Step 4 — Assemble the deck (Google Slides)

Create a new deck under `{{decks_folder}}`, named for the account and the
quarter (e.g. `Acme Corp — Q2 2026 QBR`). Use this section order:

1. **Title** — account name, quarter, CSM.
2. **Usage trends** — the Step 2 numbers, with the quarter-over-quarter
   direction called out.
3. **Value delivered** — the outcomes the account has realized this quarter,
   tied to the usage and adoption data.
4. **Account health** — the health score/status and its trend, in plain
   language (improving, steady, at risk).
5. **Support summary** — the quarter's ticket picture and the one or two
   threads worth discussing by name.
6. **Expansion opportunities** — the Step 3 signals, each with the data point
   behind it.
7. **Discussion topics** — open questions or decisions for the CSM to raise
   live; leave these as prompts, not answers.

Keep every slide's numbers traceable to Step 2/3 — no figure on the deck
should be un-sourced.

## Step 5 — Write the briefing doc (Google Docs)

Create a companion doc under `{{decks_folder}}`, named to match the deck,
holding the backup detail that doesn't fit on a slide: the full support
ticket list referenced in Step 3, the raw usage numbers behind the trend
chart, the CSM notes verbatim, and the specific data point behind each
expansion signal. This is what the CSM opens if a question in the room goes
deeper than the deck.

## Step 6 — Report where each landed

At the end of the run, list every account prepped this week with the deck
name/location and the doc name/location under `{{decks_folder}}`, plus any
account skipped for missing a QBR date. Do not open, share, or present
anything — that's the CSM's job.

</workflow>

<guardrails>
- **Read-only, always.** Postgres and HubSpot are read-only connectors; the
  agent cannot change a usage record, a health score, a CSM note, or a deal,
  even if the connector would technically permit it.
- **Draft only, nothing sent.** The new deck and briefing doc under
  `{{decks_folder}}` are the only things that leave the sandbox — no shares,
  no presentations, no emails, no chat posts.
- **No memory between runs.** Each run is a fresh session. Recompute who's
  due and every figure from the current state of Postgres and HubSpot; don't
  assume last week's list or numbers still hold.
- **Every number sourced.** Nothing goes on a slide or in the briefing doc
  that can't be traced to a specific Postgres query or HubSpot field.
- **No invented expansion signals.** An expansion opportunity is only listed
  when backed by a concrete data point — a seat gap, a feature touch, a
  logged goal — never a guess dressed as insight.
- **Scoped secrets.** The Postgres and HubSpot connectors are brokered
  server-side; no raw credential is ever shown to the model or written to
  logs.
- **The CSM presents, not the agent.** The agent's job ends at a finished
  draft pair. It never shares, presents, or sends the deck or the doc to
  anyone.
</guardrails>

</skill>
