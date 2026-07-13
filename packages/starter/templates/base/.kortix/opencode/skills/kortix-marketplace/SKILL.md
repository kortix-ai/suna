---
name: kortix-marketplace
description: "The Kortix marketplace — how to discover and add capabilities to a Kortix project: install skills, clone or merge whole ready-made PROJECTS (registry:project), add new git sources (any SKILL.md / marketplace.json repo, e.g. skills.sh, anthropics/skills), and check for/apply updates. Use when the user wants to browse/search the Kortix catalog, install a skill or a full project into a project, 'add a source', 'clone the <X> project', enable another registry, or update installed marketplace items. For the open npx-skills ecosystem specifically, see the find-skills-sh skill."
---

<skill name="kortix-marketplace">

The **Kortix marketplace** is the Kortix-native catalog. It's deeper than a
skill index: it carries **skills**, whole clonable **projects**
(`registry:project` — a full working Kortix project you spin up in one step),
and any **source** you point it at. Everything installs by committing files into
a project's git repo (git owns the state — see `kortix-system`), and every
marketplace source is just a git repo, so the catalog is fully extensible.

<what-is-in-it>
- **Skills** — add reusable know-how to a project (`.kortix/opencode/skills/…`).
- **Projects** (`registry:project`) — clone a complete, working project (its
  `kortix.yaml`, agents, skills) as a **new** project, or merge it into one you
  already have.
- **Sources** — extra registries (a GitHub repo / git URL with `SKILL.md` or a
  `marketplace.json`) whose items merge into the catalog. The curated sources
  (Anthropic, OpenAI, and the rest) are one-click; any public repo can be added.
</what-is-in-it>

<cli>
Drive it from the `kortix` CLI (already authenticated in the sandbox):

```bash
kortix marketplace search "<query>"     # search the catalog (add --json to parse)
kortix marketplace show <id>            # inspect one item (type, files, capabilities)
kortix marketplace install <id>         # install into THIS project (commits its files)
kortix marketplace status               # what's installed here
kortix marketplace updates              # which installed items are outdated
kortix marketplace update [<name>]      # update one / all
kortix marketplace remove <name>        # uninstall (commits a removal)
```

Installing is a git commit into the project repo — no hidden runtime state. Use
`--json` on reads and parse that, don't scrape the tables.
</cli>

<projects>
A whole-project item is spun up as its **own** project (its config seeded in),
not dropped into an existing one — that's the marketplace's main growth path.
From the web UI, "Add to a project" lets the user pick an existing project or a
new one, and choose to set it up with an agent (recommended — a session installs
it and wires up connectors/secrets) or add the files directly. Merging a whole
project into an *existing* one is agent-driven (it can't blindly overwrite that
project's `kortix.yaml`).
</projects>

<adding-a-source>
To make another registry's items available in this project's catalog, add it as
a source — any public git repo that ships `SKILL.md` files or a
`marketplace.json` works (e.g. `anthropics/skills`, `openai/…`, community repos
from skills.sh). Curated sources enable in one click; an arbitrary git URL is an
admin-gated action. Once added, its skills/projects show up in search and
install like any other catalog item.
</adding-a-source>

<vs-find-skills-sh>
- **`kortix-marketplace`** (this) — the Kortix catalog: skills **and** whole
  projects, installed through the platform (git-committed, tracked in
  `registry-lock.json`, updatable, agent-set-up).
- **`find-skills-sh`** — the open `npx skills` / skills.sh ecosystem, for pulling a
  battle-tested community skill when the Kortix catalog doesn't have it.

Reach for the Kortix marketplace first for anything project-shaped or that
should be tracked/updatable in this repo; reach for `find-skills-sh` to tap the
wider open ecosystem.
</vs-find-skills-sh>

</skill>
