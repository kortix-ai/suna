# The Kortix Marketplace — philosophy & production architecture

This is the "why" behind `@kortix/registry`. It defines what a production-grade
Kortix marketplace *is*, the invariants it must never break, and the decisions
that make it safe to let strangers publish things other people install.

> One-line thesis: **Git hosts the goods, the lock is the truth, Kortix is the
> index — and nothing installs without the user seeing exactly what it does.**

The north star is **Go modules / Homebrew taps / GitHub Actions**, not npm. In
those systems the *source repo* is the unit of distribution, you pin by ref, the
contents are content-hashed, and the central service is an *index + checksum
authority* — not a file host. That model is decentralized, tamper-evident, and
cheap to run. npm's centralized tarball host is the thing we deliberately avoid
becoming.

---

## Part 1 — First principles (the seven invariants)

Everything below derives from these. If a feature violates one, it's wrong.

1. **Git is the registry; Kortix is the index.** Items live in their authors'
   GitHub repos. The marketplace stores *metadata and trust signals*, never the
   files. This keeps us decentralized, removes us as a supply-chain bottleneck,
   and means the gallery is a thin catalog over the exact registries the CLI
   already installs from.

2. **One primitive.** A skill, agent, command, tool, trigger, connector, file,
   folder, rules doc, or whole project are the *same shape* — a registry item
   with a `type` and a list of `files` with `target`s. Bundles are just items
   whose payload is `registryDependencies`. Build the engine once; everything
   rides it.

3. **Install is a commit, not a side effect.** `kortix marketplace install`
   writes files into the project's repo and they get committed. No hidden runtime state, no
   service you depend on at runtime. The result is **diffable, reviewable,
   reversible (`git revert`), and self-contained.** This is the shadcn ethic:
   you own the source after install.

4. **The lock is the truth.** `registry-lock.json` records, per installed item,
   the source address *and a content hash of every file*. "What you have" is
   defined by the lock, not by a version string a publisher can lie about.
   Reproducible, tamper-evident, drift-detectable.

5. **Source over binary.** We distribute readable files (SKILL.md, .ts tools),
   never opaque blobs. Auditable before and after install. A reviewer — human or
   model — can read exactly what a skill will tell the agent to do.

6. **Progressive trust, least privilege.** Three rings — *your repo* (you typed
   the address), *your company* (org-trusted), *the world* (curated/verified).
   Capability and review requirements tighten as the blast radius widens.

7. **Consent before capability.** An item *declares* what it needs (secrets,
   connectors, network, tools) and the user *approves* that at install. No skill
   silently gains access to a secret or a connector. (Part 5.)

---

## Part 2 — Three layers (this resolves "should the core be registry-managed?")

Not everything should be a marketplace install. There are three concentric
layers, and the core belongs to the inner two.

