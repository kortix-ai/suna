---
name: kortix-memory
description: How to read, write, and curate project memory in `.kortix/memory/` — the project brain. Load this skill whenever you (or the memory-reflector agent) need to add, update, or reorganize what this project knows about itself. Defines the rubric for what belongs in memory, the file structure, and the change-request flow for landing memory edits on `main`.
---

<skill name="kortix-memory">

<overview>
Every Kortix project has a **project brain** at `.kortix/memory/` — a
folder of curated markdown files describing what this project is,
which integrations it talks to, the conventions the team works by, and
the decisions worth not re-litigating.

`MEMORY.md` is the **index**. Memory is **not** auto-injected into the
prompt — the **memory protocol** is: at the start of a task, `view`
`.kortix/memory` with the `memory` tool to read the index and recover
prior context, then `view` the sub-files (`overview.md`,
`integrations.md`, etc.) the index points at when they're relevant.
Record anything durable as you go — your context window may reset at
any time, so what isn't written to `.kortix/memory/` is lost.

Memory is **continuously CRUD'd**:

- Regular sessions add or update memory whenever they discover
  something durable worth keeping.
- The `memory-reflector` agent (`.kortix/opencode/agents/memory-reflector.md`)
  runs on a cron, surveys recent activity, and curates the folder.
- Both consult this skill for the rubric.

Memory is **team-shared**: it lives in the repo, every session sees the
same content. Edits land on `main` only via a Kortix change request —
never by pushing directly.
</overview>

<when-to-load>
Load this skill when you:

- Discover a project convention, integration detail, decision, or
  workaround that should outlast this session
- Notice the project brain is out of date or contradicts current code
- Are the `memory-reflector` agent doing your scheduled reflection run
- Want to know if something is worth writing down (use the rubric below)
- Need to add, rename, split, or delete a memory file
- Want to know how memory edits reach `main`

Skip this skill for one-off questions about *operating* code. Project
memory is about durable knowledge, not session state.
</when-to-load>

<file-layout>
```
.kortix/memory/
├── MEMORY.md           Index. `view` this first. One line per sub-file.
├── overview.md         What this project IS — purpose, shape, stakeholders.
├── integrations.md     Third parties, MCP servers, channels, executor connectors.
├── conventions.md      Coding patterns, naming, do / don't, style decisions.
└── decisions.md        Architectural and business decisions worth not re-debating.
```

Add new files freely when a topic deserves its own page (one topic per
file, kebab-case filename). **Always** keep `MEMORY.md` in sync — one
line per sub-file, format:

```
- [filename.md](filename.md) — one-line hook of what's inside
```

Don't move content out of `MEMORY.md` if it's a single line that
already lives in the index — keep that one line. Sub-files exist when
there's enough depth to warrant a click.
</file-layout>

<rubric>

### What to remember (KEEP)

- **The project's purpose** — what we're building, for whom, and the
  one-sentence pitch.
- **Architecture-level decisions** — why we use X over Y, which
  service owns what, the data flow.
- **Integration details** — which third parties / MCP servers /
  channels are wired, what credentials they need, how they're scoped.
- **Conventions** — naming, code style, branching, review norms — the
  stuff that's *de facto* across the codebase but not stated.
- **Workarounds and quirks** — known env issues, ordering constraints,
  flaky dependencies, gotchas that bit us once.
- **Ops runbooks** — how to deploy, how to roll back, how to debug the
  thing that breaks every quarter.
- **Glossary** — domain terms specific to this project that an
  outsider wouldn't know.
- **People & ownership** *(optional)* — who owns which surface, how to
  reach them, what they care about.

### What NOT to remember (DROP)

- One user's personal preferences — those are not project memory.
- Facts derivable from the repo layout, file names, or `git log`.
- One-off task state that won't matter next week.
- Anything that's already in `kortix.toml`, `AGENTS.md`, or a SKILL.md.
- Secrets, tokens, API keys, PII — those live in the Kortix Secrets
  Manager, never in memory files.
- Speculation about future plans. Memory describes what *is*, not
  what might be.

### Style for entries

- **Plain prose** with short sentences.
- **State facts, not narratives** — "The web app talks to Supabase
  Postgres for auth" beats "We decided to use Supabase…".
