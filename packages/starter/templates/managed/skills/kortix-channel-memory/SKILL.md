---
name: kortix-channel-memory
description: "Memory of a channel or DM thread: pages in 3 layers (company, this channel, you + this agent), read from the read-only copy at `/opt/kortix/memory/` and saved only with the `remember` tool. Load at the start of a thread in a channel or DM, when the user says remember / note / you should know, and when you learn something the next thread there should know."
metadata:
  kortix-feature-flag: project_channels
---

<skill name="kortix-channel-memory">

<layers>
A thread in a channel or a DM has memory: pages that people edit in the
Memory tab and that agents read and save. Pages live in 3 layers:

| Layer | Folder in the copy | Who reads it | `remember` `layer` |
| --- | --- | --- | --- |
| Company | `/opt/kortix/memory/company/` | every member, every thread of the project | `company` |
| This channel | `/opt/kortix/memory/channel/` | every member, every thread of the channel | `channel` (the default in a channel thread) |
| You + this agent | `/opt/kortix/memory/personal/` | only the user, in their DM with this agent | `dm` (the default in a DM thread) |

A thread sees only its own layers. A folder that is missing has no pages
yet or is not part of this thread. In a private channel thread, `personal/`
can hold the user's DM pages with this agent: read them, but save to them
only from the DM.
</layers>

<read>
At the start of the thread, read `INDEX.md` in each folder under
`/opt/kortix/memory/`. It lists every page, one line each:
`- <title> — <summary> (<file>)`, grouped as People, Decisions,
Workstreams, Playbooks and Notes to file. Open a full page from its file
when the task needs it. The `[label]` after a fact names its source.

The folder is read-only. Kortix rewrites it at the start of every turn and
after each `remember` call. A file you write there is lost. When you have
the `memory_search` tool, use it for a page the list does not show.
</read>

<save>
Save with the `remember` tool, in the same turn you learn the fact:

- **One topic per page.** `title` names the topic: a person ("Priya"), a
  decision, a workstream ("Q4 launch"), a playbook. A call with the title of
  an existing page adds to that page; a new title makes a new page.
- **One fact per call**, in `fact`. Send `body` (the whole page in Markdown)
  only to rewrite a page. Give exactly one of the two.
- **`type`**: `people`, `decisions`, `workstreams` or `playbooks`. An
  existing page keeps its type.
- **`summary`**: one line, 200 characters at most. It is the page's line in
  `INDEX.md`.
- **`section`**: the `## ` heading the fact goes under ("Status", "Who does
  what", "Next steps"). It is made when missing.
- **`outside`**: set `{ label, url? }` for a fact from a web page, an email,
  a file or a connector, not from the people in this thread.
- Facts only. Never a secret, a password, a key or a token: the call is
  refused.
- Never a person's private facts in the channel or company layer. Keep them
  in the DM layer from a DM thread, or in `/drives/me/Memory/` (the
  `kortix-user-memory` skill).

Pages under "Notes to file" are sentences people saved in the Memory tab.
File each one into a real page: call `remember` with that page's `title`,
`type`, the fact in `fact`, and `from_note_id` set to the note's `page_id`
(in the note file's header). The note is deleted in the same change, and one
Undo restores both.

A refusal comes back as `Error: <code>: <message>`. Fix the call and retry
once; on `page_too_large` or `page_limit`, tell the user.
</save>

<not-this>
Two other memories are different things. Do not mix them up with this one:

- `memory/` in the project's repository is the project brain (the
  `kortix-memory` skill).
- `/drives/me/Memory/` is what you keep about the user across all their
  threads (the `kortix-user-memory` skill).
</not-this>

</skill>
