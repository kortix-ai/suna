# Plan — Marketplace pagination + install-timeout fix

Executes the design at
`docs/superpowers/specs/2026-07-07-marketplace-pagination-and-install-timeout-design.md`.

Two independent workstreams. **Order:** B1 → B2 (timeout, quick independent win)
→ A1 → A2 → A3 → A4 (pagination; A2 depends on A1's response shape, A3/A4 on A2's
hook). Each task is a single focused commit.

## Global Constraints (bind every task)

- **Worktree only.** All work happens in the `marketplace-pagination` worktree at
  `/Users/jay/root/kortix/suna-marketplace-pagination`. Never touch another checkout.
- **Tests ship with the change** (repo rule, `.claude/skills/testing/SKILL.md`):
  co-located `*.test.ts` run by `bun:test`. Deterministic, isolated, no network in
  unit tests, Arrange→Act→Assert, **no comments in test files**, no `.only`. A test
  must fail if the change is reverted. Run `pnpm --filter <pkg> test` **and**
  `typecheck` for every package touched.
- **Page size = 30.** Concurrency limit for file fetch + git hashing = **8**.
- **Pagination is opt-in via `limit`.** With no `limit` param, `/marketplace/items`
  returns the full filtered list exactly as today (existing callers such as
  `listDefaultProjectMarketplaceItems` must keep working).
- **Preserve progressive streaming.** The `{ loading, pending, sources }` fields and
  the 1500ms re-poll while `loading` must keep working.
- **Determinism of install output.** Parallelizing must NOT change `plan.writes`
  order, lock file lists, or committed tree bytes vs. the sequential version.
- **Virtualization dep already present:** `@tanstack/react-virtual@^3.13.12` in
  `apps/web/package.json`. Do not add a new dep.
- Follow existing code style in each file; match neighbours. No unrelated refactors.

---

## Task B1 — Parallelize `planInstall` file reads (`packages/registry`)

**Context.** External-skill install reads every file from GitHub sequentially,
which is the main contributor to the 25s install timeout for many-file skills.

**Files.**
- `packages/registry/src/install.ts` — `planInstall` / `visit`, per-file loop at
  lines ~123–143.
- `packages/registry/src/fetch.ts` — `mapLimit` at ~175 (currently unexported).
- Tests: co-located `packages/registry/src/install.test.ts` (create) or extend
  `packages/registry/src/__tests__/registry.test.ts` — match the existing pattern.

**Steps.**
1. Export `mapLimit` from `fetch.ts` (or lift it to a small shared util module in
   `packages/registry/src`) so `install.ts` can import it. Keep its signature.
