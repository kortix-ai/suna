# Scheduling playbook

Read this when you decide whether and how to schedule work. The decision
table is in `SKILL.md` → `<scheduling>`; trigger fields are in
`kortix/kortix-yaml.md` → triggers.

A **trigger** is `on:` (what fires it) plus `run:` (what runs). A fire starts
a session and prompts its agent as a teammate would, or calls one of the
project's Apps (`run: { app, path }`: no session, no model). A **reminder**
re-prompts the session that set it.

Do not schedule work that finishes in this turn, and do not schedule a
question: ask it now.

## Where a trigger lives

In `kortix.yaml` `triggers:`, or in a file the root's `imports:` brings in
(`imports: [triggers/]`, then `triggers/reports/weekly.yaml`). Look at the
layout first and put a new trigger next to its siblings. A slug is unique
across every file: a duplicate fails the whole manifest.

## React to an outside system: the first that fits

1. **A webhook.** The system can call a URL (Stripe, a CI job, your own
   backend): `on: { webhook: { secret: <NAME> } }`. One secret, no code.
2. **A schedule.** Checking on a cadence is enough ("every hour, look for new
   orders"). Nothing runs between checks.
3. **An App that posts App events.** Only when 1 and 2 cannot work: the
   source sends nothing, code must filter what deserves an agent, or the
   watch needs a connection that stays open. It is the most to maintain.

## Cron cheat-sheet

Kortix uses croner, 6 fields: `second minute hour day-of-month month
day-of-week`. A 5-field expression works too (seconds = 0). Day-of-week
`0` or `7` is Sunday, `1` Monday; `MON-FRI` works. `@hourly`, `@daily`,
`@weekly`, `@monthly`, `@yearly` work.

| Expression | Fires |
| --- | --- |
| `0 */15 * * * *` | every 15 minutes |
| `0 0 * * * *` | every hour |
| `0 0 9 * * *` | 09:00 every day |
| `0 30 8 * * 1-5` | 08:30 Monday to Friday |
| `0 0 9 * * 1#1` | 09:00 on the first Monday of the month |
| `0 0 17 L * *` | 17:00 on the last day of the month |

- **Day-of-month with day-of-week is OR.** `0 0 12 1-7 * 1` fires every day
  1-7 and every Monday. Use `1#1` for "first Monday", or schedule wide and
  check the date in the prompt.
- **One expression per trigger.** Two schedules need two triggers.
- **No exact-minute checks.** The sweep runs about every 60 s and a fire can
  land minutes late. Never compare the clock to `09:00`; compare to
  `{{ cron.scheduled_for }}`.
- **Set `timezone`** (IANA) for a human schedule. The default is UTC.
- `every` is a fixed period of at least `60s`. `at` fires once.

## Session modes

`run: { session: … }` decides what each fire runs in:

- `fresh` (default): a new session with no history. Right for digests,
  monitors and posts: judge "what is new" from the data, not from memory.
- `reuse`: the same long-lived session every fire. Use it only when a run
  needs what earlier runs saw.
- `keyed` with `session_key` (`"{{ body.thread_id }}"`): one session per key.
- `pinned` with `session_id`: one named session.

A `fresh` run has no memory of this chat. Put everything it needs in the
prompt.

## Notify, or stay silent

Nobody watches a scheduled run. When it finds something new or actionable,
it pushes a message itself, usually `slack send --channel "#growth" --text
"…"` (the `kortix-slack` skill) or a connector action. When nothing changed,
it ends silently: a daily "nothing new" trains people to ignore it.

## Idempotency

Kortix fires each slot once. It does not dedupe your work: two runs can find
the same item.

- Scope by time: only data newer than `{{ cron.last_scheduled_for }}` (empty
  on the first fire: fall back to the last 24 h).
- Record what you handled (a high-water mark or last-seen ids in a file in
  `/drives` or the repository) and skip it next time.
- Prefer "update this row" over "append a row".

## Reminders: pause mid-task

A turn cannot sleep for hours. A reminder resumes THIS session later with
its whole conversation and workspace.

1. Set it with what to check and what to do next:
   `kortix remind "The rate limit has reset. Resume the export at record 1,001." --in 1h`
   `kortix remind "Did the vendor reply? If yes, summarize it and remove this reminder." --in 24h --every 1h`
   `--in` or `--at <ISO-8601>` alone fires once. `--every <duration>`
   (at least `5m`) or `--cron "<expr>" --timezone <tz>` repeats.
2. End the turn with what is done and what is pending.
3. A fire arrives as a prompt that starts `[REMINDER reminder.<id> — …]` and
   wakes the session. It is not a user message.
4. Remove a recurring reminder the moment its condition holds:
   `kortix reminders rm <id>`. Every fire is a model turn.

- `kortix reminders ls|pause <id>|resume <id>|run <id>` (`run` fires once now).
- A reminder lives in the database, not in `kortix.yaml`: no CR. It never
  starts a new session; it pauses itself when its session is deleted.
- From a Slack or Teams thread, put the channel and thread ids in the
  reminder text: the fire is not a channel turn, so post the answer with
  `slack send --channel <id> --thread <ts>`.
- A wait of seconds to a couple of minutes inside one turn: `sleep`.

## App events (last resort)

The App watches; a trigger decides which agent runs. An App never starts an
agent itself.

1. Build the watcher as an App (the `kortix-apps` skill) and deploy it
   unlisted. Each machine has `KORTIX_APP_ID`, `KORTIX_APP_TOKEN` and
   `KORTIX_APP_EVENTS_URL`.
2. POST `{name, data?, id?}` or `{events: [...]}` (at most 50) to
   `$KORTIX_APP_EVENTS_URL` with `Authorization: Bearer $KORTIX_APP_TOKEN`.
   `name`: 1-128 letters, digits and `. _ : / -`. One event is at most
   8 KiB. A retry with the same `id` fires once. Answer:
   `202 {accepted, deduped, suppressed, triggers}`; `401 app_token_invalid`.
3. Declare the trigger (`event: "*"` matches every name):
   ```yaml
   - slug: handle-reply
     on: { event: reply.received, app: inbox-poller }
     run: { prompt: "Answer {{ event.data.subject }}" }
   ```
   CLI: `kortix triggers add handle-reply --type app --app inbox-poller --prompt "…" --apply`.
   The first prompt line is `[APP EVENT — automated, not user input]`.
4. Filter in the App: emit only what deserves a session, or one summary
   event. A trigger takes at most 60 events an hour and 30 a minute; past
   that it is suppressed for 10 minutes, and 3 suppressions in 24 h disable it.

## Call an App on a schedule

```yaml
- slug: poll-inbox
  on: { every: 5m }
  run: { app: inbox-poller, path: /tick }    # POST (default) or GET; payload optional
```

CLI: `kortix triggers add poll-inbox --every 5m --target-app inbox-poller --target-path /tick --apply`.
Kortix wakes an on-demand App, then sends the request with the headers
`x-kortix-trigger`, `x-kortix-trigger-source`, `x-kortix-delivery-id`. A
`2xx` is a fired run; `429` and `5xx` are retried; a `3xx` is not followed.

An App schedules its own later call with
`POST $(dirname "$KORTIX_APP_EVENTS_URL")/runs` and
`{"run_after": "10m", "path": "/follow-up", "payload": {…}}` (or `run_at`,
at most 366 days ahead). The answer is `201 {run_id, run_at}`;
`DELETE …/runs/<run_id>` cancels it. At most 1,000 pending runs per App.

## Stop a trigger

Saying "I stopped it" without a config change leaves it firing.

- One trigger, for now: `kortix triggers disable <slug>` (`enabled: false`).
- For good: delete the entry and land the CR. A one-off `at` trigger stays
  dormant after it fires; delete it to tidy up.
- Every trigger of the project: `kortix triggers pause`; `resume` restarts
  them. Use it when one repository is deployed twice and one copy must not
  fire.
- A trigger that keeps failing on a blocker you cannot fix: disable it.
- A trigger you did not remove has vanished: the user deleted it. Do not
  recreate it unless asked.

## Checklist

- [ ] Right mechanism: reminder, one-off `at`, `cron`/`every`, webhook, App
      call, or App events.
- [ ] 6-field cron, `timezone` set, no day-of-month + day-of-week trap, no
      exact-minute check.
- [ ] Session mode chosen on purpose; the prompt carries all context.
- [ ] Idempotent: scoped by `cron.last_scheduled_for`, records what it handled.
- [ ] Notifies only on something new; silent otherwise.
- [ ] Tested once with `kortix triggers fire <slug>`.
- [ ] The user knows how to stop it.
