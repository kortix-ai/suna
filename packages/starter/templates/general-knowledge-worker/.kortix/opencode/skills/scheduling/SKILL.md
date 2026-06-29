---
name: scheduling
description: "Schedule recurring or one-time agent runs with Kortix triggers — cron schedules, one-off run_at reminders, and signed webhooks. Use for reminders, recurring monitoring, daily/weekly digests, scheduled posts, and event-driven runs; covers the kortix.toml [[triggers]] format, 6-field croner syntax, fresh-vs-reuse sessions, dedup for recurring runs, and notifying via Slack. Load whenever the user wants something to happen later, on a schedule, repeatedly, or in response to an external event."
defaultProjectInstall: true
---

# Scheduling

Kortix runs work on a schedule through **triggers**. A trigger is a small, durable
piece of config in the project's `kortix.toml`. When it fires, the platform spins
up a session and hands your agent a prompt — exactly as if a teammate had typed it.
There is no separate "scheduler tool" to call at runtime; you *declare* a trigger,
and the platform's sweep fires it for you.

Two trigger types cover everything:

- **`cron`** — time-based. Either a recurring schedule (`cron = "…"`) or a single
  future moment (`run_at = "…"`). This is the workhorse for reminders, digests,
  and monitoring.
- **`webhook`** — event-based. Fires on a signed `POST` from an external system
  (GitHub, a SaaS app, your own service). Use it when the *event*, not the clock,
  is the trigger.

> **Talking to people about this:** say "recurring task", "scheduled run",
> "automatic check", or "reminder". Don't say "cron job" or paste a cron string at
> a non-technical user — translate it ("every weekday at 9am").

---

## Which mechanism — decide first