- **Cite file paths** when the fact maps to code: `path/file.ts:120`.
- **Date hard-to-verify facts** in `YYYY-MM-DD` so readers can judge
  staleness.
- **Prefer editing existing entries** over piling new ones on. A
  bloated file is worse than a tight one.

</rubric>

<writing>

### The `memory` tool

Use the dedicated **`memory` tool** for everything under
`.kortix/memory/` — not the generic `read` / `edit` / `write` tools.
It's a 1:1 port of Anthropic's memory tool, sandboxed to the memory
folder, with the same six commands:

| command | what it does |
|---|---|
| `view` | List the memory dir (2 levels) or read a file with line numbers (optional `view_range`). **Run this first, every task.** |
| `create` | Create a new file (`path`, `file_text`). Errors if it already exists. |
| `str_replace` | Replace a **unique** snippet (`path`, `old_str`, `new_str`). |
| `insert` | Insert text at a line (`path`, `insert_line`, `insert_text`). |
| `delete` | Remove a file or directory (`path`). |
| `rename` | Move/rename (`old_path`, `new_path`). Won't overwrite. |

Paths are repo-relative and must start with `.kortix/memory`
(e.g. `.kortix/memory/overview.md`). Writes go straight into the real
`.kortix/memory/` folder, so they show up in the working tree and land
on `main` through the normal change-request flow (below).

1. `view` `.kortix/memory` to see what's there.
2. Identify the right file. Most additions fit `overview.md`,
   `integrations.md`, `conventions.md`, or `decisions.md`. `create` a
   new file only when a topic deserves its own page.
3. Edit with `str_replace` / `insert`. Keep entries short, factual, and
   consistent with the surrounding prose.
4. If you added, renamed, or deleted a file, update `MEMORY.md` so the
   index matches the folder. The index is the table of contents every
   agent reads first — keep it accurate.
5. If something turned out to be wrong, `delete` it. Don't leave stale
   facts to confuse future agents.

### Landing memory on `main`

Session branches die when sessions end. Memory edits reach `main`
only via a Kortix change request — same path as any code change:

```sh
git add .kortix/memory
git commit -m "memory: <one-line summary of what changed>"
git push origin HEAD
kortix cr open \
  --title "memory: <one-line summary>" \
  --description "What changed and why."
```

The user reviews and merges. Don't merge your own CR.

</writing>

<reflector>

The `memory-reflector` agent
(`.kortix/opencode/agents/memory-reflector.md`) is a thin wrapper
around this skill — its job is to:

1. Load this skill.
2. Survey recent project activity (git log since last run, recent
   merged CRs, the active session transcript if invoked from one).
3. Decide what's worth keeping per the **rubric** above.
4. CRUD `.kortix/memory/` accordingly.
5. Open a single CR titled `memory: …`.
6. Exit silently if nothing is worth changing.

To change *what the reflector remembers*, edit the **rubric** section
of this skill. The reflector reads it fresh every run, so a merged CR
to this file takes effect on the next reflection.

To change *when the reflector runs*, edit the `[[triggers]]` block
named `memory-reflector` in `kortix.toml`. The cron sweep picks up
changes within a few seconds of the CR merging.

</reflector>

<gotchas>

- **The index is read first; sub-files are on demand.** Don't dump
  every fact into `MEMORY.md` — keep it a clean table of contents and
  push depth into sub-files the agent `view`s only when relevant.
- **`view` your memory before you start.** Nothing is auto-injected;
  if you skip the `view`, you work blind to what the project already
  knows. The `memory` tool's description and the agent rules say the
  same thing — this is the memory protocol.
- **Memory files are markdown, not databases.** Avoid heavy
  formatting, tables of 50 rows, or auto-generated content. If you
  catch yourself writing a script to generate a memory file, that
  content probably belongs in code, not memory.
- **Memory edits must go through CR.** Direct pushes to `main` bypass
  the user-review contract — the same rule as code. The reflector
  agent enforces this by always ending with `kortix cr open`.
- **Don't put secrets in memory.** Memory is read into context and
  committed to the repo. Secrets, tokens, API keys, and PII belong in
  the Kortix Secrets Manager, surfaced as env vars at runtime — not in
  `.kortix/memory/`.

</gotchas>

</skill>
