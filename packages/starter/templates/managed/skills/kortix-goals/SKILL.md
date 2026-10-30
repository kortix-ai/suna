---
name: kortix-goals
description: "Work a goal until an independent verifier confirms it done, across days or weeks: a goal folder in Files (`GOAL.md`, `log.md`, `evidence/`) run with the `kortix goals` CLI, a heartbeat loop, questions to the assigned user, handovers to a fresh session, and a verifier session before done. Load when the user gives an outcome rather than a task (\"make sure X\", \"get me Y\", \"keep at it until\", \"make this a goal\", \"/goal\"), when a prompt says \"Goal wake:\", \"Goal reply:\" or \"Verify the goal\", when you receive a `[GOAL CHECK]` message, or when the user asks how a goal is going."
metadata:
  kortix-feature-flag: goals
---

<skill name="kortix-goals">

<overview>
A goal is what a person wants plus a definition of done. You work it until a
separate verifier session confirms it, not until you think it is done.

Three things, three questions:

| Thing | Answers |
| --- | --- |
| Agent | who works it: its grants decide what the goal may touch |
| Trigger (a loop is one) | when work starts: the heartbeat, a reply, a merged change request |
| Goal | what done means: the folder below |

A goal is a folder in Files, `Goals/<slug>/` in the company folder by default
(`/drives/company/Goals/<slug>/` in a session). It is shared context: every
session that works the goal reads it and appends to it. Sessions come and go;
a new session with no transcript must be able to continue from the folder.
The person shares the folder or keeps it private with normal Files sharing.

| File | Holds | Who writes |
| --- | --- | --- |
| `GOAL.md` | front matter: the goal, done criteria, assigned user, assigned agent, state, links, limits. Body: context in the person's words, constraints, plan | the CLI writes state and sessions; you write criteria, links, summary and the body |
| `log.md` | append-only: each wake, what changed, what is next; handovers; verifier findings | you and the CLI. Never rewrite earlier lines |
| `evidence/` | proof per criterion; `verification.md` is the verifier's report | you; the verifier writes `verification.md` |
</overview>

<lifecycle>
```
draft ──▶ active ──▶ verifying ──▶ done          (verifier PASS)
            ▲  │          └──────▶ active        (verifier FAIL, findings in log.md)
            │  ▼
       waiting_on_user                            (a question for the assigned user)
any state ──▶ stopped                             (a person said stop)
```

The CLI enforces every edge. You cannot reach `verifying` except through
`kortix goals verify`, and you can never reach `done`: only the verifier's
`kortix goals verdict pass` does. One owner session at a time moves the goal.
</lifecycle>

<commands>
| Command | Who | What it does |
| --- | --- | --- |
| `kortix goals new "<goal>" [--slug s] [--user <user_id>] [--agent <name>] [--every 4h] [--folder <dir>]` | the session that takes the goal | creates `Goals/<slug>/` (company folder unless `--folder`), makes this session the owner, marks it unattended, arms the heartbeat. State `draft` |
| `kortix goals transition active --reason "…"` | owner | from draft (1 to 8 done criteria) or from waiting_on_user |
| `kortix goals transition waiting_on_user --reason "<the question>"` | owner | the reason is the question the assigned user sees |
| `kortix goals transition stopped --reason "<the person's words>"` | owner | only when a person said stop |
| `kortix goals verify` | owner | every criterion `met: true` with an existing evidence file: starts the verifier session and moves to `verifying` |
| `kortix goals verdict pass\|fail --reason "…"` | the verifier | after it wrote `evidence/verification.md`. pass → done; fail → active with the findings in log.md. Wakes the owner |
| `kortix goals handover --note "<state of play>"` | owner | context nearly full: writes the note to log.md, starts a fresh owner session, drops this session's heartbeat |
| `kortix goals check` | owner | prints what is wrong in GOAL.md |
| `kortix goals ls` / `status [<slug>]` | anyone | every goal / one goal |

Add `--json` for machine-readable output. `new` needs the project features
`goals`, `volumes` and `reminders`; it prints the enable command when one is off.
`verify` and `handover` start sessions themselves: a "do not spawn sessions"
contract does not apply to them.
</commands>

<goal-md>
`kortix goals new` writes the front matter. Keep its keys. Times are UTC ISO 8601.

```markdown
---
goal: EU billing live: invoices in EUR with VAT
state: active
assigned_user: <user_id>
assigned_agent: billing
space: null
summary: "Pricing page done. Invoice template next."
done_criteria:
  - id: c1
    text: An invoice for a DE customer shows EUR and 19% VAT
    met: true
    evidence: evidence/invoice-de.pdf
  - id: c2
    text: Checkout charges in EUR, not USD
    met: false
    evidence: null
links:
  - evidence/invoice-de.pdf
  - /Company/Finance/vat-ids.md
  - https://<host>/projects/<project_id>/changes/12
waiting_on: null
heartbeat: 4h
max_wakes_per_day: 12
max_sessions: 10
reminder_id: reminder.0123456789ab
next_wake_at: "2026-10-28T13:00:00Z"
last_wake_at: "2026-10-28T09:00:00Z"
wake_day: 2026-10-28
wake_count: 3
verified_by: null
sessions:
  - id: <session_id>
    role: owner
    since: "2026-10-28T08:00:00Z"
transitions:
  - from: null
    to: draft
    at: "2026-10-28T08:00:00Z"
    reason: goal created
    by: <session_id>
---
# EU billing live

## Context
The request in the person's words. Constraints. What you learned.
```

