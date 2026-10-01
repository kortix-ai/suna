---
name: kortix-drives
description: "Kortix Drive folders under `/drives` — the user's own drive, the agent's own drive, and team drives, synced with the Kortix web app and every other session. Load before you read or save a file the user should keep, look for the user's notes, preferences or context, keep memory or outputs across sessions, or when you see a file named `... (conflict <date> <time>)...`."
---

<skill name="kortix-drives">

<overview>
A **drive** is a folder that lives outside this sandbox. It syncs both ways
within seconds with the Kortix web app and with every other session that
mounts it, it keeps a version history, and it outlives this session.
Everything under `/drives` is a drive; everything else on this machine is
session scratch.

`/drives/README.md` is the live map for THIS session: which drives are
mounted, where, read-only or read-write, and any open conflicts. Kortix
rewrites it whenever a drive is attached, detached or changes mode. Read it
first; never edit it.
</overview>

<layout>
| Path | What it is | Access |
| --- | --- | --- |
| `/drives/me` | the user's own drive: their notes, preferences, context | read-only by default |
| `/drives/from-agents` | the "From agents" folder of the user's drive | read-write |
| `/drives/agent` | your own drive: your memory and outputs, shared by every session of this agent | read-write |
| `/drives/<name>` | a company drive, or a drive a colleague shared | as granted |

- Look in `/drives/me` for the user's context before you ask them for it.
- Save files meant for the user in `/drives/from-agents`. They appear in the
  user's drive under **From agents**.
- Keep what you need to remember across sessions in `/drives/agent`.
- When `/drives/me` is read-write, the user opted in to full write for this
  session or this agent. Still prefer `/drives/from-agents` for new files;
  change the user's own files only when asked.
- A drive can be attached or detached while you run. Re-read
  `/drives/README.md` when a path you expected is missing.
</layout>

<conflicts>
When two writers change the same file at the same time, nothing is lost:
one version stays at the path and the other is saved beside it as
`<name> (conflict <date> <time>)<ext>`. Kortix tells the user in the web app.

- Tell the user about a conflict copy that touches your work.
- Do not delete or rename a conflict copy on your own. Merge the two versions
  only when the user asks.
- SQLite databases are kept whole: a conflicting `app.db` arrives as
  `app (conflict ...).db`.
</conflicts>

<limits>
- A file written here is visible elsewhere within seconds, not instantly.
  Avoid two sessions editing one file at once.
- Writes go through `sync`/close like any disk: close files you write.
- Do not put secrets or credentials in a drive: other people with access to
  the drive read the same files.
</limits>

</skill>
