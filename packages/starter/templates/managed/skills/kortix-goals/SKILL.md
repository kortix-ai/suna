---
name: kortix-goals
description: "Own an outcome until it is verifiably done, across days or months: a goal folder in Files (`goal.json`, `log.md`, `notes.md`, `docs/`, `evidence/`) run with the `kortix goals` CLI, a daily heartbeat reminder, chasing people for what only they can give, worker sessions, and an independent verifier before done. Load when the user gives an objective rather than a task (\"make sure X\", \"get me Y\", \"keep at it until\", \"/goal\"), when a prompt names a goal folder or `goal.json`, when a reminder says \"Goal wake\", when you receive a `[GOAL CHECK]` message, or when the user asks how a goal is going."
---

<skill name="kortix-goals">

<overview>
A goal is an outcome you own until it is true, not a task you attempt once.
"Make sure my Rho account is fully closed" and "secure EUR 2.5M of EIC
Accelerator funding" are goals. The user gives the objective once and walks
away. You plan, act, wait, chase, and verify until it is done.

A goal is a folder in Files. Sessions come and go; the folder is the goal's
memory and the only state that counts. A new session with no transcript must
be able to continue from the folder alone.

You run a goal with the `kortix goals` CLI. It writes the parts of `goal.json`
that the platform depends on and refuses moves the rules do not allow. Do not
write those parts by hand (see `<goal-json>`).
</overview>

<how-it-keeps-going>
Nothing runs between your turns. Three things wake you, and each wake is one
turn:

1. **The heartbeat**: a reminder on this session, armed by `kortix goals new`,
   that fires daily with the prompt "Goal wake: <folder>. Load the
   kortix-goals skill and run one wake."
2. **A reply**: a person answering in a thread bound to this session.
3. **Your own next step**: anything you queue for yourself.

After every turn, the sandbox runs `kortix goals check --enforce --quiet` for
every goal this session coordinates. A broken rule (for example no heartbeat
while the goal is open) sends you a `[GOAL CHECK]` message with the fix, at
most 3 per goal in 6 hours. Fix exactly what it names, then end the turn.

If this session's sandbox fails, the next heartbeat starts a new session, moves
the heartbeat and the Slack threads to it, and tells it which session failed.
If that is you, you are the coordinator now (see `<gotchas>`).

If this session is deleted, the goal stops waking. Never delete a coordinator
session of an open goal.
</how-it-keeps-going>

<commands>
| Command | What it does |
| --- | --- |
| `kortix goals new "<objective>" [--shared] [--slug <slug>]` | Creates `Goals/<slug>/` with `goal.json`, `log.md`, `notes.md`, `docs/`, `evidence/` in `/drives/me` (or `/drives/company` with `--shared`); marks this session unattended; arms the daily heartbeat (first fire in 24 hours) and records its id; installs the after-turn check; sets status `draft`. Prints the folder. Refuses when the folder already holds a goal. |
| `kortix goals transition <to> --reason "<why>" [<folder>]` | The only way to change `status`. Allows only the edges in `<lifecycle>`, checks each guard, appends the move to `transitions` in `goal.json` and to `log.md`. `done` and `abandoned` also delete the heartbeat. A refusal names every missing condition; exit 1. |
| `kortix goals check [<folder>]` | Checks every goal this session coordinates (or one folder). Prints each broken rule with its fix; exit 1 when any is broken. |
| `kortix goals ls` | Every goal in the mounted folders: status, criteria met, open asks, next wake. |
| `kortix goals status [<slug>]` | One goal: objective, status, criteria met, summary, open asks, next wake. |

Add `--json` to any of them for machine-readable output.

`new` needs three project features on: `goals`, `volumes` (Files) and
`reminders`. When one is off it refuses and prints the
`kortix projects features enable …` command. Run it if you may (a project
admin can); otherwise tell the user which feature to turn on.
</commands>

<lifecycle>
```
draft ──▶ active ──▶ waiting_on_user ──▶ active
                 ──▶ waiting_external ──▶ active
                 ──▶ verifying ──▶ done
                         └──▶ active        (a criterion FAILed)
any of draft, active, waiting_*, verifying ──▶ abandoned   (the user said stop)
```

| Move | Guard checked by `transition` |
| --- | --- |
| draft → active | 2 to 6 `success_criteria`; exactly one active heartbeat; this session is unattended |
| active → waiting_on_user | at least one open `ask` item; every open `ask` has an `owner` and a `due` |
| active → waiting_external | at least one open `wait` item; every open `wait` has a `due` |
| waiting_* → active | none |
| active → verifying | every criterion has `met: true` and an `evidence` path that exists in the folder; a session with role `verifier` is listed in `sessions` |
| verifying → done | `evidence/verification.md` contains PASS and no FAIL; `verified_by` is the id of a `verifier` in `sessions`, not a coordinator |
| verifying → active | none |
| → abandoned | the goal is open |