| Key | Rule |
| --- | --- |
| `state`, `transitions`, `sessions`, `verified_by`, `reminder_id`, `wake_*` | **CLI only**. A state edited by hand is a `[GOAL CHECK]` |
| `done_criteria` | you: 1 to 8, each checkable by someone else, each naming its proof. `met: true` only with an `evidence` path (relative to the folder) to a file that exists |
| `links` | you: everything the goal produced or depends on: files, artifacts, Apps, change requests, sessions. The Goal page lists them |
| `assigned_user` | the person the goal is for: they answer its questions and get its updates. Default: the session's creator |
| `assigned_agent` | the agent whose grants the goal runs with |
| `heartbeat`, `max_wakes_per_day`, `max_sessions` | limits. The assigned user may change them; you do not raise them yourself |

Quote a value that contains `: ` or starts with a quote or `#`. Read GOAL.md
just before you write it.
</goal-md>

<start>
When a person gives an outcome (or says "make this a goal"):

1. `kortix goals new "<the outcome>"`. Add `--agent` when another agent should
   own it, `--user` when it is for someone else.
2. Write 1 to 8 `done_criteria` that someone else can check.
3. Write the context under `## Context`: their words, the constraints, the
   obvious ones (no spend above what they named, nothing irreversible
   without asking).
4. `kortix goals transition active --reason "criteria written"`.
5. Act on the first step in this turn. Append it to `log.md`.
6. End with four lines: the outcome, the criteria, the first thing you need
   from them (or "nothing for now"), and where to watch it: the Goals page.
</start>

<wake>
Every turn on a goal is one wake, whatever started it: the heartbeat
(`Goal wake: <folder>.`), a reply (`Goal reply: <folder>.`), a merged change
request (`… Change request #N … merged.`), a verdict, a person in this chat.

1. **Orient.** Read GOAL.md and the last 40 lines of log.md. What changed?
2. **Advance.** Do the highest-leverage next step. Use workers for parallel
   or heavy work (the agent tool, or `kortix sessions new --meta goal=<folder>`
   so their change requests wake the goal too).
3. **Ask** when only a person can unblock it: write the question in plain
   text, send it on a channel they use (see `<permissions>`), then
   `kortix goals transition waiting_on_user --reason "<the question>"` and end
   the turn. Never ask with the blocking question tool: this session is
   unattended and nobody can answer it. The answer arrives as a new message.
   When it does, `kortix goals transition active --reason "answered"`.
4. **Save.** Update `summary`, `done_criteria`, `links`. Append one line per
   action to log.md.
5. **Claim done** when every criterion is met with evidence:
   `kortix goals verify`. End the turn. The verdict wakes you.
6. End the turn. After it, kortixd runs `kortix goals check --enforce`: it
   counts the wake, re-arms a missing heartbeat, holds the heartbeat until the
   next UTC day once `max_wakes_per_day` is reached, and removes the heartbeat
   of a closed goal. Only a problem code cannot fix comes back as `[GOAL CHECK]`:
   fix exactly what it names, then end the turn.

**Context nearly full?** Write the state of play (done, in flight, next, open
questions, where things are) and run `kortix goals handover --note "…"`. A
fresh owner continues from GOAL.md and your note. Stop working this goal after
that.
</wake>

<verify>
You are the verifier when your first message says "Verify the goal in
<folder>". You did none of the work and have no memory of it.

1. Read GOAL.md. For each done criterion, check it yourself: open the evidence,
   then check the real thing (the page, the file, the API, the record). An
   owner's note is not proof.
2. Write `evidence/verification.md`: one line per criterion, `c1 PASS: <why>`
   or `c1 FAIL: <what is missing>`.
3. `kortix goals verdict pass --reason "…"` when every line is PASS, else
   `kortix goals verdict fail --reason "<the failed criteria>"`.
4. Do not edit GOAL.md. Do not fix the work.
</verify>

<permissions>
The goal engine decides nothing about access. Every email, Slack message or
connector call goes through the assigned agent's grants and the connector's
approval rules, as in any session. An approval rule holds a send until a
person approves it.

When the agent lacks a grant you need, do not work around it: ask the
assigned user for it (step 3 of `<wake>`) and wait in `waiting_on_user`.
Credentials go in the Secrets Manager, never in the goal folder.
</permissions>

<limits>
- `heartbeat` (default 4h): the interval while the goal is open.
- `max_wakes_per_day` (default 12): after that many owner turns in a UTC day,
  the heartbeat waits until the next day. A person's message still reaches you.
- `max_sessions` (default 10): owners and verifiers in total. At the cap,
  `verify` and `handover` refuse: ask the assigned user to raise it.
</limits>

<status>
When anyone asks how a goal is going: `kortix goals status <slug>` (or
`kortix goals ls`). Answer with the state, the summary, what it waits on, and
the next wake. People see the same on the Goals page and on the Goal page.

When a person asks "what are my goals" or "what waits on me" (My Kortix gets
this most): `kortix goals ls --json`, keep the goals whose `assigned_user` is
that person, and list first the ones in `waiting_on_user` with their
`waiting_on` question.
</status>

<gotchas>
- **One owner.** Only the last `owner` in `sessions` moves the goal. A former
  owner that gets a message points to the goal folder and does nothing else.
- **A clash** leaves a `(conflict ...)` copy of GOAL.md beside it: merge the
  two, then delete the copy.
- **The person's edits win.** A field they changed in Files is the truth.
- **Absolute dates.** Write "2026-11-04", never "next Tuesday".
- **No secrets** in the folder, and no customer data beyond what the goal needs.
- **A legacy `goal.json` folder** still lists; start new goals with `new`.
</gotchas>

</skill>
