---
name: kortix-goals
description: "Work a goal until an independent verifier passes every done criterion, across days or weeks: the Goals API holds the state, the goal folder in Files (`GOAL.md` brief, `log.md`, `evidence/`) holds the work, and the `kortix goals` CLI moves it. Load when a prompt starts or wakes a goal (\"Goal wake\", a goal_id, \"Verify the goal\"), when you receive a `[GOAL CHECK]` message, when the user gives an outcome rather than a task (\"make sure X\", \"keep at it until\", \"make this a goal\", \"/goal\"), or when someone asks how a goal is going."
metadata:
  kortix-feature-flag: goals
---

<skill name="kortix-goals">

<overview>
A goal is what a person wants plus a definition of done. An owner session
works it. A separate verifier session decides whether it is done.

The **Goals API is the authority**. It holds the state, pause, stop, owner,
verifier, criteria, caps and counters. It knows which session calls from the
session's own credential: no flag or file can make you the owner, the
verifier or a person. `kortix goals` calls the API; every refusal it prints
is the API's or the CLI's rule, with the reason.

The folder in Files (`/drives/me/Goals/<slug>/` in a session) holds the work:

| File | Holds | Who writes |
| --- | --- | --- |
| `GOAL.md` | the brief: the person's request, `## Done criteria`, context, plan | you (criteria only while the goal is a draft) |
| `log.md` | append-only: each wake, what changed, what is next | you; never rewrite earlier lines |
| `evidence/` | proof per criterion; `verification.md` is the verifier's report | you; the verifier writes `verification.md` |

After each accepted write the CLI puts a `kortix-lifecycle` block in GOAL.md's
front matter (state, revision, owner). It is a read-only copy for you. Editing
it, or writing `state:`, `paused_at:` or caps into GOAL.md, changes nothing.
`kortix goals status` is the truth.
</overview>

<lifecycle>
```
draft ──▶ active ──▶ verifying ──▶ done      (every criterion passed)
            ▲  │          └──────▶ active    (any criterion failed)
            │  ▼
       waiting_on_user                        (until the assigned user answers)
any open state ──▶ stopped                    (a person, from the Goals page)
```

You cannot reach `done`, and you cannot stop, pause, resume or restart a goal,
or raise its caps. A person does those from the Goals page.
</lifecycle>

<commands>
| Command | Who | What it does |
| --- | --- | --- |
| `kortix goals status [<slug>]` / `ls` | anyone | the goal as the API holds it: state, criteria (reported met vs verified), waiting on, owner, verifier, next wake, caps |
| `kortix goals transition active --reason "…"` | owner | draft → active: sends the list under `## Done criteria` in GOAL.md (1 to 8), then activates |
| `kortix goals transition waiting_on_user --reason "<question>" [--chase-at <iso>]` | owner | asks the assigned user; see `<waiting>` |
| `kortix goals progress [--met c1,c2] [--unmet c3] [--evidence c1=evidence/x.md] [--summary "…"]` | owner | reports criteria and the summary. Evidence paths are relative, under `evidence/`. Reporting is not verifying |
| `kortix goals verify` | owner | every criterion reported met with an evidence file that exists: the API starts a verifier session and the goal is `verifying` |
| `kortix goals handover --note "<state of play>"` | owner | the API starts a fresh owner session with the note; you stop |
| `kortix goals verdict --pass <ids> [--fail <ids>] [--inconclusive <ids>] [--note <id>="<why>"]…` | verifier | see `<verify>` |
| `kortix goals check` | owner | prints what the goal needs from you |

Add `--json` for machine-readable output and `--goal <goal_id>` when the CLI
cannot tell which goal you mean. `kortix goals new` is for a person: in a
session the API refuses it.
</commands>

<start>
**A goal started from the Goals page.** Your first message names the goal.
The goal, its folder and its heartbeat exist; you are its owner and it is a
`draft`.

1. `kortix goals status`. Read GOAL.md and `log.md`.
2. Keep the person's done criteria. When there are none, write 1 to 8 under
   `## Done criteria`, each one checkable by someone else and naming its proof.
3. Write the context: their words, the constraints, the obvious ones (no spend
   above what they named, nothing irreversible without asking).
4. `kortix goals transition active --reason "criteria written"`.
5. Act on the first step in this turn. Append it to `log.md`.

**A person asks for a goal in chat.** You cannot create it. Agree the outcome
and the done criteria with them, then ask them to create it from the Goals
page. The API starts an owner session for it.
</start>

