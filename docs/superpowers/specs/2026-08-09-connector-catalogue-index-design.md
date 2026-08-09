# Connector catalogue: server-side index, honest sections, one paging mechanism

Date: 2026-08-09
Branch: `connector-search`
Surface: `/projects/[id]/connectors` (and `/connectors`)

## 1. The problem

Marko, on the Connectors capability page:

1. "PIPEDREAM search is still severely regressed / the search doesn't search the
   full catalogue."
2. "The category-based discovery with Pipedream doesn't work obviously because
   you always just take the ones from the current page."
3. "Load more feels janky as you keep adding stuff to the different categories
   and expanding them."
4. "The connected state is a bit too hidden."
5. Page lag with many rendered cards.

## 2. Root causes, measured

Probed against the live Pipedream Connect API with this repo's credentials
(`apps/api/.env`, project `proj_BgsY1X5`), 2026-08-09.

### 2.1 Search is deleted server-side, not narrowed client-side

`apps/api/src/connectors/pipedream-catalog.ts:30` returns
`app.authType === 'oauth'`. `PipedreamProvider.listApps`
(`apps/api/src/connectors/pipedream.ts:131`) applies it to every page.

```
q=SAP    -> Pipedream total_count 3
             sapling_ai (keys), sap_s_4hana_cloud (keys),
             sap_s_4hana_cloud_sandbox (keys)
q=Oracle -> Pipedream total_count 2
             oracle_cloud_infrastructure (keys), rocketadmin (keys)
```

Every hit is `auth_type: "keys"`, so the API returns `apps: []` with
`total: 3`. `useCatalog` produces zero entries and `ConnectorBrowse` renders
`CatalogNoMatch` — "No matches for SAP".

Full-catalogue crawl (33 pages at `limit=100`, 48.4 s):

| Measure | Value |
| --- | --- |
| Apps total | 3,238 |
| `auth_type: oauth` | 659 |
| `auth_type: keys` | 2,547 |
| `auth_type: null` | 32 |
| `has_actions: true` | 1,974 |
| `has_triggers: true` | 1,174 |
| Neither actions nor triggers | 1,161 |
| Distinct categories | 25 |
| Apps with no category | 0 |

The oauth filter hides **79.6%** of the catalogue. The search is not
regressed by paging; it is correct and then discarded.

### 2.2 Pipedream cannot filter by category

```
GET /apps?limit=1                                -> total_count 3238
GET /apps?limit=1&category=Business%20Management -> total_count 3238
GET /apps?limit=1&categories=Business%20Management -> total_count 3238
```

Both parameters are ignored. A category can therefore only ever be a
client-side slice of loaded pages, which is exactly the behaviour Marko
describes. `CATALOG_FOCUS_TARGET` (24) exists solely to paper over this by
walking pages until a client-side bucket looks full.

### 2.3 The catalogue is small enough to hold whole

Trimmed to the fields the UI uses:

| Form | Bytes | Gzipped |
| --- | --- | --- |
| slug, name, description, icon, auth, categories | 715,382 | 169,891 |
| same without description | 425,672 | 57,103 |

Each record already carries `has_actions`, `has_triggers`, `featured_weight`
and `categories`. No extra requests are needed to rank, facet or filter.

### 2.4 Two stacked paging mechanisms cause the jank

`useCatalog` runs an effect chain that fetches `CATALOG_INITIAL_PAGES` (4)
eagerly, then keeps fetching while a focused category holds fewer than
`CATALOG_FOCUS_TARGET` (24) entries, capped at `CATALOG_AUTOLOAD_MAX_PAGES`
(24). `ConnectorBrowse` layers a second mechanism on top: a reveal window
(`CATALOG_INITIAL_REVEAL` 24, `CATALOG_REVEAL_STEP` 6) over the flat grid.

On the Discovery tab every landed page re-buckets the whole entry set through
`groupIntoSections` and grows every section in place. The page the user is
reading reflows continuously.

### 2.5 Render cost

`ConnectorBrowse` renders every loaded entry with no windowing. At the
24-page ceiling that is 1,152 `CatalogCard` buttons, each containing a
`next/image` with `fill` + `unoptimized` (an absolutely-positioned image in a
`relative` wrapper — layout work with none of `next/image`'s optimisation
benefit). `groupIntoSections` allocates a `Set` per entry and re-runs on every
page landing.

