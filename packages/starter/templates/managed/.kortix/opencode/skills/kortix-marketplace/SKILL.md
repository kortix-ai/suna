---
name: kortix-marketplace
description: "The Kortix marketplace — how to discover capabilities and IMPORT them into this project. The marketplace is a catalog of open git repos: whole ready-made PROJECTS (registry:project) and individual skills/agents/tools. There is no deterministic 'installer' — you (the agent) import an item by reading its source and merging the files that fit into this project, then opening a change request. Use when the user wants to browse/search the Kortix catalog, 'add/clone the <X> project', 'import that skill/agent', pull in a marketplace capability, or add a new source. For the open npx-skills ecosystem, see find-skills-sh."
---

<skill name="kortix-marketplace">

The **Kortix marketplace** is the Kortix-native catalog. Every item is an **open
git repo** made of plain files — a whole clonable **project** (its `kortix.yaml`,
agents, skills, tools) or an individual **skill / agent / tool**. There is **no
deterministic installer, no version lock, and no update system**: you add an item
by **importing** it — reading its source and merging what fits into this
project's own files, then opening a change request. Everything you import becomes
**100% user-owned files** in this repo, exactly like any other code you write.

Why it works this way: the Kortix *system* layer (this `kortix-*` family, the
`kortix` CLI) is served live and always-latest, so it never goes stale. Marketplace
items are the opposite — they're *yours* to own and edit, so they're imported as
files, not pinned to an upstream that could clobber your changes.

<discovery>
Browse/search the catalog from the `kortix` CLI (already authenticated here):

```bash
kortix marketplace search "<query>" --json    # find items (parse the JSON)
kortix marketplace show <id> --json           # inspect one item: type, files, source repo
```

Read-only. There is no `install` / `update` / `remove` subcommand anymore —
adding an item is the import flow below.
</discovery>

<importing>
**The standard import recipe.** To add a marketplace item to this project:

1. **Get the source.** From `kortix marketplace show <id> --json`, take the item's
   source git repo/ref (or its inline files). Clone/read it in the sandbox.
2. **Detect what it is** from its file structure:
   - a `kortix.yaml` at the repo root → a **project** (agents + skills + tools +
     config),
   - a `SKILL.md` → a **skill**,
   - an agent definition (an `agents/*.md`) → an **agent**,
   - a tool file (a `tools/*.ts`) → a **tool**.
3. **Merge what fits into this project**, in the right place:
   - skills → `.kortix/opencode/skills/<name>/`,
   - agents → `.kortix/opencode/agents/`, tools → `.kortix/opencode/tools/`,
   - for a **whole project**: pull in its skills/agents/tools and reconcile its
     `kortix.yaml` into this project's (merge connectors/triggers/agents — never
     blindly overwrite the user's manifest). Use judgment; keep what's relevant.
4. **Adapt it to this project.** If a skill carries a "TODO: make this yours"
   placeholder or generic copy, tailor it to what this project actually does.
5. **Wire up its needs.** If the item requires a connector/secret, don't hardcode
   anything — mint a setup link (`kortix secrets request …` / the executor
   connect flow) and surface it to the user.
6. **Commit + open a CR.** `git add`/`commit`, `git push origin HEAD`, then
   `kortix cr open --title "Import <item>"`. The user reviews the diff and merges
   — that's how it becomes permanent (see `kortix-system` for the CR mandate).

Importing is just you reading files and writing files, landed through a change
request. No lock file, no tracked "installed" state — **git is the source of
truth** for what's in this project.
</importing>

<projects>
A whole **project** item is the richest thing in the marketplace — a working,
end-to-end Kortix project focused on a function. You can spin it up as its **own
new project** (from the web UI's "Add to a project" → new project, which seeds
the files deterministically), or **import/merge it into this existing project**
via the recipe above to make this project bigger. It's all just files.
</projects>

<adding-a-source>
To make another registry's items discoverable here, add it as a **source** — any
public git repo that ships `SKILL.md` files or a `marketplace.json` (e.g.
`anthropics/skills`, community repos from skills.sh). Curated sources enable in
one click; an arbitrary git URL is admin-gated. Once added, its items show up in
`kortix marketplace search`, and you import them the same way.
</adding-a-source>

<vs-find-skills-sh>
- **`kortix-marketplace`** (this) — the Kortix catalog: whole projects + skills/
  agents/tools, imported into this repo as owned files via a CR.
- **`find-skills-sh`** — the open `npx skills` / skills.sh ecosystem, for pulling a
  battle-tested community skill when the Kortix catalog doesn't have it.

Reach for the Kortix marketplace first for anything project-shaped; reach for
`find-skills-sh` to tap the wider open ecosystem. Either way you end up importing
plain files you own.
</vs-find-skills-sh>

</skill>
