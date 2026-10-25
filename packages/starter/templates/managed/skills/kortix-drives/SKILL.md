---
name: kortix-drives
description: "The project's Files under `/drives`: the user's own folder (their desktop, also at `~/Desktop`) and the folders shared with you, synced with the Kortix web app and every other session. Load before you read or save a file the user should keep, look for the user's notes, preferences or context, keep memory across sessions (with `kortix-user-memory`), or when you see a file named `... (conflict <date> <time>)...`."
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
| `/drives/me/Memory` | what you keep about this user across sessions (the `kortix-user-memory` skill) | read-write |
| `/drives/company` | the project's shared `Company` folder, with `Company/Memory` for what the whole team should know and `Company/Channels/<channel>/Memory` for each public channel | as shared; read-only in a private channel's thread |
| the private channel's folder | in a private channel's thread only: its files and `Memory/`, at the path `/drives/README.md` names | read-write |
| `/drives/<name>` | any other folder shared with you, this agent or this user | as shared |

- Look in `/drives/me` for the user's context before you ask them for it.
- Save files you make for the user in `/drives/me`.
- You see only folders someone shared. If you need another folder, ask the
  user to share it with you in Files.
- Access can change while you run. Re-read `/drives/README.md` when a path you
  expected is missing or refuses writes.
</layout>

<memory>
Memory is Markdown files in these folders. People read and edit the same
files in the Kortix web app (Memory tabs and Files). This is the one table of
where a durable fact goes:

| Fact about | Save in |
| --- | --- |
| this user: preferences, corrections, their work | `/drives/me/Memory/` (the `kortix-user-memory` skill) |
| what you learn in a DM with this user | `/drives/me/Memory/<your agent name>/` (the `kortix-channel-memory` skill) |
| this channel's work: decisions, people, workstreams, playbooks | the channel's `Memory/` folder, at the path `/drives/README.md` names |
| the whole team | `/drives/company/Memory/` |
| what the project is and how it is built | the repo `memory/` (the `kortix-memory` skill, through a change request) |

**In a private channel's thread** (`/drives/README.md` says the channel is
private) every fact you learn there, team facts included, goes only in that
channel's `Memory/` folder. Only its members may read it. `/drives/company`
and `/drives/me` are read-only there: never copy the channel's content into
them, into another channel, or out of the sandbox, unless a member asks.

A folder that is not mounted is not yours to write: tell the user, never
save the fact somewhere else.

Format, in every Memory folder:

- One topic per file. The first line is `# <Title>`.
- Optional folders by type: `people/`, `decisions/`, `workstreams/`,
  `playbooks/`. A file elsewhere is fine.
- `MEMORY.md` is the index: one line per file. Keep it current.
- `Notes.md` holds sentences people saved with "Remember this". File each
  line into a topic file, then delete the line.
- Optional front-matter at the top: `updated_by: <agent> (agent)`,
  `updated_at: <ISO time>`, `sources:` (a list of `label:` / `url:` items,
  for a fact from outside the thread). Keep keys you did not write.
- Read a file just before you edit it, and change only your lines.
- Never a secret, a password, a key or a token.
</memory>
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

<commands>
`kortix drive` reaches all of Files over the API, as the user who started this
session and with their folder access, including folders not mounted here.
Paths are Files paths (`/Company/plan.md`), not `/drives` paths.

| Command | What it does |
| --- | --- |
| `kortix drive ls [<path>]` | List a folder (default: the top of Files) |
| `kortix drive cat <path>` | Print a file |
| `kortix drive put <local> <path>` | Upload a local file |
| `kortix drive mkdir <path>` | Create a folder |
| `kortix drive mv <from> <to>` | Move or rename |
| `kortix drive rm <path> [-r]` | Delete a file, or a folder with `-r` |
| `kortix drive access <path>` | Who has access to a folder, with grant ids |
| `kortix drive share <path> (--everyone \| --user <email> \| --agent <name>) [--write]` | Share a folder (read, or write) |
| `kortix drive unshare <path> <grantId>` | Stop one share |

- Every command takes `--json`.
- `kortix drive` works only in the user's own private session. In a shared,
  chat or scheduled session it answers 403: use the folders mounted in the
  session, or ask the user to make the change in Files.
- In a private channel's thread `kortix drive` writes only that channel's
  folder; everything else is read-only (403 on a write).
</commands>

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