There is no move from `waiting_on_user` to `waiting_external` or back: go
through `active`.
</lifecycle>

<goal-json>
`kortix goals new` writes this file. Keep its shape. Times are UTC ISO 8601.

```json
{
  "version": 1,
  "objective": "Rho business account fully closed",
  "status": "active",
  "summary": "Closure requested 2026-10-19. Waiting for Rho's written confirmation (due 2026-10-24).",
  "success_criteria": [
    { "id": "c1", "text": "Rho confirms the closure in writing", "met": false, "evidence": null },
    { "id": "c2", "text": "No charge on any linked account for 30 days after closure", "met": false, "evidence": null }
  ],
  "items": [
    { "id": "i1", "kind": "task", "title": "Request closure in the Rho app", "status": "done", "owner": "agent", "due": null },
    { "id": "i2", "kind": "ask", "title": "Approve the 2FA prompt", "status": "open", "owner": "user", "due": "2026-10-20T09:00:00Z" },
    { "id": "i3", "kind": "wait", "title": "Rho written confirmation", "status": "open", "owner": "Rho support", "due": "2026-10-24T17:00:00Z" }
  ],
  "sessions": [{ "id": "<session_id>", "role": "coordinator", "since": "2026-10-19T19:00:00Z" }],
  "reminder_id": "reminder.3f9a1c2e7b04",
  "verified_by": null,
  "next_wake_at": "2026-10-21T09:00:00Z",
  "transitions": [{ "from": null, "to": "draft", "at": "2026-10-19T19:00:00Z", "reason": "goal created", "by": "<session_id>" }]
}
```

| Field | Who writes it | Rule |
| --- | --- | --- |
| `version` | CLI | always 1 |
| `status`, `transitions` | **CLI only** (`transition`) | never edit by hand: `check` reports a status that differs from the last transition |
| `objective` | CLI, then you | a true-or-false outcome |
| `success_criteria` | you | 2 to 6; `met: true` only with an `evidence` path (relative to the folder) to a file that exists |
| `items` | you | `kind`: `task` (work), `ask` (something only a person can give), `wait` (an outside event). `status`: `open`, `doing`, `done`, `dropped`. Open asks need `owner` and `due`; open waits need `due` |
| `sessions` | CLI adds the coordinator; you add workers and verifiers | roles: `coordinator`, `worker`, `verifier` |
| `reminder_id`, `next_wake_at` | CLI, then you when you re-arm | `reminder_id` must be the one active heartbeat |
| `verified_by` | you, after the verifier answers | the verifier's session id |
| `summary` | you | one paragraph: where the goal is now |

`goal.json` holds only these fields, and items only `id`, `kind`, `title`,
`status`, `owner`, `due`. `check` reports any other field. Everything else goes
in `notes.md`: the user's original request, the constraints, one thread per
person, and what you learned. `kortix goals new` creates those sections.

Read the file just before you write it, and write it with valid JSON.
</goal-json>

<start>
When the user gives an objective:

1. `kortix goals new "<the objective, as an outcome>" [--shared]`. Use the
   user's own folder unless they say team or company.
2. Write 2 to 6 success criteria into `goal.json` that someone else can check.
   Each one names its proof.
3. Write the constraints under `## Constraints` in `notes.md`: the user's
   words, plus the obvious ones (no spend above what the user named, nothing
   that harms their other accounts). Ask only when a wrong guess is expensive
   or irreversible.
