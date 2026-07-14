# Marketplace as projects — two tiers, one CLI, no lock (spec)

**Status:** draft · **Date:** 2026-07-13 · **Owner:** Marko

## The idea

Stop presenting the marketplace as a wall of individual skill tiles. Present it
as a gallery of **projects** — clonable bundles that can carry skills, agents,
tools, whatever — with the **starter project** as the hero. Clicking it shows
everything inside via the file browser we just built, instead of N loose skills.

At the same time, collapse the plumbing. Make **`kortix-cli` the single,
server-side source of truth** for "how Kortix works / what's available" (the
agent-browser pattern we already use for the `kortix-*` system skills), and
**delete the entire deterministic install + update machinery** — registry-lock,
versioning, dependency resolution, the update system, all of it.

## Why now — the driving pain

Today a project's Kortix system skills are **committed files that go stale**. A
project cloned months ago carries an old `kortix-system` descriptor and never
learns the latest CLI/manifest/CR truth. That single problem is the whole reason
the update system was built — and it's the wrong fix. If the Kortix system layer
is **served live** (the CLI is the source of truth, and `kortix-cli` can even be
injected at the sandbox/agent-server level and edited via an MCP server, never
touching the user's repo), **no project is ever stale on Kortix internals again**,
and the update machinery has no remaining reason to exist.

## The reframe: two tiers, not one

The whole thing clarifies once you notice the catalog serves two populations
that want *opposite* things, and "updates" / registry-lock were mis-aimed at
both:

| | **System tier** (`kortix-cli`, `kortix-*`) | **Owned tier** (`generic-*`, `pdf`, `research`, …) |
| --- | --- | --- |
| Where it lives | **Server-side**, fetched live via the CLI | **A file in the user's git repo** |
| Freshness | Always-latest, ephemeral | Frozen at clone time |
| Edited by user? | No — it's platform truth | **Yes** — forked to fit their ops (the "TODO: make this yours" model) |
| Needs updates? | Yes, but **not registry-lock** — it's not committed, nothing to update | No — an auto-update would **clobber the user's fork** |
| Discovery | `kortix skills get` / `kortix marketplace …` | Present as files; read/diff/land via CRs |

The punchline: **registry-lock + `marketplace update` serve nobody well.** System
skills don't need a lock (they're server-side). Owned skills shouldn't *want*
updates (updates destroy forks). So the lock/update system can be retired — while
keeping the git-native "skills are owned files you edit" model for the owned tier.

Why the lock existed at all: it was added to update the Kortix system skills from
the marketplace. That requirement is now fully served by the server-side/CLI
path, so its reason for being is gone.

## What we keep (the moat — do not touch)

- **Owned domain skills stay git-native.** Scaffolded once into the project repo,
  owned, editable, forkable, versioned, landed via CRs. This is the moat and it's
  exactly what the `generic-*` "edit to fit your ops" design depends on.
- **Items are heterogeneous, recognized by file structure.** A marketplace item
  can be a whole **project** (its own `kortix.yaml` + agents + skills + tools), or
  a single **skill**, **agent**, or **tool** — we detect *what a repo is* from its
  files and the import agent wires it in accordingly. One import path for all of
  them. The richest items are **end-to-end projects** (web-studio-style, focused
  on a function) that you merge into your own project to make it bigger. It's all
  just files. (For now, keep the type-recognition simple; expand strategies later.)
- **The file-browser detail view** (`marketplace-file-view.tsx` /
  `marketplace-file-tree.tsx`) — it becomes the primary way to see "what's inside
  a project."
- **The catalog / discovery layer.** The marketplace still lists items — name,
  description, type, and a **source git repo/ref**. We delete the install
  *engine*, not the catalog. `search`/`show` stay.
- **A trivial deterministic seed** (`packages/starter` folder-copy). Not "the
  engine" — just the file write that makes a new repo a bootable Kortix project.
  Everything *added* to a project after that is an agent import.

## What we don't do (the trap)

**Do not server-side-ify the owned tier.** The temptation is "make *everything*
CLI-fetched like agent-browser." The moment a domain skill is served live instead
of being a file in the user's repo, we lose ownership, editability, CR-based
landing, and the whole fork-to-fit model. Keep the two tiers distinct.

## The three moves (safe → risky)

### 1. Marketplace = gallery of projects, starter project as hero
Presentation only; no mechanics change.
- Catalog surfaces **projects** as the primary browse unit; the starter project
  is the hero. Individual skills stop being top-level tiles and become "what's
  inside" a project.
