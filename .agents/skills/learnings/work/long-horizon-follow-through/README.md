---
title: Long-horizon follow-through ("never wait blind")
status: building (branches `mk2-followup-guide`: prompts, skills, docs; `mk2-followup-tools`: the kortixd `kortix_schedules` actions)
owner: Marko (decisions)
updated: 2026-10-31
---

# Long-horizon follow-through

**The problem.** An agent sent an email, opened a change request or started
a deploy, then ended its turn with nothing set to bring it back. The session
slept until a person typed. Observed in a My Kortix session: a colleague
emailed a list of suppliers for quotes, and no check for replies existed
until the owner typed "set urself a loop/reminder or whatever to keep
checking in on responses".

**The mandate (owner, 2026-10-31).** Every agent sets its own wake-up,
implicitly, every time it waits on a result. Loops are the default reminder;
session event triggers and App events wake it the moment the result lands.
Scope: every agent, and My Kortix is "an absolute expert on how to use
Kortix as a whole". Use what exists: no new watch service, no in-sandbox
monitor. Keep it simple.

## The rule

After any action whose result arrives later, before the turn ends:

1. Pick the signal: an event that wakes this session (cr-merged, a connector
   event, a webhook, an App event), else a loop.
2. Add a fallback loop when the event may not come. Cadence fits the wait
   (replies: first check 2–4 h in the recipient's working hours, then 2–4
   times a day; deploys: 10–30 min; slow vendors: daily). End date in the
   text, 14 days by default.
3. The loop text carries everything the woken turn needs: what was sent, to
   whom, what to check, each outcome, when to stop.
4. One plain line to the person: when it checks, until when.
5. Each fire: check, act, report what changed, widen the cadence after empty
   checks, remove every loop and trigger when done.
6. No wake-up for work that ends this turn, a hand-off, a teammate or a
   workflow (they report back by themselves), or what the person said not
   to track.

## Long jobs: plan, delegate, set wake-ups, keep state, close out

Owner, 2026-10-31: "It should be able to work on long ctxt long horizon
tasks through these methods, also spawning subagents & workflow tools & then
setting loops & other things to self configure itself". One pattern combines
every primitive:

1. Plan: parallel parts and waiting parts.
2. Delegate: named background `agent`s, a `workflow` for many, a team only for
   a shared task list. No loop for them: they report back.
3. Wake-ups: an event plus a fallback loop for every outside wait.
4. State outside the context (sessions compact): the loop text, `out/status.md`,
   or a Goal (`kortix-goals`) for multi-day verified outcomes. Every wake reads
   the state first.
5. Self-configure when the work repeats: a project trigger, a watcher App, a
   dedicated agent or skill. Ask first for unattended long-term runs, repeated
   credit spend or wider access; never ask for the session's own loops.
6. Close out: remove the wake-ups, `task_stop` idle agents, short final report.

Full text and the worked example: `references/scheduling.md` → Long jobs.

## Where it lives

| Surface | File |
| --- | --- |
| My Kortix prompt, `FOLLOW_THROUGH` section | `apps/api/src/projects/lib/my-kortix-prompt.ts` |
| My Kortix tool actions `follow_up`, `wake_on`, `events` | `apps/kortix-sandbox-agent-server/src/services/tools/platform/kortix_schedules.ts` |
| Every agent: the rule and the "waiting on → wake with" table | `packages/starter/templates/managed/skills/kortix-system/SKILL.md` `<scheduling>` |
| The playbook, the worked example, the 24/7 watcher App | `packages/starter/templates/managed/skills/kortix-system/references/scheduling.md` |
| The starter general agent | `packages/starter/templates/base/agents/worker.md` |
| People and developers | `apps/web/content/docs/guide.mdx` (Loops), `developers.mdx` (Follow-through: wake on the result) |

## The Claude Code mapping

| Claude Code | Kortix | Difference |
| --- | --- | --- |
| A background command, `run_in_background` subagent: the harness notifies when it ends | A hand-off, teammate or workflow: one notice into the parent per finished turn (`apps/api/src/projects/subagent-notice.ts`) | Durable: a stopped parent wakes to receive it |
| `Monitor` (wait on a condition, a log line, a process) | A session event trigger (`kortix triggers add … --on cr-merged\|webhook\|event\|app`), or an App that posts App events | Separated from compute: the watch runs while the session sleeps, and the App runs around the clock apart from every session |
| A self-paced wake-up (`/loop`), cron routines (`/schedule`) | A loop (`kortix loop … --in\|--at\|--every\|--cron`), a `kortix.yaml` trigger for project work | Stored in the database; survives a parked or restarted session |

A child's later turns, a loop fire included, each notify the parent. So the
session that can do the check (it holds the connector and the record) owns
the loop, and My Kortix hears every check without a loop of its own.

## Open follow-ups

- **Native loop expiry and backoff.** Loops have no `--until` or backoff
  flag. The end date lives in the text and the agent replaces a loop to
  widen it. A native `until` (auto-remove) and a backoff schedule would make
  cleanup guaranteed instead of model-dependent.
- **App event filter on session triggers.** `--on app` wakes on every event
  of the App; the woken turn filters by name. The `kortix.yaml` trigger
  already takes `event:`.
- **Connector events are off by default** (flag `event_triggers`). Most
  projects get the fallback loop alone for replies until the flag ships on.
- **Measure it.** Count sessions that send outbound mail or open a CR and
  end the turn with no loop or session trigger. A dashboard query on
  trigger rows by `target.session_id` would show the rule is followed.
- **Stale loops.** A sweep (or a project health warning) for recurring loops
  whose session has been idle past the end date in their text.
