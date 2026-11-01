# Scheduling playbook

Read this when you decide whether and how to schedule work, every time you
start something whose result comes later, and before a long job. The decision tables are in
`SKILL.md` → `<scheduling>`; trigger fields are in `kortix/kortix-yaml.md`
→ triggers.

## Follow-through

**The rule.** After any action whose result arrives later, set up your own
wake-up before you end the turn, without being asked: an email or message
sent and a reply expected, an order, form or application submitted, a CR
opened, a deploy or a job started, a question put to a person, a page, a
vendor or a status to watch. A turn that ends on "I'll let you know" with no
wake-up is a promise nobody keeps: the session sleeps until someone types.

1. **Pick the signal.** An event that wakes this session, when one exists:
   - a CR: `kortix triggers add "<text>" --on cr-merged --cr <id>`;
   - a new email or message, when that app is connected and the project has
     the flag `event_triggers` on: `kortix triggers events --connector
     <slug>` lists the event types, then `kortix triggers add "<text>" --on
     event --connector <slug> --event <TYPE>`. It fires on every new item,
     not only the reply you wait for: the woken turn checks the sender and
     ends silently on anything else;
   - a system that can call a URL (CI, a payment provider, your own job):
     `kortix triggers add "<text>" --on webhook --secret-env <NAME>` prints
     the URL to give it;
   - a source that sends nothing and must be watched around the clock: an App
     that posts App events ("Watch 24/7" below), then `--on app --app <slug>`.
2. **Add a fallback loop** whenever the event might not come: a reply may
   never arrive, a webhook may never be called. With no event, the loop is
   the signal.
3. **Pace it to the wait**, and give it an end date: 14 days unless the
   person names one.

   | Waiting on | First check | Then |
   | --- | --- | --- |
   | A reply from a person or a company | 2–4 h, in their working hours | 2–4 times a day: `--cron "0 0 10,14,17 * * 1-5" --timezone <their IANA zone>` |
   | A deploy, a CI run, a build | 10 min | every 10–30 min (`--every 15m`) |
   | A slow vendor, an approval, a delivery | 1 day | daily |
   | A page or a status | its own rhythm | an App when it must be minutes, a daily loop when not |

4. **Write the loop text for the turn that wakes.** That turn has the whole
   conversation, but the text is what it acts on. Name what was sent, to
   whom, when, where the record is, what to check, what to do for each
   outcome, and when to stop:

   > Check replies to `<what>` sent `<date>` to `<who>` (record:
   > `<file>`). For each new reply: `<action>`. No reply after `<n>` days:
   > `<chase once | tell the person>`. Stop and remove this loop when
   > `<condition>` or on `<end date>`.

5. **Tell the person in one plain line**, with no command in it: "I'll check
   for replies every 3 hours until 14 Nov, or until all 12 answer." From a
   Slack or Teams thread, put the channel and thread ids in the loop text.