- **Typed presentation — don't flatten skills into a file dump.** Inside a
  project, a skill must still read as a *skill*, an agent as an *agent*, a tool as
  a *tool* — the same rich per-type cards/UX we have today, driven by the
  file-structure recognition above. The file browser is the raw/secondary view;
  the **typed** view (contents grouped by detected type) is the default. This is
  generalizable: "what's inside a project" = its files bucketed by type, each
  bucket rendered with its existing component.
- Touch: `apps/api/src/marketplace/catalog.ts` (`isBrowseableCatalogItem`,
  `MARKETPLACE_VISIBLE_TYPES`, `buildProjectTemplateRegistry`), and the web
  explore/grid/card surface. The starter needs to exist as a `registry:project`
  hero item (the general-knowledge-worker kit as a browsable project).
- Risk: low. Reversible. Ships value immediately and sets up 2–3.

### 2. `kortix-cli` as the always-injected front door
- The one always-present skill: "install the CLI; ask it for anything; it's
  always current." Everything system-level is retrieved live. Extends the
  existing managed pattern (`KORTIX_MANAGED_SKILL_NAMES` in
  `packages/starter/src/index.ts`).
- **Guaranteed present, not merely shipped.** It's shipped as a default
  owned-layer skill, but the real guarantee is that the **sandbox/agent-server
  injects it (and/or a Kortix-MCP) into every agent**, always-latest. Every agent
  therefore has Kortix context no matter what — even if the repo copy is deleted,
  the injected layer still provides it. That injected `kortix-cli`/MCP is *the*
  one thing Kortix always guarantees to every agent.
- Touch: the `kortix-cli` skill copy (done this session) + the sandbox/agent-server
  injection point + `kortix skills get` / `kortix marketplace` read surface.
- Risk: low–medium (adds a runtime injection point).

### 3. Delete the deterministic install engine — install becomes an agent import
The real change, and it goes further than "drop the lock." A marketplace item is
just a **discoverable open git repo**. **Installing = an agent clones/reads that
repo and self-merges it** into the project's own files (skills/agents/tools/
`kortix.yaml`), then opens a CR. No deterministic file-copy, no
`registry-lock.json`, no versioning, no dependency engine, no update detection.
Everything that lands is 100% user-owned files, integrated by judgment — the
same way the agent already writes any other code.