| The user wants… | Use | How |
| --- | --- | --- |
| A one-time reminder or delayed action ("remind me at 4pm", "send this tomorrow 9am") | **cron trigger, one-off** | `type = "cron"` + `run_at = "<ISO-8601>"` |
| Something to repeat ("every weekday morning", "daily digest", "check hourly") | **cron trigger, recurring** | `type = "cron"` + `cron = "<6-field>"` + `timezone` |
| To react to an external event ("when a PR opens", "when our error tracker alerts") | **webhook trigger** | `type = "webhook"` + `secret_env` |
| To **pause mid-task and resume later with full context** | **No native equivalent** | See [Pausing mid-task](#pausing-mid-task-pause_and_wait) — re-fire later instead |

Don't reach for a trigger when the work finishes in this turn, or when you just
need to ask the user something — answer or ask directly. Triggers are for work
that must outlive the current conversation.

---

## How a trigger is declared

Triggers live in `kortix.toml` at the repo root, as `[[triggers]]` array-of-tables
entries. That file is the single source of truth — the dashboard, the CLI, and the
platform sweep all read the same entries.

```toml
# Recurring: a weekday-morning digest
[[triggers]]
slug     = "support-digest"          # lowercase, URL-safe, unique among triggers
name     = "Overnight support digest"
type     = "cron"
agent    = "default"                 # which agent the spawned session runs
enabled  = true
cron     = "0 0 8 * * 1-5"           # 08:00 Mon–Fri (see cron syntax below)
timezone = "America/Los_Angeles"
prompt   = """
Summarize support tickets opened since {{ cron.last_fired_at }}. Group by theme,
flag anything urgent, and post the summary to the #support Slack channel.
"""

# One-off: a reminder that fires once, then goes dormant
[[triggers]]
slug    = "contract-review-reminder"
name    = "Review the Acme contract"
type    = "cron"
agent   = "default"
enabled = true
run_at  = "2026-07-01T16:00:00-07:00"   # fires once at/after this instant
prompt  = "Remind the user to review the Acme contract redlines before the 5pm call."

# Event-based: fire when an external system POSTs to us
[[triggers]]
slug       = "github-releases"
name       = "New release handler"
type       = "webhook"
agent      = "default"
enabled    = true
secret_env = "WEBHOOK_GITHUB_SECRET"     # name of a Secret holding the HMAC key
prompt     = """
A '{{ headers.user_agent }}' event arrived.
Release: {{ body.release.tag_name }} — {{ body.release.name }}.
Draft release notes and open a CR.
"""
```

### Required vs optional fields

| Field | Required | Notes |
| --- | --- | --- |
| `slug` | yes | `[a-z0-9][a-z0-9_-]{0,127}`, unique among triggers. |
| `type` | yes | `"cron"` or `"webhook"`. |
| `prompt` | yes | The initial message the session receives. Mustache-style template. |
| `name` | no | Human label (defaults to `slug`). |
| `agent` | no | Agent the session runs as (defaults to `"default"`). |
| `enabled` | no | Defaults to `true`. Set `false` to keep a trigger dormant. |
| `cron` | cron only | 6-field croner expression. **One** of `cron` / `run_at`. |
| `run_at` | cron only | ISO-8601 instant for a single fire. Alternative to `cron`. |
| `timezone` | no | IANA name (`"America/Los_Angeles"`). Defaults to `"UTC"`. |
| `secret_env` | webhook only | Name of a Secret holding the HMAC signing key. |
| `session_mode` | no | `"fresh"` (default) or `"reuse"` — see [Fresh vs reuse](#fresh-vs-reuse-sessions). |

### Prompt template variables

The `prompt` is rendered with `{{ token }}` substitution on every fire. Missing
values render empty (no error). Always available: `{{ fired_at }}`,
`{{ trigger.slug }}`, `{{ trigger.type }}`. Cron fires also get
`{{ cron.schedule }}`, `{{ cron.timezone }}`, `{{ cron.last_fired_at }}` (and the
alias `{{ last_fired_at }}`) — use `last_fired_at` to scope "what changed since
the previous run." Webhook fires also get `{{ body.* }}` (the parsed JSON body,
dotted access) and `{{ headers.* }}` (`content_type`, `user_agent`,
`forwarded_for`).

### Three ways to create one

1. **Dashboard** — easiest for the user; the UI writes the `[[triggers]]` entry
   for them.
2. **Edit `kortix.toml` from a session** — add the `[[triggers]]` entry, commit,
   and open a change request (`kortix cr open …`). The trigger goes live once the
   CR merges to the default branch (the sweep reads config from there).
3. **Have the user add it in the dashboard** when you can't merge config yourself.

The `kortix` CLI **manages** existing triggers but does not create them:

```sh
kortix triggers ls                 # list triggers + last_fired_at / status
kortix triggers info <slug>        # full config for one
kortix triggers fire <slug>        # fire once now (great for testing)
kortix triggers enable <slug>      # set enabled = true
kortix triggers disable <slug>     # set enabled = false
```

After adding a recurring trigger, `kortix triggers fire <slug>` once to confirm
the prompt and the agent behave before you rely on the schedule.

---

## Cron syntax — 6 fields (with seconds)

Kortix uses **croner**, which is **6-field**: `second minute hour day-of-month
month day-of-week`. (A 5-field expression also works — seconds default to `0`.)
Day-of-week is `0`/`7` = Sunday … `1` = Monday; names like `MON-FRI` are accepted.

```
┌───────────── second        (0–59)
│ ┌─────────── minute        (0–59)
│ │ ┌───────── hour          (0–23)
│ │ │ ┌─────── day of month  (1–31)
│ │ │ │ ┌───── month         (1–12 or JAN–DEC)
│ │ │ │ │ ┌─── day of week   (0–7, 0/7=Sun, or SUN–SAT)
│ │ │ │ │ │
0 0 9 * * 1-5
```

| Expression | Fires |
| --- | --- |
| `0 */15 * * * *` | every 15 minutes |
| `0 0 * * * *` | every hour, on the hour |
| `0 0 9 * * *` | every day at 09:00 |
| `0 30 8 * * 1-5` | 08:30 every weekday (Mon–Fri) |
| `0 0 9 * * 1` | every Monday at 09:00 |
| `0 0 9 1 * *` | 09:00 on the 1st of each month |
| `0 0 9 * * 1#1` | 09:00 on the **first Monday** of the month |
| `0 0 17 L * *` | 17:00 on the **last day** of the month |
| `0 0 0 1 1 *` | midnight, Jan 1 (yearly) |

Croner also accepts the nicknames `@hourly @daily @weekly @monthly @yearly`.

### Cron gotchas (read these)

- **Day-of-month + day-of-week is OR, not AND.** If you restrict *both*, croner
  fires when **either** matches. So `0 0 12 1-7 * 1` does **not** mean "first
  Monday" — it means "every day 1–7 *or* every Monday." For nth-weekday use the
  `#` form (`1#1` = first Monday, `3#2` = second Wednesday) or `L` for last-of-month;
  for anything fancier, schedule the broad slot and add a guard in the prompt
  ("…only proceed if today is in the first 7 days of the month").
- **One cron expression per trigger.** You can't comma-join two full schedules in
  one `cron`. For disjoint schedules, declare **multiple** `[[triggers]]` entries.
- **No exact-minute wall-clock gates.** The sweep polls ~every 60s and a fire can
  land a few minutes after the scheduled instant. Never write a prompt that does
  `if current_time == "09:00"` — it will silently skip. Compare against a tolerance
  window or against `{{ fired_at }}` / `{{ cron.last_fired_at }}` instead.
- **Set `timezone` for human schedules.** "9am" means a wall-clock time; pin it to
  the user's IANA zone so DST shifts don't drift it. Default is UTC.

---

## Fresh vs reuse sessions

Every cron fire spawns work, but you choose whether it's a clean slate or a
continuing thread via `session_mode`:

- **`fresh`** (default) — each fire creates a **new session** with no prior
  conversation history. Fast and isolated. Best for monitoring, digests, scheduled
  posts, and data collection — anything that should start clean and judge "what's
  new" from the data, not from chat memory.
- **`reuse`** — each fire **re-prompts the same long-lived session**, resuming its
  sandbox and accumulating context across fires. Use when later runs genuinely need
  what earlier runs saw ("keep refining the same draft each morning"). Costs more
  context and ties runs to one session's lifecycle — don't reach for it by default.

Two practical consequences of a `fresh` run:

- It has **no memory of your chat.** If a reminder must reference "what we just
  discussed," either put that context directly into the `prompt`, or use `reuse`.
- It runs as project automation, not your live chat. Drive everything it needs
  from the `prompt` plus the project's connectors and secrets.

---

## Notifying the user

A scheduled run is headless — nobody is watching the session. To reach the user,
the run has to **push** a message out, almost always through Slack
(see the **kortix-slack** skill).

```sh
# inside a scheduled run that found something worth reporting
slack send --channel "#growth" --text "Daily digest: 47 new signups overnight, 3 from target accounts."
```

You can also notify through any connected channel via the Executor (email, etc.) —
discover the tool (`kortix executor discover "send email"`) and call it.

**When to notify:**

- The run found something genuinely **new or actionable** since last time (a price
  crossed a threshold, a new release shipped, an inbox got a reply that matters).

**When to stay silent:**

- Nothing changed since the last run — end the run quietly, no message. A digest
  that pings "nothing new" every morning trains the user to ignore it.
- The update is trivial or redundant with the previous notification.

Lean on `{{ cron.last_fired_at }}` to compute the delta and decide whether there's
anything worth sending.

---

## Idempotency & dedup for recurring runs

The platform dedups **fires**: each cron slot fires once (a fire that times out but
later lands isn't double-spawned). What it does *not* do is dedup your **work** —
two consecutive runs can easily re-discover and re-report the same item.

Make recurring runs idempotent yourself:

- **Scope by time.** Only look at data newer than `{{ cron.last_fired_at }}`
  (first run: fall back to a sensible window, e.g. last 24h).
- **Track what you've already acted on.** Persist a small state file in the repo
  or workspace (e.g. last-seen IDs / a high-water mark) and skip anything already
  handled. Read it at the start of each run, update it at the end.
- **Make actions safe to repeat.** Prefer "upsert this row / edit this doc" over
  "append a new row" so a double-run doesn't duplicate output.

---

## Pausing mid-task (`pause_and_wait`)

There is **no native "sleep then resume this exact turn with full conversation
context" primitive** in Kortix. A session turn either completes or it doesn't —
you can't suspend an in-flight turn for hours and wake it where it left off.

When you'd reach for a mid-task wait (rate-limit cooldown, waiting on an approval or
an email reply, an API cooldown), do this instead:

1. **End the current turn** at the natural breakpoint, leaving a clear note of
   what's done and what's pending.
2. **Schedule a re-fire** for when the wait is over — a one-off `run_at` cron
   trigger (or a recurring one if you need to poll). Put everything the resumed run
   needs into its `prompt`.
3. To carry context across the gap, set **`session_mode = "reuse"`** so the re-fire
   resumes the *same* session and its accumulated state — the closest equivalent to
   "continue where I left off."

```toml
# "Check back in an hour after the rate limit resets"
[[triggers]]
slug         = "resume-export"
name         = "Resume the data export"
type         = "cron"
agent        = "default"
enabled      = true
run_at       = "2026-07-01T15:00:00Z"
session_mode = "reuse"
prompt       = "Rate-limit window has reset — resume the export from record 1,001 and continue to the end."
```

For very short waits *within* a single turn (seconds to a couple of minutes), a
plain `sleep` in the run is fine. Anything longer must become a re-fire — don't try
to block a turn for hours.

---

## Stopping & managing triggers

There is **no "paused" state for a single trigger** — only `enabled` on/off, or
removal. Acknowledging "okay, I stopped it" without actually changing config means
it keeps firing (and keeps costing runs).

- **Stop temporarily:** `kortix triggers disable <slug>` (sets `enabled = false`).
- **Stop permanently:** remove the `[[triggers]]` entry from `kortix.toml` and
  land the change (CR). One-off `run_at` triggers don't auto-remove after firing —
  they just go dormant; delete the entry to tidy up.
- **Stop *all* of a project's triggers at once:** the project has a server-side
  kill-switch (`triggers_paused`) that makes the sweep skip every trigger and
  ignore inbound webhooks, regardless of each trigger's own `enabled`. Toggle it
  from the dashboard. This is the right tool when the same repo is deployed to two
  environments and you only want one of them firing.
- **A trigger that vanished** that you didn't remove was almost certainly deleted
  by the user in the dashboard — don't recreate it unless they ask.
- **A trigger that keeps failing** (auth expired, missing permission you can't fix)
  should be disabled, not left to burn runs every fire while blocked.

---

## Worked examples

**"Remind me at 4pm to review the contract."**
→ One-off cron. Convert 4pm in the user's timezone to an ISO-8601 instant; create a
`type = "cron"` trigger with `run_at` and a `prompt` that states the reminder and
posts it to the user's channel. It fires once, then sits dormant.

**"Every weekday at 8am, give me a digest of overnight support tickets in Slack."**
→ Recurring cron, `cron = "0 0 8 * * 1-5"`, `timezone` = the user's zone,
`session_mode = "fresh"`. Prompt: pull tickets opened since
`{{ cron.last_fired_at }}`, summarize, `slack send` to #support. Stay silent on a
zero-ticket night.

**"Watch our GitHub repo and draft release notes whenever we ship."**
→ Webhook trigger with `secret_env = "WEBHOOK_GITHUB_SECRET"`; point GitHub's
webhook at `POST /v1/webhooks/projects/<project_id>/<slug>` (GitHub's
`X-Hub-Signature-256` is accepted natively). Prompt reads `{{ body.release.* }}`,
drafts notes, opens a CR.

**"Check competitor pricing daily and only ping me when it changes."**
→ Recurring cron at the user's preferred hour. Persist last-seen prices in a state
file; each run compares, updates the file, and only `slack send`s on a real change.
This is the [idempotency](#idempotency--dedup-for-recurring-runs) pattern in action.

**"Process 50k records, but the API rate-limits me."**
→ Not a mid-turn pause. Process a batch, then schedule a `run_at` re-fire (with
`session_mode = "reuse"`) for after the cooldown, prompting the next run to resume
from where this one stopped. See [Pausing mid-task](#pausing-mid-task-pause_and_wait).

---

## Quick checklist

- [ ] Right mechanism? One-off `run_at` vs recurring `cron` vs `webhook`.
- [ ] 6-field cron, correct `timezone`, no DOM+DOW "first-Monday" trap, no
      exact-minute gate.
- [ ] `fresh` vs `reuse` chosen deliberately; `prompt` carries all needed context.
- [ ] Recurring run is idempotent (scoped by `last_fired_at`, tracks what it acted on).
- [ ] Notifies only on genuinely new/actionable findings; silent otherwise.
- [ ] Tested once with `kortix triggers fire <slug>` before trusting the schedule.
- [ ] User knows how it's stopped (disable / remove) — no phantom "paused" state.

## Related skills

- **kortix-slack** — how a scheduled run reaches the user (the only eyes on a
  headless fire).
- **kortix-system** (`references/kortix/kortix-toml.md`, `kortix-cli.md`) — full
  manifest + CLI reference behind everything above.