```
┌─ Layer 3: MARKETPLACE ─ everyone's registries ─ marketplace install item ───┐
│  optional, opt-in, the 64 GKW skills + community skills/agents/bundles       │
│ ┌─ Layer 2: STANDARD LIBRARY ─ first-party @kortix/* registry ─────────────┐ │
│ │  official, curated, updatable: the Kortix-managed runtime skills + packs │ │
│ │ ┌─ Layer 1: RUNTIME FLOOR ─ baked into the starter scaffold ───────────┐ │ │
│ │ │  kortix-system, kortix-memory, executor/slack/computer, agent-browser │ │ │
│ │ │  them with ZERO network. A project must boot before any registry.    │ │ │
│ │ └──────────────────────────────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Layer 1 (Runtime floor):** the absolute minimum every project must have to
  function. **Baked into the starter, installed offline by `kortix init`.** It
  must never require a live registry — otherwise project creation depends on a
  service being up. This is the floor.
- **Layer 2 (Standard library):** the official `@kortix/*` registry. The core
  *is also published here* so an existing project can **update** it
  through the managed update workflow and so the same files have a single
  canonical source. Baked for bootstrap, marketplace-addressable for updates.
  Both, not either.
- **Layer 3 (Marketplace):** everyone else. Opt-in, curated at the global tier.

**Verdict:** the core is *registry-addressable* (Layer 2) but *scaffold-delivered*
(Layer 1). You don't force the floor through the network. "Everything is a
registry item" is true as a *data model*; it is not true as a *delivery
requirement*.

### Current Kortix-managed contract

The current Kortix-managed set is intentionally small:

- `kortix-system`
- `kortix-memory`
- `kortix-executor`
- `kortix-slack`
- `kortix-computer`

These are first-party runtime skills. They are baked into the starter so a new
project boots with no marketplace/network dependency, and they are also exposed
as marketplace items so existing projects can be inspected and updated through
the same install/update machinery.

Not Kortix-managed today:

- Default agents (`kortix`, `memory-reflector`)
- `agent-browser`
- OpenCode config files (`opencode.jsonc`, `package.json`, `bun.lock`)
- PTY/tools (`show`, `memory`, `web_search`, `scrape_webpage`, `image_search`)
- General Knowledge Worker skills

Those may be in the starter floor, but they do not carry `managedBy: "kortix"`
or `updatePolicy: "kortix-managed"` until the update workflow owns them.

### Kortix-managed update policy

Kortix-managed updates should be **git-level change requests**, not silent
sandbox-start mutations.

1. A project records installed/managed files in `registry-lock.json`.
2. A scheduled updater or explicit command compares the lock hash/source to the
   current Kortix-managed source.
3. If files changed, Kortix creates a normal branch and commit containing only
   the managed file updates.
4. Kortix opens a change request with the diff, source ref, changed file list,
   and any migration notes.
5. The project only changes when that CR is merged.

Sandbox start may detect and report that a managed update is available, but it
must not rewrite project files. Runtime boot must stay deterministic from the
checked-out git state.

---

## Part 3 — The object model

**Item.** The atom. `name`, `type`, `files[]` (`path` → `target`), plus
`registryDependencies`, `envVars`, `categories`, `meta`. Identity within a
registry is `name`; globally it's `registry-namespace + name`.

**Registry.** A repo with a `registry.json` (or a JSON endpoint). Composable via
`include`. Namespaced (`@kortix`, `@acme`).

**Versioning — lean on git, pin by hash.** A "version" is a **git ref**
(branch / tag / sha). A "release" is a tag (`@v1.2.0`). Integrity is the
**content hash** in the lock (like `go.sum`, not like an npm version string).
Rules:
- Unpinned install (`owner/repo/item`) resolves the default branch *now* and
  **pins the resolved sha + hash in the lock**. Reproducible thereafter.
- Pinned install (`owner/repo@v1/item`) is explicit and stable.
- `kortix update <item>` re-resolves the ref → new hash → **shows a diff** →
  applies on confirm. Updates are visible commits, never silent.
- A publisher *may* set `meta.version` for display, but it is **never** the
  integrity source — the hash is.

**Dependencies.** `registryDependencies` form a DAG resolved transitively and
deduped (already implemented). Cross-registry deps use full addresses. A bundle
is an item that is *only* dependencies — the unit of "install a whole use-case."

**Deprecation & yank.** `meta.deprecated: "reason / successor"` shows a warning
on install/list. A **yank** (security) is an index-side flag that makes the
gallery refuse to surface it and `kortix marketplace install` warn loudly — but because files
live in the author's repo, yanking is *advisory at the source*, *enforced at the
index*. (Another reason index-not-host is honest: we can de-list, not rewrite
history we don't own.)

---

## Part 4 — Distribution & resolution

**Addressing** (already built): `owner/repo[@ref]/item`, `@ns/item`,
`./local#item`, `https://host/r/item.json`, bare `item` (against a default).

**Index, don't host (the central decision).** The global marketplace is a
**catalog of registries + a checksum/trust authority**, modeled on Go's
proxy + `sum.golang.org`:
- Authors **submit a repo URL**; Kortix crawls + validates its `registry.json`,
  denormalizes the items into a searchable index, and records a checksum.
- The gallery's "Add to project" runs the **same install** the CLI does, from
  the **author's repo**. Kortix never re-hosts the files.
- Optional **read-through proxy/cache** (like Go's GOPROXY) for availability +
  to survive an author deleting a repo — cache is keyed by hash, so it can't
  serve different bytes than what was indexed.

**Private & company registries.** Public GitHub registries resolve over raw
URLs. Private/company repos resolve through the **existing Kortix git-proxy**
(`/v1/git/:projectId/*`), which authorizes with the caller's Kortix token and
mints short-lived host credentials server-side — the real GitHub token never
reaches the client. This is the piece plain shadcn *can't* do and our biggest
structural advantage: **auth'd, private, company-scoped registries for free.**

**Caching.** Resolve results (registry.json, item JSON, file bytes) are cached
by `(source, sha)`. Immutable once pinned. Cheap.

---

## Part 5 — Trust, safety, supply chain (the production heart)

This is the part that makes it safe to let strangers publish. A Kortix item is
not inert data: a skill is **instructions an autonomous agent will follow**, and
a tool is **code that runs in the session sandbox** with the project's
`KORTIX_TOKEN`, connectors, and secrets. The threat model is real:
prompt-injection-style skills, tools that exfiltrate secrets or abuse a
connector, and network egress.

### 5.1 The capability manifest + consent (the single most important feature)

Every item **declares its capabilities**, and the user **approves them at
install**. Nothing is granted silently.

```jsonc
"meta": {
  "capabilities": {
    "secrets":    ["OPENAI_API_KEY"],          // env it reads
    "connectors": ["gmail", "slack"],          // integrations it calls
    "network":    ["api.openai.com"],          // egress it expects (allowlist)
    "tools":      ["web_search"],              // tools it invokes
    "writes":     ["@skills/", "@memory/"]     // where it writes
  }
}
```

On install the CLI/gallery shows: *"`cold-email` wants: your `OPENAI_API_KEY`,
the Gmail connector, and network to api.openai.com. Allow?"* This is the
permission-dialog model (mobile apps, OAuth scopes, browser extensions) applied
to agent capabilities. It converts "others push shit" from *trust the author*
into *trust nothing, approve explicitly*.

### 5.2 Containment is the backstop

Capabilities are declared, but **enforcement leans on what's already true**: a
skill executes inside the **isolated session sandbox** (its own container,
project-scoped token). The blast radius of a malicious item is **one project's
sandbox + the connectors/secrets that project already holds** — not the user's
machine, not other projects, not the platform. The marketplace's job is to keep
that radius *informed and consented*, not to invent new isolation.

### 5.3 Static gates before listing

At submit/index time, automated checks (a model reviewer is well-suited here):
- **Secret scanning** — refuse items that embed credentials.
- **Capability honesty** — diff declared capabilities vs. what the files
  actually reference (a tool that hits a domain not in `network` → flagged).
- **Dangerous-pattern scan** — tool code that reads `KORTIX_TOKEN` and POSTs it
  out, obvious exfiltration, `curl | sh`, etc.
- **Schema + install dry-run** — `registry validate` must pass; a sandboxed
  dry-run must produce only in-`target` writes.

### 5.4 Provenance & integrity

- **Content hashes** in the lock (built) → tamper-evident installs.
- **Pin-by-sha** on unpinned installs → reproducible.
- **Signed provenance** (roadmap): publishers sign releases (sigstore-style);
  the index records the signature; `kortix marketplace install` can require verified provenance
  at the global tier.
- **Publish cooldown.** Mirror the supply-chain defense **this repo already runs
  in pnpm** (`minimumReleaseAge: 4320` — a 72h cooldown that defeats
  publish-and-yank account-takeover attacks like Shai-Hulud / TanStack). A newly
  published global item is installable by name immediately *only* if pinned;
  the *floating* "latest" lags by a cooldown so a compromised publisher can't
  instantly poison everyone on `@latest`.

### 5.5 Naming attacks

- **Typosquatting:** namespaces (`@kortix/pdf` vs `randoguy/pdf`) + verified
  publishers + the gallery ranking official/verified above community.
- **Dependency confusion:** a company namespace (`@acme/*`) always resolves to
  the company registry first; a public item can never shadow it.

### 5.6 Trust tiers (who can publish what, with how much review)

| Ring | Who | Review | Capability ceiling |
|---|---|---|---|
| **Repo** | anyone, their own repo | none (you typed it) | unrestricted (your risk) |
| **Company** | org members → org registry | org policy / optional review | org-approved connectors/secrets |
| **Global – community** | anyone, after submit | automated gates (5.3) + cooldown | must declare caps; secrets need consent every install |
| **Global – verified** | verified publishers | automated + human spot-check + signed | may be allowlisted for one-tap installs |

---

## Part 6 — Listing & ownership

**Listing = make a repo reachable, then (for global) submit it to the index.**

1. `kortix registry build` -> `registry.json` -> `git push`. *(Repo tier done now.)*
2. **Company:** push to the org registry repo; appears in **Customize → Add**.
3. **Global:** the Marketplace submission flow takes the **repo URL + chosen
   namespace**. Kortix validates, runs static gates,
   indexes the items, records the checksum, and lists them.

**Ownership & names.** A **namespace** (`@acme`) is claimed once, tied to a
Kortix account/org, and verified by proving control of the repo (a file or a
GitHub App grant). Item names are unique within a namespace. **Name transfer**
and **takedown/yank** are index operations (we own the index, not the files).

**Health.** The index periodically re-crawls + re-validates registries; a repo
that 404s or fails validation is marked unhealthy and de-ranked, not silently
broken for installers (the cache + lock still serve pinned installs).

---

## Part 7 — Discovery & curation

- **Search** over the denormalized item index (name, title, description,
  categories, type, namespace).
- **Signals:** install count, "kept" rate (installed-and-not-removed), freshness,
  verified-publisher badge, hand-curated "official" flag. Rank official/verified
  above community; never purely by raw installs (gameable).
- **Collections / use-cases:** curated bundles ("Sales agent starter", "Finance
  pack") — these are just `registry:bundle` items, dog-fooding the primitive.
- **The gallery (`/marketplace`)** = browse + filter by type/category + an item
  page (readme, files, capabilities, "Add to project"). Item page is rendered
  from the same item JSON the CLI consumes — one source of truth.

---

## Part 8 — Lifecycle

- `kortix marketplace install` — install (built).
- `kortix outdated` — compare lock hashes vs. current source refs → what changed.
- `kortix update [item]` — re-resolve → **diff** → apply on confirm (re-pin lock).
- `kortix remove <item>` — delete its locked files + lock entry (clean uninstall
  because the lock knows exactly what it wrote).
- **Drift detection** — a locked file edited locally is shown on update so we
  never clobber a user's edits without telling them (the lock hash ≠ disk hash).
- **Breaking changes** — surfaced via the diff + optional `meta.version` semver
  + deprecation notes. We don't auto-migrate; we *show* and let the user choose.

---

## Part 9 — What Kortix actually stores (because it's index-not-host)

A small amount of metadata, no files:

- **`registries`** — id, namespace, repo URL, owner account/org, visibility
  (public/company), verification state, health, last-indexed sha, stats.
- **`registry_items`** (denormalized index for search) — registry id, name,
  type, title, description, categories, declared capabilities, latest sha/hash.
- **`registry_checksums`** — `(source, path, sha) → hash` checksum authority.
- *(optional)* **`registry_cache`** — read-through blob cache keyed by hash.

No file storage, no per-install rows beyond what the project's own
`registry-lock.json` already holds. The marketplace DB is tiny and mostly a
search/trust projection of public git state.

---

## Part 10 — Governance & economics (foresight, not now)

- **Moderation:** report → triage → yank/de-list. Index-side, reversible.
- **Paid items (future):** the same item model + an entitlement check at install
  (gallery mints a short-lived signed grant; the file fetch requires it).
  Revenue-share like Raycast Store / shadcn Pro. Deliberately deferred — the
  free, open, repo-is-a-registry path must be first-class and never gated.
- **Licensing:** items carry an SPDX `meta.license`; the gallery surfaces it.

---

## Part 11 — Phased rollout

1. **P0 — Engine + CLI (DONE).** Format, build, resolve, install, lock, and
   `kortix marketplace`. Repo-tier sharing works today with zero backend.
2. **P1 — Cloud install.** `kortix marketplace install --project <id>` commits into a linked
   repo via `POST /projects/:id/files/commit` (reusing `commitFileToBranch`).
   Plus `kortix update/outdated/remove`.
3. **P2 — Capability manifest + consent.** Declare + approve. The safety
   foundation; do this *before* opening global publishing.
4. **P3 — Company registries.** Org registry repo + Customize → Add, private via
   the git-proxy.
5. **P4 — Global index + gallery.** Submit/index/checksum service, `/marketplace`
   UI, search, verified publishers, cooldown, static gates.
6. **P5 — Provenance signing, paid items, collections.**

Gate: **don't open global community publishing (P4) until the capability
manifest + consent (P2) and static gates ship.** Opening a marketplace before
the trust model is the classic mistake.

---

## Part 12 — Anti-goals (what we deliberately do NOT do)

- **We don't host files.** Git does. We index + checksum.
- **We don't invent a package format.** We extend shadcn's; interop is a feature.
- **We don't gate the repo tier.** Anyone can run their own registry with zero
  Kortix involvement — that openness is the moat, not a leak.
- **We don't reinvent semver/VCS.** Refs + content hashes, Go-style.
- **We don't auto-update or auto-run.** Installs and updates are explicit,
  diffable commits a human (or a reviewing agent) signs off on.
- **We don't trust publishers by default.** We trust the lock, the sandbox, and
  explicit consent.

---

### Appendix — built vs. to-build

| Principle | Status |
|---|---|
| One primitive, shadcn format | ✅ `schema.ts`, 11 item types |
| Install = files + lock | ✅ `install.ts`, `lock.ts` (v2, hashes, legacy migration) |
| Resolve from git/URL/local + include | ✅ `fetch.ts` |
| Repo = registry (`build`) | ✅ `build.ts`, proven on 69-skill starter |
| Marketplace CLI | ✅ `apps/cli` |
| Cloud install (`--project`) | ✅ API marketplace install path |
| Capability manifest + consent | ⛔ P2 — **highest-value next** |
| Company registries via git-proxy | ⛔ P3 |
| Global index + gallery + checksums | ⛔ P4 |
| Provenance signing, cooldown, paid | ⛔ P5 |