6. **On each fire:** check, act, record the outcome in the record file.
   Report only what changed: a project agent ends silently on an empty
   check; My Kortix and a person's direct session say one short line. After
   3 empty checks in a row, replace the loop with a slower one
   (`kortix loops rm <id>`, then `kortix loop` with the same text and the next
   cadence). The moment the condition holds or the end date passes, remove
   every loop and session trigger you set for it (`kortix loops rm <id>`,
   `kortix triggers rm <id>`, and the watcher App's schedule), then say what
   came of it. A recurring loop left running after the work is done is a bug.

**Set no wake-up** for work that finishes in this turn, for a hand-off, a
teammate or a workflow (each reports back to you by itself), for a question
to the person in this chat (ask it now, then end the turn), or for anything
the person said not to track.

**Loops off.** `kortix loop` answers `403 feature_disabled`: tell the person
Loops are off and that a project admin turns them on (`kortix projects
features enable reminders`). Meanwhile, a one-off `at` trigger starts a fresh
session at the time; put the full context in its prompt.

### Worked example: quote requests to 12 printers

The person asks for quotes from 12 sticker printers. You email each one with
the Gmail connector and write the record `out/printers.md`: one row per
printer with name, address, sent at, status `waiting`. Then, before the
turn ends:

```bash
kortix triggers events --connector gmail      # flag event_triggers on? pick the new-email type
kortix triggers add "A new email arrived. If it is from a printer in out/printers.md, \
record its quote there and summarize it for the person. Otherwise end silently." \
  --on event --connector gmail --event <TYPE>
kortix loop "Check replies to the quote requests sent 2026-10-31 to 12 sticker printers \
(record: out/printers.md). Record each new quote and summarize new replies for the person. \
Chase each printer still silent after 2 days once. Stop: remove this loop and the email \
trigger when all 12 replied or on 2026-11-14, then send the comparison." \
  --cron "0 0 10,14,17 * * 1-5" --timezone Europe/Berlin
```

Your reply ends: "Sent 12 quote requests. I'll check for replies three times
a working day until 14 Nov, or until all 12 answer." On 2026-11-05 three
checks in a row found nothing new: replace the loop with a daily one
(`--cron "0 0 10 * * 1-5"`). On the day the twelfth reply lands, remove both
(`kortix triggers ls` shows their ids) and send the comparison table.

## Long jobs: plan, delegate, set wake-ups, keep state, close out

A job of many parts or many days outlives one turn and one context window:
the session compacts, and a woken turn starts from a summary. Run every such
job the same way.

1. **Plan.** Split the goal into parts that can run at once and parts that
   wait on the outside world. Write the plan into the status file (step 4).
2. **Delegate.** One named background agent per part (`agent` with `name`;
   a follow-up goes to the same name), a `workflow` for many parallel agents,
   a team only when they must share a task list. A hand-off, a teammate and
   a workflow report back by themselves: set no loop for them.
3. **Set wake-ups.** For every wait on the outside world: an event that wakes
   this session when one exists, plus a fallback loop with an end date
   ("Follow-through" above).
4. **Keep the state outside the context.** A woken turn reads it first:
   - the loop text: what is pending, the next step, the stop rule;
   - `out/status.md` in `/workspace` (kept for the life of the session; in
     `/drives` when it must outlive it):
     ```markdown
     # Status: <job> (updated <ISO time>)
     Goal: <outcome>. Stop: <condition> or on <end date>.
     Done: <parts, with links>
     Pending: <part> (waiting on <who or what>, wake-up <id>, next check <time>)
     Next step: <one action>
     Open questions for the person: <list or none>
     ```
   - an outcome over days that needs an independent check that it is done:
     a Goal (the `kortix-goals` skill). It owns the heartbeat loop, the
     questions and the verification; do not add loops beside it.

   On every wake: read the state, advance it, update `out/status.md`, then
   re-arm or remove the wake-ups.
5. **Set Kortix up when the work repeats.** A check that outlives this job
   becomes a project trigger (`kortix triggers add <slug> --cron … --apply`,
   or a webhook) or a watcher App ("Watch 24/7"). A recurring role becomes its
   own agent or skill, landed through a CR. Ask the person once first for
   anything that runs unattended for weeks, spends credits on every run, or
   widens an agent's access. This session's own loops need no question:
   set them and say so in one line.
6. **Close out.** Remove every loop and session trigger you set
   (`kortix loops ls`, then `rm`; `kortix triggers ls`, then `rm`), stop the
   agents you no longer need (`task_stop`), mark the status file done, and
   give the person a short final report with links.

### Worked example: from 12 quotes to one order

The person asks: "Find sticker printers, get quotes for 500 stickers, and
order from the best one." In the first turn:

1. Plan in `out/status.md`: find printers (parallel), request quotes (wait
   on replies), compare (after replies), order (wait on delivery).
2. A `workflow` with 4 agents searches 4 districts and returns 12 printers
   as data. Its result arrives as a message: no loop.
3. A named agent `printer-outreach` sends the 12 emails and keeps the record
   `out/printers.md` in its own session. It sets its own email trigger and
   fallback loop, as in the 12-printer example above, and reports each check
   back to this session.
4. This session sets one loop for the whole job: `kortix loop "Long job: the
   sticker order. Read out/status.md first. Ask printer-outreach for the
   quote count; at 12 quotes or on 2026-11-07, compare them and ask the
   person to pick one. Stop on 2026-11-14." --cron "0 0 10 * * 1-5"
   --timezone Europe/Berlin`.
5. The reply ends: "Searching for printers and requesting 12 quotes. I'll
   check every working morning until 14 Nov and bring you the comparison."

When the person picks a printer, `printer-outreach` places the order; this
session replaces its loop with a daily delivery check until the tracking
says delivered. The person says the team orders stickers every quarter:
propose a quarterly trigger for a fresh quote round, and create it only
after they agree. At delivery: remove both loops, `task_stop`
`printer-outreach`, mark `out/status.md` done, and report the order, the
printer and the delivery date in three lines.

## Where a trigger lives

In `kortix.yaml` `triggers:`, or in a file the root's `imports:` brings in
(`imports: [triggers/]`, then `triggers/reports/weekly.yaml`). Look at the
layout first and put a new trigger next to its siblings. A slug is unique
across every file: a duplicate fails the whole manifest.

A **trigger** is a source (what fires it) plus a target (what a fire
does). A `kortix.yaml` trigger is `on:` plus `run:`. A fire starts a session
and prompts its agent as a teammate would, or calls one of the project's Apps
(`run: { app, path }`: no session, no model). A **loop** is a trigger that
wakes the session that created it: a runtime trigger, stored in the database.
`kortix triggers ls` lists both.

## React to an outside system: the first that fits

1. **A webhook.** The system can call a URL (Stripe, a CI job, your own
   backend): `on: { webhook: { secret: <NAME> } }`. One secret, no code.
2. **A connector event.** A connected app reports it (a new email, an issue,
   an order): `on: { event: <TYPE>, connector: <slug> }`, flag
   `event_triggers`.
3. **A schedule.** Checking on a cadence is enough ("every hour, look for new
   orders"). Nothing runs between checks.
4. **An App that posts App events.** The source sends nothing and the watch
   must run around the clock, code must decide what deserves an agent, or
   the watch needs a connection that stays open. The App runs apart from any
   session and posts the moment it sees the change ("Watch 24/7" below).

## Automations: each event starts the right work, and nothing else

An automation is a trigger that starts a colleague's session on each event
that matters: each new support email, each new issue, each form submission.
Set it up so a run never starts for noise, a follow-up reaches the session
that already knows the thing, and a run with nothing to say says nothing.
My Kortix does this with `kortix_schedules` `automate`; any agent can do it
with the CLI:

```bash
kortix triggers events --connector github --event GITHUB_ISSUE_OPENED   # fields + config
kortix triggers add issue-triage --type event --connector github --event GITHUB_ISSUE_OPENED \
  --config repo=acme/site --agent triage --model kortix/deepseek-v4.1-flash \
  --filter 'event.data.action:in=opened,reopened' --filter 'event.data.sender:not=kortix-bot' \
  --session-key '{{ event.data.number }}' --max-runs-per-day 20 \
  --prompt 'If this is not a real bug report, stop: do nothing and send no message. Otherwise label issue {{ event.data.number }} ({{ event.data.title }}) and reply with what is missing.' \
  --apply
kortix triggers fire issue-triage --dry-run --payload '{"event":{"data":{"action":"opened","number":7}}}'
kortix triggers runs issue-triage
```

1. **Filter at the source** (`--filter`, `filter:`): keep only the actions
   that matter; skip bots and Kortix itself. A filtered event starts nothing.
2. **One session per thing** (`--session-key`): the thread, issue or sender.
   The next event about the same thing queues into that session.
3. **A prompt that judges first**: what counts, what to do, where the result
   goes, and "otherwise stop and send no message".
4. **Least access and a cap**: the narrowest agent, a fast model for triage,
   `--max-runs-per-day`.
5. **Ask before it runs unattended**, then **dry-run it** with one event that
   should run and one that should not (`fire --dry-run --payload`: filter
   verdict, session key and rendered prompt; nothing fires).
6. **Review it after a few days** (`kortix triggers runs <slug>`: fired,
   skipped, failed) and tune the filter or the prompt. Remove it when it is no
   longer wanted.

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

## Loops and session triggers: the mechanics

A turn cannot sleep for hours. A loop resumes THIS session later with its
whole conversation and workspace.

- `kortix loop "<text>"` with `--in <duration>` or `--at <ISO-8601>` fires
  once; `--every <duration>` (at least `5m`) or `--cron "<expr>" --timezone
  <tz>` repeats. There is no end-date flag: the end date lives in the text.
- `kortix loops ls|pause <id>|resume <id>|run <id>|rm <id>` (`run` fires
  once now).
- A loop fire arrives as a prompt that starts `[REMINDER reminder.<id> — …]`;
  a session trigger's as `[REMINDER trigger.<id> — … trigger (<source>) …]`.
  Neither is a user message.
- `kortix triggers add "<text>" --on cr-merged|webhook|event|app …` wakes
  this session (`--session <id>` is the default inside one; `--agent <name>`
  starts a new session instead). `kortix triggers rm <id>` removes it.
- Every merge into a branch, for the whole project, is a `kortix.yaml`
  trigger: `type: change_request`, `filter: { base: main }` (omit the filter
  for any branch), `agent`, `prompt`. The prompt reads
  `{{ change_request.number }}`, `{{ change_request.title }}` and
  `{{ change_request.base_ref }}`.
- A loop lives in the database, not in `kortix.yaml`: no CR. It never
  starts a new session; it pauses itself when its session is deleted.
- From a Slack or Teams thread, the fire is not a channel turn: post the
  answer with `slack send --channel <id> --thread <ts>`.
- A wait of seconds to a couple of minutes inside one turn: `sleep`.

## Watch 24/7: an App that posts App events

An App runs apart from every session, on its own schedule, and posts an App
event the moment it sees a change. A trigger decides which session wakes or
which agent runs: an App never starts an agent itself. Use it when a source
sends nothing (a status page, a price, a vendor portal) and a loop would wake
a model every few minutes to find nothing.

The pattern has four parts:

1. **The App** checks the source once per call and posts an App event only
   when something changed. Deploy it unlisted and on demand (the
   `kortix-apps` skill): it runs only while a check runs. Each machine has
   `KORTIX_APP_ID`, `KORTIX_APP_TOKEN` and `KORTIX_APP_EVENTS_URL`.
2. **The poll**: an `every` trigger that calls the App, no session, no model.
3. **The App event**: POST `{name, data?, id?}` to `$KORTIX_APP_EVENTS_URL`
   with `Authorization: Bearer $KORTIX_APP_TOKEN`. Kortix keeps each `id` for
   30 days and fires once per `id`, so an `id` built from the content is the
   change detector: an unchanged page posts the same `id` and fires nothing.
4. **The wake-up**: a session trigger (`--on app`) or a `kortix.yaml`
   trigger that starts an agent.

A minimal watcher, `apps/status-watch/`:

```js
// server.js: GET /tick reads the page and posts status.changed when the line changes.
const http = require('node:http');
const { createHash } = require('node:crypto');
const URL_TO_WATCH = 'https://status.example.com';
const PATTERN = /Overall status:\s*([^<]+)/;    // only the part that matters

http.createServer(async (req, res) => {
  if (req.url === '/health') return res.end('ok');
  if (!req.url.startsWith('/tick')) { res.statusCode = 404; return res.end(); }
  const page = await (await fetch(URL_TO_WATCH)).text();
  const status = (page.match(PATTERN)?.[1] ?? 'not found').trim();
  const id = createHash('sha256').update(status).digest('hex').slice(0, 32);
  const posted = await fetch(process.env.KORTIX_APP_EVENTS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.KORTIX_APP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'status.changed', id, data: { url: URL_TO_WATCH, status } }),
  });
  res.statusCode = posted.ok ? 200 : 502;
  res.end(await posted.text());
}).listen(3000);
```

```dockerfile
# Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server.js .
CMD ["node", "server.js"]
```

```bash
kortix apps deploy apps/status-watch --slug status-watch --type dockerfile --on-demand \
  --command '["node","server.js"]' --port 3000 --readiness-path /health
kortix triggers add status-watch-tick --every 15m --target-app status-watch --target-path /tick --apply
kortix triggers add "The status page changed. Read it, tell the person what changed, and remove \
this trigger and status-watch-tick once it reads Operational." --on app --app status-watch
```

- Hash only the part that matters. A timestamp in the hashed text fires on
  every tick.
- The first tick fires once with the current state: the woken turn records
  it as the starting point. A return to a state seen in the last 30 days
  fires nothing.
- A trigger takes at most 60 events an hour and 30 a minute; past that it is
  suppressed for 10 minutes, and 3 suppressions in 24 h disable it. Emit one
  summary event, not one per item. One event is at most 8 KiB; `name` is
  1-128 letters, digits and `. _ : / -`. The answer is
  `202 {accepted, deduped, suppressed, triggers}`; `401 app_token_invalid`.
- Kortix wakes an on-demand App for each call and sends `x-kortix-trigger`,
  `x-kortix-trigger-source`, `x-kortix-delivery-id`. A `2xx` is a fired run;
  `429` and `5xx` are retried; a `3xx` is not followed.
- The App can pace itself instead: `POST $(dirname "$KORTIX_APP_EVENTS_URL")/runs`
  with `{"run_after": "10m", "path": "/tick", "payload": {…}}` (or `run_at`,
  at most 366 days ahead) → `201 {run_id, run_at}`; `DELETE …/runs/<run_id>`
  cancels. At most 1,000 pending runs per App.
- For the whole project instead of one session, a `kortix.yaml` trigger
  starts an agent (`event: "*"` matches every name; the first prompt line is
  `[APP EVENT — automated, not user input]`):
  ```yaml
  - slug: status-changed
    on: { event: status.changed, app: status-watch }
    run: { agent: ops, prompt: "Status is now {{ event.data.status }}." }
  ```
- Done watching: `kortix triggers rm` the session trigger,
  `kortix triggers disable status-watch-tick` (or delete it), and
  `kortix apps delete status-watch --yes` when nothing else uses it.

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

- [ ] Every wait has a wake-up: an event, a fallback loop, an end date, and
      one line to the person.
- [ ] The loop text names what was sent, to whom, what to check, each
      outcome, and when to stop.
- [ ] Right mechanism: loop, session trigger, one-off `at`, `cron`/`every`,
      webhook, App call, or App events.
- [ ] 6-field cron, `timezone` set, no day-of-month + day-of-week trap, no
      exact-minute check.
- [ ] Session mode chosen on purpose; the prompt carries all context.
- [ ] Idempotent: scoped by `cron.last_scheduled_for`, records what it handled.
- [ ] Notifies only on something new; silent otherwise.
- [ ] An event trigger filters at the source (`--filter`), keys one session
      per thing when follow-ups come (`--session-key`), and is capped
      (`--max-runs-per-day`).
- [ ] Its prompt judges first and stops silently when the event does not count.
- [ ] Dry-run with `kortix triggers fire <slug> --dry-run --payload …` for an
      event that should run and one that should not; then tested once with
      `kortix triggers fire <slug>`.
- [ ] A review of `kortix triggers runs <slug>` is scheduled a few days out.
- [ ] Removed when the work is done; the user knows how to stop it.