- **Delete outright:**
  - `packages/registry/src/{install,lock,schema}.ts` (the plan/build/apply +
    lock + dependency machinery) and its re-exports in `index.ts`.
  - `apps/api/src/marketplace/install-service.ts` (`buildInstall`,
    `buildInstallBatch`, `resolveItemFiles`, update/hash-compare).
  - CLI subcommands `install`/`add` (deterministic), `updates`/`outdated`,
    `update`, `remove`/`rm`, and lock-based `status`/`installed` in
    `apps/cli/src/commands/{marketplace,marketplace-install,registry,skills}.ts`.
    Keep `search`/`show` (discovery) — install becomes "hand this repo to an agent."
  - The web **Upgrades / Installed** update surface
    (`marketplace-installed-panel.tsx`, lock reads in `marketplace-surface.tsx`;
    the upgrades section from PR #4207).
  - `registry-lock.json` writing in `apps/api/src/projects/{seed-files,
    templates/apply-template,routes/r10}.ts`.
- **What replaces "install":** a first-class **agent import** action — the
  marketplace "Add to project" hands the item's source repo/ref to a session
  ("import <repo> into this project"), the agent clones it into the sandbox,
  reads it, merges what fits, and opens a CR. For a **new project from a
  template**, seeding can stay a plain deterministic file-copy of the template
  repo (no engine, no lock); merging **into an existing** project is agent-driven.
- **Blast radius (grep):** `packages/registry/src/*`,
  `apps/api/src/marketplace/install-service.ts`,
  `apps/api/src/projects/{seed-files,templates/apply-template,routes/r10,git/branches,lib/access}.ts`,
  `packages/sdk/src/core/rest/projects-client/marketplace.ts`,
  `apps/web/src/features/marketplace/{marketplace-surface,marketplace-installed-panel}.tsx`,
  `apps/cli/src/commands/{marketplace,marketplace-install,registry,skills}.ts`.
- Risk: high (deletes a whole subsystem across CLI + API + web + SDK). Needs the
  migration + the considerations below.

## How far to nuke determinism — copying files ≠ the engine

Fair challenge: why keep *anything* deterministic? The trap is conflating two
different things:

- **The install *engine*** — plan / resolve-deps / lock / version / update /
  hash-compare (`packages/registry`, `install-service.ts`). This is the complex
  machinery, and the source of the stale-descriptor pain. **Nuke it entirely.**
- **Copying a folder of files into a new repo** — this is *not* the engine. It's
  a trivial file write we already do (`getStarterFiles`): no lock, no deps, no
  versioning, no agent.

So there's no contradiction with "it's all just files." A brand-new project needs
*some* seed to be a valid Kortix project a session can boot in (a `kortix.yaml` +
runtime wiring) — chicken-and-egg: no agent exists yet to do the importing. That
seed is a plain deterministic folder-copy, and the runtime/`kortix-cli` layer is
server-injected on top (Move 2).

The split (decided):

| Action | Mechanism | Why |
| --- | --- | --- |
| **New project (default)** | **agent creation** — a minimal bootable seed, then an agent session that imports the starter + tailors it to the user (an onboarding/personalization prompt) | creation doubles as onboarding; the project arrives already specific to you, and never stale |
| **New project (fast path)** | deterministic copy of the starter folder | instant, free, vanilla kit — kept as an available option |
| **Add a marketplace item to an *existing* project** | **agent import** (clone → read → wire in → CR) | judgment + adaptation; one path for skills, agents, tools, whole projects |

Both creation paths exist; the **default is agent creation** — it folds
onboarding + personalization into creation (the agent adapts the starter to what
the user says they're doing, right from the marketplace) and keeps projects from
going stale. The deterministic clone stays as the fast/vanilla option. Either way
a minimal deterministic **seed** boots first (chicken-and-egg: something must
exist before an agent can run), and the `kortix-cli`/MCP layer is server-injected
on top (Move 2).

## Considerations / tradeoffs

- **Non-determinism.** Two imports of the same item may differ (agent judgment).
  Acceptable for a deliberate "add to my project" action; the trivial new-project
  seed stays a deterministic copy so creation isn't at the mercy of a model.
- **Cost + latency.** Every import spends an agent turn (LLM + sandbox) vs an
  instant copy. Fine for an intentional add; the new-project seed is a free copy.
- **Security.** Importing = an agent reading + merging an *arbitrary* git repo.
  The safety boundary is the **sandbox + CR review** (nothing lands on `main`
  without the user approving the diff), plus the existing SSRF guard in
  `apps/api/src/marketplace/catalog.ts`. Untrusted-repo import must stay CR-gated.
- **Dependencies.** No more registry dependency resolution — the source repo
  declares what it needs (in its own README/manifest) and the agent wires it up
  (connectors/secrets via the setup-link flow).

## Migration / back-compat

- Existing `registry-lock.json` files in user repos become **inert** — we stop
  reading/writing them; no need to delete them. No data migration. (Git is the
  only source of truth for "what's in the project" now.)
- Public API + SDK: the deterministic install / `updates` / `update` / `remove`
  routes + `packages/sdk/.../marketplace.ts` methods are **removed** (or 410'd
  first). "Add to project" becomes: start/continue a session with an import task.
- `buildProjectSeedFilesFromItem` is reduced to a plain deterministic copy of a
  template repo for the **new-project-from-template** case; merge-into-existing
  moves to the agent path.

## Decisions (settled 2026-07-13)

1. **Landing:** Starter Project as the **hero**. A shelf of other end-to-end
   projects is supported structurally but **empty for now** — `web-studio` stays
   **unpublished/hidden**. Clicking into a project renders its contents **typed**
   (skills as skill cards, agents as agents, tools as tools) with the existing
   per-primitive UX — not a flat file dump.
2. **Creation:** default = **agent creation** (onboarding/personalization import);
   keep the **deterministic clone** as an available fast path. Minimal seed boots
   either way.
3. **Import:** a **standard import skill** (folded into `kortix-marketplace`) drives
   every add — detect type → place files → adapt TODOs → wire connectors → CR.
4. **File-type recognition:** v1 = simple conventions (`kortix.yaml`⇒project,
   `SKILL.md`⇒skill, agent file⇒agent, tool file⇒tool); extensible recognizer.
5. **Sequencing:** build it all **on the current PR #4493 as one big PR**; do
   **not** merge yet.

## Non-goals

- Not changing the CR system or the git-native ownership of the owned tier
  (that's the moat we're leaning *into*). The one intentional runtime addition is
  injecting `kortix-cli`/Kortix-MCP into every agent (Move 2).
- Not auto-updating owned skills — deliberately dropped, not deferred.
- Not building a deterministic install engine "lite." The engine is deleted;
  adds are agent imports; the only deterministic thing is a folder copy.