4. Add the first items, then `kortix goals transition active --reason "criteria written"`.
5. Act on the first item in this turn.
6. `kortix goals check`, then end the turn with three lines to the user: the
   outcome, the criteria, the first thing you need from them (or "nothing for
   now").
</start>

<wake>
Every turn on a goal, whatever woke you:

1. **Orient.** Read `goal.json`, the last 40 lines of `log.md`, `notes.md`.
   Look for what changed: new files in `docs/`, replies in your threads,
   finished workers.
2. **Advance.** Do the highest-leverage open item. Mark finished items `done`.
   Add new items. A `wait` whose `due` passed: check it, then follow up.
3. **Chase.** For every open `ask` past its `due`, message its owner (see
   `<chase>`), then set a new `due` (the next day, as a rule).
4. **Move.** When the situation changed, `kortix goals transition <to>
   --reason "…"`: waiting for a person, waiting for an event, back to active,
   or verifying.
5. **Save.** Update `summary` and `items`. Append one line per action to
   `log.md`. Put durable facts in `notes.md`.
6. **Re-arm when the next wake must be earlier than the heartbeat.** The
   heartbeat fires daily. For an earlier wake (a `due` today, a worker you
   started), replace it:

   ```bash
   kortix reminders rm <reminder_id>
   kortix remind "Goal wake: <goal folder>. Load the kortix-goals skill and run one wake." --at <ISO time> --every 1d --name "goal <slug>"
   ```

   The prompt must contain the goal folder path: that is how `check` finds
   the heartbeat. Write the new id into `reminder_id` and the time into
   `next_wake_at`.
7. `kortix goals check`. End the turn only when it passes.

If `kortix remind` answers `feature_disabled`, run
`kortix projects features enable reminders`. If that is refused, tell the user
the goal cannot wake on its own.
</wake>

<chase>
You depend on people. Act like a colleague who needs the thing to do the job:
specific, polite, persistent.

**Never ask with the question tool.** `kortix goals new` marks this session
unattended, so the platform answers a question tool call at once with "nobody
can answer". Write the question in plain text, send it on a channel, record the
`ask`, and end the turn. The answer arrives as a new message and wakes you.

- Ask once, precisely: what you need, why it unblocks the goal, how to send it
  ("reply with the PDF", "drop it in `<goal folder>/docs/`").
- Use the channels this project has (`kortix connectors ls`). Use the one the
  person answered on before, else the one they use most. Never invent one.
- **One thread per person per goal.** A reply reaches you only in a thread bound
  to this session. On Slack, the first `slack send --channel <DM or channel>`
  binds its thread; read `thread_binding` in the output (the `kortix-slack`
  skill). Write the person, channel and thread under `## Threads` in
  `notes.md`, and send every later message to that person with `--thread`.
  Tell them once to reply in that thread.
- Raise the pressure with each chase, recorded in `log.md`: first a reminder,
  then the consequence of the delay ("the EIC cut-off is 2026-11-04; without
  the financials I cannot submit"), then a short daily ping. Stay professional.
- A reply or an upload resolves the `ask`: set it `done` and record where the
  answer is.
- Chase outside parties (a vendor, a bank, an agency) the same way, on the
  channel you used to reach them.
</chase>

<autonomy>
- Act on anything inside the goal's constraints (`notes.md`) without asking.
  Report it in `log.md` and `summary`.
- A constraint is a hard limit. An action outside it becomes an `ask`.
- Do not ask for what you can find: search Files, the connectors, the web and
  earlier goal folders first.
- Credentials go in the Secrets Manager, never in the goal folder. Ask for a
  missing one with a setup link (the `kortix-system` skill).
</autonomy>

<workers>
Give parallel or heavy work to worker sessions. The coordinator owns
`goal.json`; a worker does one item.

```bash
kortix sessions new --meta unattended=true --prompt "Work item <id> of the goal in <goal folder>. Load the kortix-goals skill. Do only that item. Put outputs in docs/ or evidence/, append one line to log.md, do not edit goal.json, and end with a one-paragraph result." --json
```

Add the worker to `sessions` with role `worker`. On a later wake, check it with
`kortix sessions wait-for <id> --timeout 5` (exit 0 = finished, 1 = its turn
failed, 124 = still working). While a worker runs, re-arm the heartbeat to wake you in 15 minutes.
</workers>

<done>
A goal is done when every criterion is met with proof in `evidence/` and a
session that did none of the work confirms it. You never judge your own work.

1. Set every criterion `met: true` with its `evidence` path.
2. Start the verifier and add it to `sessions` with role `verifier`:

   ```bash
   kortix sessions new --meta unattended=true --prompt "Verify the goal in <goal folder>. Load the kortix-goals skill. You did none of the work. For each success criterion in goal.json, check its evidence yourself. Write PASS or FAIL per criterion with the reason to evidence/verification.md. Do not edit goal.json." --json
   ```

3. `kortix goals transition verifying --reason "all criteria have evidence"`.
4. Wait for it in this turn: `kortix sessions wait-for <id> --timeout 900`.
   Then read `evidence/verification.md`.
5. All PASS: set `verified_by` to the verifier's session id, then
   `kortix goals transition done --reason "verified"` (this also deletes the
   heartbeat). Send the user one message: the outcome and where the proof is.
6. Any FAIL: `kortix goals transition active --reason "<what failed>"`, add
   items for the gaps, and continue.

The goal also ends when the user says stop:
`kortix goals transition abandoned --reason "<the user's words>"`. It never
ends because it is hard, slow or blocked. A blocked goal waits and chases.
</done>

<status>
When anyone asks how a goal is going: `kortix goals status <slug>` (or
`kortix goals ls` for all). Answer with the status, the summary, what waits on
them, and the next wake.
</status>

<gotchas>
- **You were started after a failed coordinator.** Your first message names
  the failed session. Add yourself to `sessions` with role `coordinator`
  (keep the old entry), then run one wake. The heartbeat and the Slack threads
  already moved to you.
- **One writer for `goal.json`.** Only the coordinator writes it. A clash
  leaves a `(conflict ...)` copy beside it: merge the two, then delete the copy.
- **The user's edits win.** A field the user changed in Files is the truth.
- **Absolute dates.** Write "2026-11-04", never "next Tuesday".
- **No secrets in the folder**, and no customer data beyond what the goal needs
  in a shared folder.
</gotchas>

</skill>
