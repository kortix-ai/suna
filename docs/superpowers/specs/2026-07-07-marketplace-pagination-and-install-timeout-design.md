# Marketplace pagination + install-timeout fix — design

**Date:** 2026-07-07
**Branch/worktree:** `marketplace-pagination`

## Problems

1. **Browser lag / hang.** The marketplace fetches the *entire* catalog in one
   response and renders one card per item with **no pagination and no
   virtualization** on either surface (public `/marketplace*` marketing pages and
   the in-project browser). Large catalogs blow up the payload, memory, and DOM.
2. **Add-skill 25s timeout.** Installing a skill with many files exceeds the
   global 25s request deadline: the install path fetches **each file from GitHub
   sequentially** (`planInstall`) and spawns **one `git hash-object` subprocess
   per file** sequentially (`commitMultipleFilesToBranch`), and
   `/marketplace/install` is **not** on the deadline-exemption list → 503.

Both are addressed in this worktree as **two independent workstreams / commit
groups**.

## Current-state facts (verified)

- `GET /v1/marketplace/items` → `listCatalogItemsLive(opts)` →
  `filterCatalogItems(mergedCatalog().items, opts)`. Supports `query`/`type`/`source`
  filters only. **No `limit`/`offset`.** Handler returns `{ items, ...catalogStatus() }`
  where `catalogStatus()` adds `{ loading, pending, sources }` (progressive source
  streaming). `apps/api/src/marketplace/{index.ts,catalog.ts}`.
- Both surfaces call the same route: the client via
  `listMarketplaceItems` (`apps/web/src/lib/marketplace-client.ts`) and the
  Server Components via `listPublicMarketplaceItems` (`apps/web/src/lib/marketplace-public.ts`).
  `ItemsPage = { items, loading, pending, sources }`.
- Data hook: `useMarketplaceItems` (`apps/web/src/hooks/marketplace.ts`) —
  `useQuery`, re-polls every 1500ms while `loading`.
- Render surfaces with no virtualization: `marketplace-browser.tsx` (in-project),
  `marketplace-explore.tsx` + `marketplace-company-explore.tsx` (public).
- `@tanstack/react-virtual@^3.13.12` is **already** in `apps/web/package.json`.
- Install: `planInstall` (`packages/registry/src/install.ts:124`) reads each file
  sequentially via `resolved.readFile(file.path)` (a GitHub HTTP GET per file for
  external skills). `commitMultipleFilesToBranch`
  (`apps/api/src/projects/git/branches.ts:244`) runs `git hash-object -w` once per
  file sequentially. A bounded-concurrency helper `mapLimit` already exists
  (`packages/registry/src/fetch.ts:175`) but is unexported/unused here.
- 25s deadline: `apps/api/src/middleware/request-deadline.ts`. `isExempt` matches
  `EXEMPT_PREFIXES`, `EXEMPT_FRAGMENTS` (substring), `EXEMPT_METHOD_PATHS`.
  `/commit-push`, `/provision`, `/deployments` are exempt; install/update are not.

## Design

### Workstream A — Pagination (both surfaces)

Three complementary layers, each earning its place:

- **Server pagination** cuts payload + memory (the root cause).
- **Infinite scroll** gives the browse UX (load-more on scroll, no page buttons).
- **List virtualization** keeps the DOM window small as infinite scroll accumulates
  rows, so it never hangs regardless of scroll depth.

**Page size: 30.**

**A1 — API (`apps/api/src/marketplace/{catalog.ts,index.ts}`).**
- Add optional `limit` + `offset` to the items query. **Opt-in:** when `limit` is
  absent, return the full filtered list (preserves existing programmatic callers
  like `listDefaultProjectMarketplaceItems`, which needs all Kortix skills).
- New `listCatalogItemsPage(opts)` returning `{ items, total }` where `total` is the
  filtered count *before* slicing; the route slices `[offset, offset+limit)`.
- Route response gains `total` and `hasMore` (`offset + items.length < total`)
  alongside the existing `{ loading, pending, sources }`. Ordering is the existing
  merged-catalog order (base first, external appended as sources resolve) — stable
  enough for offset paging because earlier pages don't reorder; while `loading`,
  `total` reflects the count resolved so far and the client's existing 1500ms poll
  reconciles.

