---
name: kortix-goals
description: "Own an outcome until it is verifiably done, across days or months: a goal folder in Files (`goal.json`, `log.md`, `notes.md`, `docs/`, `evidence/`), a heartbeat reminder, chasing people for what only they can give, worker sessions for parallel work, and a fresh-context check before done. Load when the user gives an objective rather than a task (\"make sure X\", \"get me Y\", \"keep at it until\", \"/goal\"), when a prompt names a goal folder or `goal.json`, when a reminder wakes you for a goal, or when the user asks for the status of a goal."
---

<skill name="kortix-goals">

<overview>
A goal is an outcome you own until it is true, not a task you attempt once.
"Make sure my Rho account is fully cancelled" and "secure EUR 2.5M of EIC
Accelerator funding" are goals. The user gives the objective once and walks
away. You plan, act, wait, chase, and verify until it is done.

A goal is a folder in Files. Sessions come and go: this one can fail, end, or
be replaced. The folder is the goal's memory and the only state that counts.
Every session that works on the goal reads it first and writes it back before
its turn ends. A new session with no transcript must be able to continue from
the folder alone.

| Folder | Who sees it |
| --- | --- |
| `/drives/me/Goals/<slug>/` | the user only (default) |
| `/drives/company/Goals/<slug>/` | the project, when the user says team or company |
| any folder shared in Files | whoever it is shared with |

Use the user's own folder unless they say otherwise. `/drives/README.md`
lists what this session mounts (the `kortix-drives` skill). No `/drives`
means Files is off for the project: tell the user that a goal needs it.
</overview>

<layout>
```
<goal folder>/
├── goal.json    The state. The only file other tools read.
├── log.md       Append-only timeline, newest last. One line per event.
├── notes.md     What you learned that the next session needs.
├── docs/        Inputs and outputs: uploads, drafts, submissions.
└── evidence/    Proof for each success criterion.
```

`goal.json`, version 1. Keep every field. Use `null` for none.

```json
{
  "version": 1,
  "objective": "Rho business account fully closed",
  "input": "make sure my RHO account is fully canceled and then just walk away",
  "status": "active",
  "summary": "Closure requested in-app 2026-10-19. Waiting on Rho's confirmation (due 2026-10-24).",
  "success_criteria": [
    { "id": "c1", "text": "Rho confirms the account is closed in writing", "met": false, "evidence": null },
    { "id": "c2", "text": "No charge on any linked account for 30 days after closure", "met": false, "evidence": null }
  ],
  "constraints": ["Send any remaining balance to the user's main operating account"],
  "deadline": null,
  "items": [
    { "id": "i1", "kind": "task", "title": "Request closure in the Rho app", "status": "done", "owner": "agent", "due": null, "nag_every": null, "nags": 0, "last_nag_at": null, "session_id": null },
    { "id": "i2", "kind": "ask", "title": "Approve the 2FA prompt on your phone", "status": "open", "owner": "user", "due": "2026-10-20T09:00:00Z", "nag_every": "1d", "nags": 0, "last_nag_at": null, "session_id": null },
    { "id": "i3", "kind": "wait", "title": "Rho written confirmation", "status": "open", "owner": "Rho support", "due": "2026-10-24T17:00:00Z", "nag_every": null, "nags": 0, "last_nag_at": null, "session_id": null }
  ],
  "sessions": [{ "id": "<session_id>", "role": "coordinator", "since": "2026-10-19T19:00:00Z" }],
  "reminder_id": "reminder.3f9a1c2e7b04",
  "next_wake_at": "2026-10-20T09:00:00Z",
  "updated_at": "2026-10-19T19:30:00Z"
}
```

- `status`: `active` · `waiting_on_user` · `waiting_external` · `done` · `abandoned`.
- `kind`: `task` is work you or a worker do. `ask` is something only a
  person can give: a decision, a document, a login step, a signature. `wait`
  is an outside event with an expected date.
- Item `status`: `open` · `doing` · `done` · `dropped`.
- `owner`: `agent`, `user`, a person's name, or an outside party.
- Times are UTC ISO 8601. Durations are `30m`, `1d`, `2d`.
</layout>

<start>
When the user gives an objective:

1. Restate it as an outcome that is true or false, and write 2 to 6 success
   criteria someone else can check. Each criterion names its proof.
2. Take constraints from the user's words. Add the obvious ones (no spend
   above what the user named, nothing that harms the user's other
   accounts). Ask only when a wrong guess is expensive or irreversible.
3. Create the folder, `goal.json`, `log.md`, `notes.md`. Slug: short,
   kebab-case, from the objective.
4. Plan the first items. Act on the first one in the same turn.
5. Arm the heartbeat (see `<wake>`), save `goal.json`, and tell the user in
   three lines: the outcome, the criteria, the first thing you need from them
   (or "nothing for now").
</start>

