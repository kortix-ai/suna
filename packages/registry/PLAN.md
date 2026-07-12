# Registry / Marketplace — code-quality review + plan

A thermo-nuclear review of the `registry-marketplace` branch, then the spec/plan to
land the refactors and the remaining roadmap. Behavior is already proven (41
tests, live in-project install). This is about making the *implementation*
inevitable in hindsight.

The branch decomposes well — 11 focused engine modules, **no file over ~420
lines, none crossed 1000**. The problems are not sprawl; they're **three real
duplications** I introduced by adding-alongside instead of refactoring, plus one
**magic-field type**. All fixes are behavior-preserving.

---

## Part A — Review findings (priority order)

### A1 — BLOCKER: `commitFileToBranch` is now a duplicate of `commitMultipleFilesToBranch`

`apps/api/src/projects/git/branches.ts`. I added the multi-file committer beside
the existing single-file one. They are the *same function* — identical plumbing:
`refreshMirror(force)` → resolve `parentSha` → `mkdtemp` → `hash-object` →
`read-tree` (parent | `--empty`) → `update-index` → `write-tree` →
`commit-tree` → `update-ref` (CAS) → `push` → `finally rm`, down to the same
three `/^[0-9a-f]{40}$/` SHA validations. ~50 duplicated lines, two places to fix
any git bug.

**Code-judo:** the single-file case *is* the multi-file case with one entry.
Delete the single-file body and delegate:

```ts
export async function commitFileToBranch(project, opts): Promise<{ commitSha: string }> {
  const { commitSha } = await commitMultipleFilesToBranch(project, {
    files: [{ path: opts.path, content: opts.content }],
    message: opts.message, branch: opts.branch,
    authorName: opts.authorName, authorEmail: opts.authorEmail,
  });
  return { commitSha };
}
```

One commit path. (Existing callers — `commits.ts` seeding, `triggers.ts`
manifest edits — are unchanged.)

### A2 — HIGH: `SKILL.md → registry:skill` grouping is duplicated

`build.ts` (the `skillRe` loop) and `fetch.ts::scanGithubSkills` independently
implement the exact same rule: match `**/SKILL.md`, take the parent dir, leaf =
name, gather siblings (`p === skillMd || startsWith(dir + '/')`), target
`@skills/<name>/<rel>`. Two copies of the one rule that defines what a "skill" is
— they *will* drift.

**Remedy:** one pure helper, e.g. `packages/registry/src/skills.ts`:

```ts
// rootPrefix: where skills live ('<configDir>/skills' for build, the sparse subdir for scan)
export function skillItemsFromPaths(
  paths: string[],
  opts: { rootPrefix: string; readMeta?: (skillMdPath: string) => Record<string,string> },
): RegistryItem[]
```

`build.ts` calls it rooted at `<configDir>/skills`; `scanGithubSkills` calls it
rooted at the subdir. The grouping rule lives once.

### A3 — MED: lock-entry construction duplicated in `install.ts`

`applyInstall` and `recordPlanInLock` build the identical
`{ type, source, sourceType, files, installedAt }` entry (lines ~187 and ~207).
`applyInstall` already computes which units to record — it should then call
`recordPlanInLock` (or both share `lockEntryFromUnit(unit, now)`). One mapping.

### A4 — MED: `catalog.ts` — magic `__` fields + two responsibilities

1. `type ResolvedCatalogItem = RegistryItem & { __registry; __external?; __sourceUrl? }`
   bolts metadata onto a domain type via `__`-prefixed fields. Replace with an
   explicit wrapper so the boundary is real:
   ```ts
   interface CatalogEntry { item: RegistryItem; registry: string; external?: RegistryRef; sourceUrl?: string }
   ```
   The `Map<string, CatalogEntry>` then carries provenance without mutating the
   item, and `toCatalogItem`/`resolveCatalogItem` take a `CatalogEntry`.
2. `catalog.ts` (420 lines) mixes the **index** (base build / external fetch /
   merge) with the **install service** (`buildInstall` + capability
   aggregation). Split → `catalog.ts` (index/read) + `install-service.ts`
   (`buildInstall`). Each becomes scannable and single-purpose.
