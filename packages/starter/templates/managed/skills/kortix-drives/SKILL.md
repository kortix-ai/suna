---
name: kortix-drives
description: "The project's Files under `/drives`: the user's own folder (their desktop, also at `~/Desktop`) and the folders shared with you, synced with the Kortix web app and every other session. Load before you read or save a file the user should keep, look for the user's notes, preferences or context, keep memory across sessions, or when you see a file named `... (conflict <date> <time>)...`."
---

<skill name="kortix-drives">

<overview>
**Files** is the project's shared folder tree. It lives outside this sandbox,
syncs both ways within seconds with the Kortix web app and with every other
session that mounts it, keeps a version history, and outlives this session.
Each folder under `/drives` is one folder of Files that this session may use;
everything else on this machine is session scratch.

`/drives/README.md` is the live map for THIS session: which folders are
mounted, where, read-only or read-write, and any open conflicts. Kortix
rewrites it whenever access changes. Read it first; never edit it.
</overview>

<layout>
| Path | What it is | Access |
| --- | --- | --- |
| `/drives/me` (and `~/Desktop`) | the user's own folder, `Users/<name>` in Files | read-write |
| `/drives/me/Memory` | what you keep about this user across sessions | read-write |
| `/drives/company` | the project's shared `Company` folder, with `Company/Memory` for what the whole team should know | as shared |
| `/drives/<name>` | any other folder shared with you, this agent or this user | as shared |

- Look in `/drives/me` for the user's context before you ask them for it.
- Save files you make for the user in `/drives/me`.
- Keep what you learn about the user in `/drives/me/Memory`; keep what the
  whole team should know in `Company/Memory` when it is mounted.
- You see only folders someone shared. If you need another folder, ask the
  user to share it with you in Files.
- Access can change while you run. Re-read `/drives/README.md` when a path you
  expected is missing or refuses writes.
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
- Do not put secrets or credentials in Files: other people with access to a
  folder read the same files.
- A session mounts a limited number of folders. Folders that did not fit are
  listed in `/drives/README.md`; tell the user rather than look for them.
</limits>

</skill>