2. In `visit`, replace the sequential `for (const file of resolved.item.files …)`
   read loop with a bounded-concurrency map (limit 8) over the files. Each unit of
   work either yields a `PlannedWrite` or, on read failure, a warning string.
   **After** the concurrent phase, append `writes`/`plan.writes` and `plan.warnings`
   in the **original file order** so output is byte-identical to the sequential path.
   Dependency recursion (`visit` of deps) stays as-is (still depth-first, before the
   item's own files).

**Tests.**
- Given a `ResolvedItem` whose `readFile` records call order, `planInstall` reads
  files concurrently (≥2 in flight when >1 file) but bounded at 8.
- `plan.writes` order + hashes are identical to a sequential reference for a
  multi-file item (with and without a failing file → warning preserved, file skipped).
- A `readFile` rejection produces the same warning text and does not abort the plan.

**Acceptance.** `pnpm --filter @kortix/registry test` + `typecheck` green;
output determinism preserved.

---

## Task B2 — Parallelize git hashing + exempt install/update from the deadline (`apps/api`)

**Context.** `commitMultipleFilesToBranch` spawns one `git hash-object -w` per file
sequentially; combined with the 25s deadline (which does not exempt install), large
skills 503. Fix both: parallelize the independent hashing, and exempt the
git-bound install/update routes like the existing `/commit-push` precedent.

**Files.**
- `apps/api/src/projects/git/branches.ts` — `commitMultipleFilesToBranch`, blob-hash
  loop at ~242–250.
- `apps/api/src/middleware/request-deadline.ts` — `EXEMPT_FRAGMENTS` (~73).
- Tests: co-located `apps/api/src/middleware/request-deadline.test.ts` (create or
  extend) for `isExempt`; a git-commit test alongside existing `branches` coverage
  if present (else a focused unit test for the hashing helper with a temp repo).

**Steps.**
1. `commitMultipleFilesToBranch`: hash blobs with bounded concurrency (limit 8).
   Each task writes its unique `blob-<i>` temp file and runs `git hash-object -w`,
   returning `{ path, sha }`. Collect into `blobs` preserving file order. The SHA
   regex validation stays per-blob. `read-tree` → `update-index` (per blob, in
   order) → `write-tree` → `commit-tree` → `update-ref` → `push` remain strictly
   sequential on the single throwaway index. Delete handling unchanged.
2. `request-deadline.ts`: add `'/marketplace/install'`, `'/registry/install'`,
   `'/marketplace/update'`, `'/registry/update'` to `EXEMPT_FRAGMENTS`
   (substring match also covers `/marketplace/update-all`). Do not touch
   `/marketplace/items` (must stay bounded).

**Tests.**
- `isExempt` (or `requestDeadline` behavior) → true for POST
  `/v1/projects/<id>/marketplace/install`, `/registry/install`,
  `/marketplace/update`, `/marketplace/update-all`, `/registry/update`; **false**
  for `/v1/marketplace/items` and a generic bounded route.
- `commitMultipleFilesToBranch` with a many-file input commits a tree whose blob
  shas/paths match the sequential expectation (order-independent), against a
  temporary local bare repo (no network) — or, if the existing suite lacks a git
  harness, a unit test over an extracted `hashBlobs(files, repoPath)` helper.

**Acceptance.** `pnpm --filter <api pkg> test` + `typecheck` green; `/commit-push`
and other exemptions unchanged; `/marketplace/items` still bounded.

---

## Task A1 — Server pagination for `/marketplace/items` (`apps/api/src/marketplace`)

**Context.** Root-cause fix: stop serializing the whole catalog. Add opt-in
`limit`/`offset` and report `total`/`hasMore`.

**Files.**
- `apps/api/src/marketplace/catalog.ts` — `filterCatalogItems` (~1440),
  `listCatalogItemsLive` (~1475). Add `listCatalogItemsPage`.
- `apps/api/src/marketplace/index.ts` — `GET /items` handler (~35–55): extend the
  zod query with `limit`/`offset`, return `total`/`hasMore`.
- Tests: co-located catalog test (create `catalog.pagination.test.ts` or extend an
  existing catalog test) — pure, no network (feed a synthetic item array).
- If the route response contract changes, update/add the `ke2e` flow per
  `.claude/skills/testing/SKILL.md` (marketplace items flow in `tests/src/flows/`).

**Steps.**
1. Add `listCatalogItemsPage(opts: ItemQuery & { limit?: number; offset?: number })`
   returning `{ items, total }`: filter (reuse `filterCatalogItems`), `total =
   filtered.length`, then slice `[offset ?? 0, (offset ?? 0) + limit)` **only when
   `limit` is a positive number**; otherwise return the full filtered list.
2. `GET /items`: parse `limit`/`offset` (coerce to int, clamp `limit` to a sane max
   e.g. 100, `offset >= 0`). When `limit` present → use `listCatalogItemsPage` and
   return `{ items, total, hasMore, ...catalogStatus() }` where
   `hasMore = (offset ?? 0) + items.length < total`. When absent → existing behavior
   plus `total = items.length`, `hasMore = false` (back-compat superset).

**Tests.**
- `limit`/`offset` slice correctly; `total` is the pre-slice filtered count;
  `hasMore` true/false at boundaries; no `limit` → full list (opt-in guarantee);
  filter (`query`/`type`/`source`) composes with paging; visible-type filter intact.

**Acceptance.** Package test + typecheck green; non-paged callers unaffected.

---

## Task A2 — Client data layer: paged fetch + infinite hook (`apps/web`)

**Context.** Expose A1's pagination to the UI without breaking single-page callers.

**Files.**
- `apps/web/src/lib/marketplace-client.ts` — `ItemsPage`, `listMarketplaceItems`.
- `apps/web/src/lib/marketplace-public.ts` — `listPublicMarketplaceItems`.
- `apps/web/src/hooks/marketplace.ts` — add `useInfiniteMarketplaceItems`; keep
  `useMarketplaceItems`.
- Tests: co-located `marketplace-client.test.ts` / hook test (bun:test), no network
  (mock `backendApi`/`fetch`).

**Steps.**
1. Add `limit`/`offset` params to `listMarketplaceItems` + `listPublicMarketplaceItems`;
   extend `ItemsPage` with `total: number` and `hasMore: boolean` (default `total:
   items.length`, `hasMore: false` when server omits them, so existing callers are
   unaffected). Serialize `limit`/`offset` into the query string.
2. Add `useInfiniteMarketplaceItems({ query, type, source, publicOnly, limit = 30 })`
   on `useInfiniteQuery`: `initialPageParam: 0`, `getNextPageParam` returns
   `lastPage.hasMore ? offset + limit : undefined`, `queryKey` includes the filters,
   and preserve `refetchInterval` = 1500ms while the first page reports `loading`.
   Expose a flattened `items` selector for consumers.

**Tests.**
- Query-string serialization includes `limit`/`offset`; `ItemsPage` maps
  `total`/`hasMore` with safe defaults.
- `getNextPageParam` returns next offset when `hasMore`, `undefined` at the end;
  pages flatten in order.

**Acceptance.** `pnpm --filter <web> test` + `typecheck` green.

---

## Task A3 — In-project browser: infinite scroll + virtualization (`apps/web`)

**Context.** Primary surface where users browse and add skills; must not hang.

**Files.**
- `apps/web/src/features/marketplace/marketplace-browser.tsx`
- `apps/web/src/features/marketplace/marketplace-view.tsx` (wiring only if needed)
- Tests: co-located component test.

**Steps.**
1. Switch data source to `useInfiniteMarketplaceItems`.
2. Render the grid via `@tanstack/react-virtual` (`useVirtualizer`, windowed rows).
   Keep type-group section headers; each group body is paged/virtualized rather than
   mounting every card.
3. Add a bottom IntersectionObserver sentinel that calls `fetchNextPage` when in
   view and `hasNextPage`. Show a small loading row while fetching. Preserve existing
   search/type/source controls (now server-scoped through the hook).

**Tests.**
- Sentinel intersection triggers `fetchNextPage` (mock observer + hook).
- Only a bounded window of rows is in the DOM for a large dataset (assert the
  invariant, not an exact count).
- Search/type input scopes the server query key.

**Acceptance.** `pnpm --filter <web> test` + `typecheck` green; manual: large
catalog scrolls smoothly, install still works.

---

## Task A4 — Public marketplace pages: bounded SSR + infinite/virtualized views (`apps/web`)

**Context.** The marketing `/marketplace` + `/marketplace/[company]` pages fetch and
render the whole catalog; fix payload + DOM there too.

**Files.**
- `apps/web/src/features/marketplace/marketplace-company-explore.tsx`
- `apps/web/src/features/marketplace/marketplace-explore.tsx`
- `apps/web/src/app/(public)/(marketing)/marketplace/page.tsx` and
  `.../[company]/page.tsx` (SSR fetch bounds)
- Tests: co-located component tests.

**Steps.**
1. **Company page:** infinite scroll + virtualization (same pattern as A3), scoped to
   the source via the `source` param.
2. **Explore landing:** change the SSR fetch to a **bounded first page** (limit sized
   to fill the ~9-per-type previews) instead of the whole catalog; keep the
   9-per-type preview cap for the landing view. **"See all"** for a type and
   **search** results render through the infinite-scroll + virtualized list
   (server-scoped by `type`/`query`) instead of mounting every matching card. Keep
   SSR/ISR first paint for SEO.

**Tests.**
- Company explore: sentinel → `fetchNextPage`; windowed DOM for a large source.
- Explore: "See all" / search switches to the paged virtualized list; landing SSR
  requests a bounded limit (not the full catalog).

**Acceptance.** `pnpm --filter <web> test` + `typecheck` green; manual: public
pages no longer hang on a large catalog; SEO first paint intact.

---

## Final

After all tasks: whole-branch review, then `make fast` (lint + typecheck + unit +
smoke) green before finishing the branch.