### 2.6 Dead stagger code

`CatalogEntryCard` accepts `reveal` and applies `.kx-card-reveal` with a
staggered delay. Both call sites in `connector-browse.tsx` omit the prop, so
`reveal` is always `null` and the animation never runs. `REVEAL_STEP_MS`,
`REVEAL_MAX_STEPS` and `cardRevealDelay` are unreachable.

## 3. Decisions taken

| Decision | Choice |
| --- | --- |
| Catalogue scope | All apps with `has_actions: true` (1,974), any auth type |
| Category UX | Keep stacked sections; make them server-fetched and fixed |
| Index cold start | Warm in background, answer the first request live |

`keys` apps are connectable: the app record ships a `custom_fields` password
form (verified on `1saas`, `sap_s_4hana_cloud`), which Pipedream's hosted
Connect Link renders. `authType` is not read anywhere in `apps/web` or
`packages/sdk` for gating — it is only a type annotation.

The 1,161 apps with neither actions nor triggers are excluded because they
produce a connector with zero tools: a dead end discovered only after
connecting.

### 3.1 Found during implementation: SAP itself has no actions

```
sap_s_4hana_cloud          has_actions=False has_triggers=False auth=keys
sap_s_4hana_cloud_sandbox  has_actions=False has_triggers=False auth=keys
oracle_cloud_infrastructure has_actions=True has_triggers=True  auth=keys
```

So the chosen policy fixes `q=Oracle` but leaves `q=SAP` an empty catalogue
result. "No matches for SAP" would still be the wrong thing to say: the apps
exist upstream, and the reason they are absent is one we can state.

The snapshot therefore keeps action-less apps in a separate `withoutActions`
list — out of the catalogue, out of every category bucket and facet count, but
searchable for the purpose of counting. `pipedreamCatalogPage` returns
`excludedNoActions` for a query, and `CatalogNoMatch` renders:

> No matches for `SAP`. 9 apps match but publish no actions an agent can call.

### 3.2 Found during implementation: prefix matching is not enough

`q=SAP` scored "Sapling.ai" and "SAP S/4HANA Cloud" identically (both
`namePrefix`), and the name tie-break put Sapling first. A `nameWord` tier
above `namePrefix` fixes it: the query as a standalone word in the name
outranks a name that merely begins with those letters.

## 4. Design

### 4.1 Server: a catalogue snapshot

New module `apps/api/src/connectors/pipedream-index.ts`.

```ts
export interface CatalogApp {
  slug: string;
  name: string;
  description: string | null;
  imgSrc: string | null;
  authType: string | null;
  categories: string[];
  hasActions: boolean;
  hasTriggers: boolean;
  featuredWeight: number;
}

export interface CatalogSnapshot {
  apps: CatalogApp[];                       // has_actions only
  byCategory: ReadonlyMap<string, CatalogApp[]>;
  categories: Array<{ key: string; label: string; count: number }>;
  fetchedAt: number;
}
```

Behaviour:

- Crawl `/v1/connect/{project}/apps?limit=100` until `end_cursor` is absent.
- Drop `UTILITY_APP_SLUGS`, `NATIVE_APP_SLUGS`, and `has_actions: false`.
- Module-level cache, TTL 6 h, single-flight promise so concurrent callers
  share one crawl.
- `getSnapshot()` never blocks. It returns the current snapshot (possibly
  stale) and schedules a refresh when the snapshot is missing or expired.

Cost per pod: 33 requests per 6 h.

### 4.2 Server: ranking

New module `apps/api/src/connectors/pipedream-search.ts`, pure and unit-tested.

```ts
export function rankApps(apps: readonly CatalogApp[], query: string): CatalogApp[];
```

Score, highest wins:

| Match | Score |
| --- | --- |
| slug or name equals the query | 100 |
| the query is a whole word of the name | 90 |
| name starts with the query | 80 |
| a name word starts with the query | 60 |
| name contains the query | 40 |
| slug contains the query | 30 |
| description contains the query | 10 |
| otherwise | excluded |

