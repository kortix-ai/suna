---
name: kortix-user-memory
description: "Per-user memory in the user's own Drive folder: `/drives/me/Memory`, and a channel's or DM's shared memory. Who this user is, how they like to work, what they corrected, what they are working on — kept across every session they start, private to them. Load at the start of a task for a person, when the user says remember / forget / you should know, when they correct how you work, or when you learn a durable fact about them."
---

<skill name="kortix-user-memory">

<overview>
Each person in a Kortix project has their own folder in Files,
`Users/<name>`, mounted in their sessions at `/drives/me` (and
`~/Desktop`). Kortix creates `/drives/me/Memory` in it. That folder is this
user's memory: what you keep about THIS person, read back in every session
they start.

- It is private to the user until they share their folder.
- It syncs with the Kortix web app (Drive → My drive → Memory) within
  seconds. The user can read, edit and delete every file there.
- It is plain markdown. Use the file tools (`read`, `write`, `edit`, `bash`).
  The `memory` tool covers only the project brain at `memory/`, not this
  folder.

User memory is not project memory. Facts the whole team needs go in the
project brain (`memory/`, the `kortix-memory` skill) or in `Company/Memory`
when it is mounted (the `kortix-drives` skill).
</overview>

<protocol>
1. **Start of a task for a person: read the index.**
   `cat /drives/me/Memory/MEMORY.md`. Then read only the files it points at
   that matter for the task. Nothing is injected into your prompt: if you do
   not read it, you work without it.
2. **Use it.** Apply the preferences and corrections without being asked
   again. Do not recite the memory back to the user.
3. **Write when something durable shows up** (rubric below). Write it in the
   same turn: your context can reset at any time.
4. **Say it in one line.** After a write: "Saved to your memory: <fact>."
   After a delete: "Removed from your memory: <fact>."
5. **Forget on request.** "Forget X" deletes the entry and its index line.
   Never keep a copy elsewhere.

`/drives/me` is the folder of the session's owner. In a session several
people use (a shared session, a channel thread), keep only the owner's facts
there. When `/drives/me` is absent (Volumes off for the project, or no
personal folder in `/drives/README.md`), there is no user memory: do not
write one anywhere else, and tell the user if they asked you to remember
something.
</protocol>

<channels>
A thread in a channel or a DM has one more memory: the space's own. Its
path is in the "This thread's channel" (or DM) section of
`/drives/README.md`. That path is the one to use. `KORTIX_SPACE_KIND` /
`KORTIX_SPACE_SLUG` say which space the thread started in
(`KORTIX_SPACE_SLUG` is the agent's name in a DM). They do not change when
a channel is renamed, so never build a path from them. A thread can also
have the README section without these variables.

- **Channel**: `/drives/company/Channels/<slug>/Memory/`. Shared with
  everyone in the project. Keep what the next thread in this channel should
  know: decisions, conventions, open work. Never a person's private facts.
- **DM**: `/drives/me/Memory/agents/<agent>/`. Private to the user, for
  your work with them as this agent.

Read the space memory's `MEMORY.md` at the start of the thread, next to the
user's own. Write durable facts there in the same turn: a `MEMORY.md`
index and topic files, in the style below. The user's own facts still go in
`/drives/me/Memory/`. Create a missing memory folder only at the path the
README names. When the README has no such section, the thread has no space
memory: do not invent a path.
</channels>

<layout>
```
/drives/me/Memory/
├── MEMORY.md        Index. Read first. One line per file.
├── profile.md       Role, team, expertise, time zone, languages.
├── preferences.md   Tone, formats, tools, defaults they want.
├── feedback.md      Corrections and confirmed approaches, each with the why.
└── work.md          Ongoing work, goals, deadlines (absolute dates).
```

Create a file the first time it has content, not before. Add a new
kebab-case file when one topic outgrows its file. Keep `MEMORY.md` in sync,
one line per file:

```
- [preferences.md](preferences.md) — short answers, tables over prose, EU date format
```

Create the folder if it is missing: `mkdir -p /drives/me/Memory`.
</layout>

<rubric>

### Keep

- **Who they are**: role, team, what they own, their expertise level.
- **How they want you to work**: tone, length, format, language, tools,
  "always / never" rules they state.
- **Corrections**: what you did wrong and what to do instead, with the
  reason they gave. A confirmed approach counts too ("yes, exactly like
  that").
- **Ongoing work**: goals, deadlines, the thing they come back to every
  week. Convert "next Friday" to `YYYY-MM-DD`.
- **Pointers**: where their things live (a dashboard, a folder in Files, a
  channel), never the content behind them.

### Drop

- Secrets, passwords, tokens, API keys, card numbers. Those go in the
  Kortix Secrets Manager.
- Anything that is only about this conversation.
- Facts the repo, Files or a connector already holds — point to them.
- Guesses about the user. Store what they said or did, not what you infer
  about their personality, health, beliefs or private life.
- Team facts. Those are project memory (`kortix-memory`).

### Style

- One fact per bullet. Short, present tense, specific.
- Date facts that go stale: `(2026-10-19)`.
- Update an existing bullet instead of adding a near-duplicate.
- Delete a bullet that turned out wrong.

</rubric>

<gotchas>
- **Two sessions, one file.** The user may run several sessions at once.
  Read the file just before you edit it, and change only your lines. A
  clash leaves a `(conflict ...)` copy beside the file (the `kortix-drives`
  skill): tell the user, do not delete it.
- **The user's edits win.** A file the user changed in the web app is the
  truth. Do not restore what they removed.
- **Shared folder = shared memory.** A user who shares their folder in
  Files shares `Memory/` with it. Keep it to work facts.
- **Small files.** The index stays under ~40 lines and each file under ~200.
  Split or prune before that.
</gotchas>

</skill>