<wake>
Every turn on a goal, whatever woke you (the heartbeat, a user message, a
reply, an upload, a worker that finished):

1. **Orient.** Read `goal.json`, the last 40 lines of `log.md`, and
   `notes.md`. Check what changed since `updated_at`: new files in `docs/`,
   replies on the channels you used, workers in `sessions`.
2. **Advance.** Do the highest-leverage open item. Close items that are done.
   Add the items you discover. Move `wait` items whose date passed into an
   action: check, then follow up.
3. **Chase.** For every open `ask` past `due` whose `last_nag_at` is older
   than `nag_every`, message its owner (see `<chase>`).
4. **Save.** Update `summary`, `status`, `items`, `next_wake_at`,
   `updated_at` in `goal.json`. Append what you did to `log.md`. Put durable
   facts in `notes.md`.
5. **Re-arm.** One heartbeat reminder per goal, on the coordinator session:

   ```bash
   kortix remind "Goal wake: <goal folder>. Load the kortix-goals skill and run one wake." --at <next_wake_at> --every 1d --name "goal <slug>"
   ```

   Store its id in `reminder_id`. When `next_wake_at` changes, remove the old
   reminder (`kortix reminders rm <id>`) and create the new one. Wake at the
   earliest of: the next `due`, the next nag, or 24 hours.

Never end a turn on an open goal without a reminder armed. If `kortix remind`
answers `feature_disabled`, run `kortix projects features enable reminders`;
if that is refused, tell the user that the goal cannot wake on its own.
</wake>

<chase>
You depend on people. Act like a colleague who needs the thing to do the job:
specific, polite, persistent.

- Ask once, precisely: what you need, why it unblocks the goal, how to send
  it ("reply with the PDF", "drop it in `<goal folder>/docs/`").
- Use the channels this project has. `kortix connectors ls` lists them
  (email, Slack, and others). Use the one the person answered on before, else
  the one they use most. Never invent a channel.
- Raise the pressure with each nag (`nags`): first a reminder, then the
  consequence of the delay ("the EIC cut-off is 2026-11-04; without the
  financials I cannot submit"), then a short daily ping. Stay professional.
- A reply or an upload resolves the `ask`. Record where the answer is.
- Outside parties (a vendor, a bank, an agency) are chased the same way,
  from the channel you used to reach them.
</chase>

<autonomy>
- Act on anything inside the goal's constraints without asking. Report what
  you did in `log.md` and the summary.
- A constraint is a hard limit. An action outside it becomes an `ask`.
- Do not ask the user for what you can find: search Files, the connectors,
  the web, and earlier goal folders first.
- Credentials go in the Secrets Manager, never in the goal folder. Ask for a
  missing credential with a setup link (`kortix-system` skill).
</autonomy>

<workers>
Split parallel or heavy work into worker sessions. The coordinator owns the
goal folder; a worker owns one item.

```bash
kortix sessions new --prompt "Work item <id> of the goal in <goal folder>. Load the kortix-goals skill. Read goal.json, do only that item, put outputs in docs/ or evidence/, append one line to log.md, and end with a one-paragraph result." --json
```

Record the worker in `sessions` and on its item (`session_id`). Check
workers on each wake (`kortix sessions wait-for <id> --timeout 5`). Only the
coordinator edits `goal.json`; workers write `docs/`, `evidence/` and one
line in `log.md`.
</workers>

<done>
A goal is done when every success criterion is met with proof in
`evidence/`, not when the work feels finished.

1. Start a fresh verifier session:

   ```bash
   kortix sessions new --prompt "Verify the goal in <goal folder>. Load the kortix-goals skill. You did none of the work. For each success criterion in goal.json, check its evidence yourself. Answer PASS or FAIL per criterion with the reason, and write the verdict to evidence/verification.md." --json
   ```

2. All PASS: set `status` to `done`, remove the heartbeat reminder, and send
   the user one message: the outcome, and where the proof is.
3. Any FAIL: add items for the gaps and continue.

A goal also ends when the user says stop (`abandoned`). It never ends
because it is hard, slow, or blocked. A blocked goal waits and chases.
</done>

<status>
When anyone asks how a goal is going, answer from `goal.json`: the status,
the summary, what is waiting on them, and the next date. List all goals:

```bash
ls /drives/*/Goals/*/goal.json
```
</status>

<gotchas>
- **One writer for `goal.json`.** Read it just before you write it. A clash
  leaves a `(conflict ...)` copy beside it: merge the two by hand, then
  delete the copy.
- **The user's edits win.** A field the user changed in Files is the truth.
- **A failed session.** When the old coordinator's session failed, its
  heartbeat starts a new session and moves the reminder to it. If that is
  you, you are the coordinator now: add yourself to `sessions` and continue.
- **Absolute dates.** Write "2026-11-04", never "next Tuesday".
- **No customer data in shared folders** beyond what the goal needs, and no
  secrets anywhere in the folder.
</gotchas>

</skill>