Ties break on `featuredWeight` desc, then `name` asc.

This also fixes upstream relevance: Pipedream returns `q=notion` as
`cloudpress, notion, notion_api_key` — alphabetical, with the exact match
second.

### 4.3 Server: routes

Extend the existing route and add one.

```
GET /projects/{projectId}/pipedream/apps?q=&category=&cursor=&limit=
  -> { apps, categories, total, nextCursor?, hasMore, indexReady,
       excludedNoActions }

GET /projects/{projectId}/pipedream/sections?perCategory=6
  -> { sections: [{ key, label, total, apps }], indexReady }
```

`indexReady: false` means the answer came from the live Pipedream API while
the crawl runs. In that mode `categories` is empty and `category` is ignored;
the client keeps its current client-side grouping for that one render and
re-queries once the index lands.

`sections` is what makes Discovery honest: one request returns the top
`perCategory` apps of each category **by `featuredWeight` then name**, plus
that category's true total. Nothing grows as the user scrolls.

Discovery renders the 12 largest categories. The remaining 13 appear as a
chip row at the foot that opens the flat view filtered to that category.

### 4.4 Client

`useCatalog` (`catalog/use-catalog.ts`):

- One `useInfiniteQuery` per source, keyed
  `['easy-connect-apps', projectId, q, category]`, 48 per page.
- Delete the auto-load effect chain and every constant it reads.
- Return a normalised `sections` field so `ConnectorBrowse` renders one shape
  for both sources: server-supplied for Easy Connect, client-computed by the
  existing `groupIntoSections` for Discover.

`catalog-paging.ts`: delete `CATALOG_INITIAL_PAGES`, `CATALOG_FOCUS_TARGET`,
`CATALOG_AUTOLOAD_MAX_PAGES`, `shouldAutoLoadPage`, `CATALOG_REVEAL_STEP`,
`CATALOG_INITIAL_REVEAL`, `canRevealMore`, `nextRevealCount`. Keep
`shouldLoadOnScroll`.

`connector-browse.tsx`:

- Section headings carry the true total: `Marketing · 207`.
- "View all" opens the category, which is now a real server-side filter.
- Flat grid uses one paging mechanism — the sentinel and the button both call
  `fetchNextPage`. No reveal window.
- Delete `CatalogEntryCard`'s `reveal` prop, `cardRevealDelay`,
  `REVEAL_STEP_MS`, `REVEAL_MAX_STEPS`.
- `memo` `CatalogEntryCard`.

`ConnectorIcon`: replace `next/image` (`fill` + `unoptimized`) with a plain
`<img width={36} height={36} loading="lazy" decoding="async">`. Same visual
result, no wrapper layout, native offscreen deferral.

### 4.5 Connected state

`ConnectorConnectedMark` is a bare 16 px `text-kortix-green` check in the
card's trailing slot. Replace the catalogue usage with a labelled
`Badge variant="success"` reading `Connected`, so the state is legible without
decoding a glyph. The bare mark stays available for dense surfaces.

## 5. Testing

Unit (`bun:test`, co-located):

- `pipedream-search.test.ts` — ranking order, exact-match precedence, empty
  query passthrough, tie-breaks.
- `pipedream-index.test.ts` — crawl pagination against a stubbed fetch, TTL
  expiry, single-flight (two concurrent calls issue one crawl), `has_actions`
  and utility-slug filtering.
- `catalog-paging.test.ts` — updated for the reduced surface.
- `connector-browse.*.test.ts` — sections render fixed counts, headings show
  the server total, no reveal window.

Integration:

- Route tests for `?category=` and `?q=` against a stubbed snapshot,
  `indexReady: false` fallback path.

Manual proof required before merge:

- `q=SAP` and `q=Oracle` return results on the deployed dev API.
- A category's card count matches the count in its heading.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| `keys` apps fail to connect through Connect Link | Verify one `keys` app end to end on dev before merge |
| Snapshot memory per pod (~1 MB) | Trimmed records only; measured 715 KB |
| Cold-start crawl on every deploy | Background warm; live fallback answers meanwhile |
| Discover source regresses | Its client-side grouping path is unchanged |