3. While splitting: `mergedCatalog()` re-derives external `CatalogItem`s via
   `toCatalogItem` instead of reusing `ext.items`; the capability aggregation in
   `buildInstall` re-walks every unit. Both collapse naturally once `CatalogEntry`
   exists (carry the computed `capabilities` on the entry).

### A5 — LOW (accept, but note)

- `_resetExternalCache` is a test-only export — a legitimate seam; keep it
  documented as such.
- The CLI `registry.ts` (361 lines) is a flat subcommand switch — cohesive, but
  if it grows, split handlers into `commands/registry/*`.

**Approval bar:** A1 is a presumptive blocker (duplicated git plumbing). A2/A3/A4
are required before this is "clean." None block *behavior*; all are pure
structure. Nothing else here rises above a nit.

---

## Part B — Spec & plan

### B0 — Refactor pass (do first; behavior-preserving)
1. A1: `commitFileToBranch` delegates to `commitMultipleFilesToBranch`. *(~−45 lines)*
2. A2: extract `skills.ts::skillItemsFromPaths`; build.ts + scanGithubSkills call it.
3. A3: `applyInstall` reuses `recordPlanInLock` via a shared `lockEntryFromUnit`.
4. A4: `CatalogEntry` wrapper; split `install-service.ts` out of `catalog.ts`.
- Gate: 41 tests stay green; tsc clean × 4 packages; live `GET /marketplace/items`
  still 200 + install still commits. No new file > 1000 lines.

### B1 — Cloud install lifecycle (started)
- `kortix marketplace install --project` (done), in-project overlay (done). Add **uninstall in
  the repo**: a `DELETE /projects/:id/registry/:name` that *removes* files from
  the tree — needs `update-index --remove` plumbing (a sibling of
  `commitMultipleFilesToBranch`, sharing the same throwaway-index core extracted
  in A1). Then wire the web "Installed → Remove" affordance.
- `kortix registry outdated` / `update`: re-resolve a locked item's source, diff
  the content hash, show + apply. Reuses the lock + the resolver.

### B2 — Ecosystem compatibility (scan done; adapters next)
- Done: generic `SKILL.md` scan (`scanGithubSkills`) → Anthropic / skills.sh /
  Codex skill dirs work with no `registry.json`.
- Next: **one** manifest adapter — `.claude-plugin/marketplace.json` (Codex
  reuses it) → expand `plugins[]` by their `source` (string | github | url |
  git-subdir | npm → map onto our `RegistryRef`) into `registry:bundle`s; read
  each plugin's `.claude-plugin`/`.codex-plugin` `plugin.json` to pull
  `commands/` → `registry:command`, `agents/` → `registry:agent`, `.mcp.json` →
  `registry:connector`. Drop `hooks`/`lspServers` (no Kortix equivalent) with an
  explicit "unsupported" note, don't silently swallow.
- Tighten our `SKILL.md` `name` regex to the agentskills.io spec
  (`[a-z0-9-]`, = dirname) on the **build/validate** path (ingest stays lenient).
- Add a GitHub token to the Trees API call (rate limits) — thread through
  `RegistryLoaderOptions`.

### B3 — "Add marketplace" (the UI you sketched)
- The resolver behind Source / Git ref / Sparse paths already exists (address +
  scan + subdir). It needs **persistence** beyond the `KORTIX_MARKETPLACE_REGISTRIES`
  env: a small `marketplace_sources` table (account/project-scoped:
  `{address, ref, sparse_paths[], scope}`), `POST/GET/DELETE
  /v1/marketplace/sources`, and the catalog reads sources from DB ∪ env. Then the
  form is a thin dialog over those routes. **This is the only remaining piece
  that needs a DB migration.**

### B4 — Trust & scale (from MARKETPLACE.md, later)
- Capability **enforcement** + consent gating before opening community publishing.
- Provenance signing, the publish/index service + checksum authority, the global
  `/marketplace` gallery's 3-scope model (repo / company / global).

### Sequencing
B0 (refactor) → B1 (uninstall + lifecycle) → B2 (manifest adapter) → B3 (Add-marketplace
+ DB) → B4 (trust). B0 first so the uninstall plumbing (B1) and the adapter (B2)
build on a deduplicated base, not the current copies.