**A2 — Client data layer (`apps/web/src/lib/{marketplace-client.ts,marketplace-public.ts}`,
`apps/web/src/hooks/marketplace.ts`).**
- `listMarketplaceItems` / `listPublicMarketplaceItems` accept `limit`/`offset`;
  `ItemsPage` gains `total: number` and `hasMore: boolean` (defaulted so existing
  non-paged callers are unaffected).
- Add `useInfiniteMarketplaceItems({ query, type, source, publicOnly, limit })`
  built on `useInfiniteQuery` — `getNextPageParam` derives the next `offset` from
  `hasMore`; preserves the `loading`→1500ms-poll behavior for the first page.
  The existing `useMarketplaceItems` stays for callers that want a single page.

**A3 — In-project browser (`apps/web/src/features/marketplace/marketplace-browser.tsx`,
`marketplace-view.tsx`).**
- Consume `useInfiniteMarketplaceItems`. Render the item grid through
  `@tanstack/react-virtual`. A bottom sentinel (IntersectionObserver) triggers
  `fetchNextPage`. Grouping-by-type keeps its section headers but each section's
  body is virtualized/paged rather than mounting every card.

**A4 — Public pages (`apps/web/src/features/marketplace/{marketplace-explore.tsx,
marketplace-company-explore.tsx}`, the `(marketing)/marketplace/*` route components).**
- **Company page** (single source, can be huge): infinite scroll + virtualization,
  same as A3.
- **Explore landing:** SSR renders a **bounded first page** (limit sized to fill the
  per-type previews, ~9 each) instead of the whole catalog, then hydrates. The
  existing 9-per-type preview cap stays for the landing view; **"See all"** and
  **search** results render through the infinite-scroll + virtualized list (scoped
  by `type`/`query` server-side) instead of mounting every matching card.

### Workstream B — Install timeout

**B1 — Parallelize file reads (`packages/registry/src/install.ts`).**
- Export `mapLimit` from `packages/registry/src/fetch.ts` (or a small shared util)
  and use it in `planInstall`'s per-file loop with **concurrency 8**. Preserve
  deterministic output: results (and read-failure warnings) are applied in the
  original file order, so `plan.writes` / lock file lists are unchanged vs. the
  sequential version.

**B2 — Parallelize git hashing + exempt the route (`apps/api`).**
- `commitMultipleFilesToBranch`: hash blobs with bounded concurrency (**8**) —
  `git hash-object -w` per file is independent (unique temp blob names, object-store
  writes are safe to parallelize). `read-tree` + `update-index` + `write-tree` +
  `commit-tree` + `push` stay strictly sequential (single throwaway index).
- `request-deadline.ts`: add install/update fragments to `EXEMPT_FRAGMENTS` —
  `/marketplace/install`, `/registry/install`, `/marketplace/update`,
  `/registry/update` (substring match also covers `/marketplace/update-all`). This
  matches the existing precedent for the equally-git-bound `/commit-push`.
  Parallelization is the real fix; the exemption is the safety net for genuinely
  huge skills.

## Testing (repo rule: every behavioural change ships co-located `bun:test`)

- **A1:** unit tests for `listCatalogItemsPage` (limit/offset slicing, `total`
  before slice, opt-in full-list when no `limit`, filter composition). Route shape
  (`total`/`hasMore`) covered by a `ke2e` flow if the route contract changes.
- **A2:** unit tests for `listMarketplaceItems` param serialization + `ItemsPage`
  mapping, and `useInfiniteMarketplaceItems` page accumulation / `getNextPageParam`.
- **A3/A4:** component behaviour tests — sentinel triggers `fetchNextPage`, only a
  window of rows renders, search/type scopes the server query. No exact-DOM-count
  pins that bitrot; assert paging invariants.
- **B1:** `planInstall` produces identical ordered `writes` to the sequential
  version and preserves per-file read-failure warnings; concurrency is bounded.
- **B2:** `commitMultipleFilesToBranch` still commits the same tree with many files
  (blob shas correct, order-independent); `isExempt` returns true for the four
  install/update paths and stays false for `/marketplace/items`.

## Out of scope

- Cursor-based pagination (offset is sufficient for a mostly-cached, append-ordered
  in-memory catalog).
- Rewriting the catalog to a DB-backed store.
- Changing the progressive source-streaming (`loading`/`pending`) mechanism.