<wake>
Every turn on a goal is one wake: the heartbeat, an answer, a verdict, a
merged change request, a person in this chat.

1. **Orient.** `kortix goals status`, GOAL.md, the last 40 lines of `log.md`.
   Paused (`paused by a person`): do no work, end the turn.
2. **Advance.** Do the highest-leverage next step. Use workers for parallel or
   heavy work.
3. **Report.** `kortix goals progress` with what changed. Append one line per
   action to `log.md`.
4. **Ask** when only a person can unblock it: see `<waiting>`.
5. **Claim done** when every criterion is met with evidence:
   `kortix goals verify`. End the turn. The verdict wakes you.
6. End the turn. After it, kortixd runs `kortix goals check --enforce`. It
   sends `[GOAL CHECK]` when your goal is still a draft or you reported
   nothing for 3 wakes (at most 3 messages per 6 hours). Do what it names.

**Context nearly full?** Write the state of play (done, in flight, next, open
questions, where things are) and `kortix goals handover --note "…"`. Stop
working the goal after that.
</wake>

<waiting>
Write the question in plain text, send it on a channel the person uses (see
`<permissions>`), then
`kortix goals transition waiting_on_user --reason "<the question>"` and end
the turn. Never use the blocking question tool: nobody watches this session.

While the goal waits, the API runs no heartbeat turn. It wakes you when the
assigned user answers from the Goals page (the goal is `active` again), or
once at `--chase-at` (60 minutes to 14 days ahead) when you set it. When the
answer reaches you another way (a reply on the channel you asked on), run
`kortix goals transition active --reason "<what they answered>"` yourself.
</waiting>

<verify>
You are the verifier when your first message asks you to verify a goal. You
did none of the work.

1. `kortix goals status`: the current criteria and their evidence.
2. Check each criterion yourself: open the evidence, then check the real thing
   (the page, the file, the API, the record). An owner's note is not proof.
3. Write `evidence/verification.md`: one line per criterion, `c1 PASS: <why>`
   or `c1 FAIL: <what is missing>`. The CLI refuses a verdict without it.
4. Give exactly one result per current criterion, for example
   `kortix goals verdict --pass c1,c2 --fail c3 --note c3="charged in USD"`.
   A missing, duplicate or unknown id is refused; a fail or inconclusive needs
   a note. All pass: the goal is done. Any other result: it goes back to the
   owner with your notes.
5. Do not edit GOAL.md. Do not fix the work.

A session that owned the goal cannot give its verdict: the API refuses it.
</verify>

<limits>
A person sets the caps on the Goals page; the API enforces them when a wake
starts. `kortix goals status` shows them.

- heartbeat (default 4h): how often an `active` goal wakes.
- wakes per UTC day (default 12): at the cap the goal is `blocked: wake_cap`
  until the next UTC day.
- sessions per goal (default 10, owners and verifiers): at the cap `verify`
  and `handover` are refused (`session_cap`). Ask the assigned user to raise it.

Other `blocked` reasons: `credits` (a person tops up and resumes),
`owner_lost`, `storage`, `flag_off`, `setup`. None of them is yours to fix:
say so in `log.md` and end the turn.
</limits>

<permissions>
The goal decides nothing about access. Every email, Slack message or
connector call goes through the assigned agent's grants and the connector's
approval rules, as in any session. When the agent lacks a grant, do not work
around it: ask for it (`<waiting>`). Credentials go in the Secrets Manager,
never in the goal folder.
</permissions>

<status>
When anyone asks how a goal is going: `kortix goals status <slug>` (or
`kortix goals ls`). Answer with the state, the summary, what it waits on, and
the next wake. Say "reported met" for what the owner claims and "verified"
only for what a verifier passed.

When `ls` prints "Unverified local copy", the API did not answer: you know the
folders and their briefs, not the state. Say that.
</status>

<gotchas>
- **One owner.** After a handover or a successor takes over, the API refuses
  a former owner's writes. A former owner that gets a message points to the
  goal and does nothing else.
- **Revision conflicts.** A person may edit the goal while you work. The CLI
  re-reads once and retries when the move is still valid; otherwise it prints
  why. Read `kortix goals status` and continue from there.
- **Absolute dates.** Write "2026-11-04", never "next Tuesday".
- **No secrets** in the folder, and no customer data beyond what the goal needs.
</gotchas>

</skill>
