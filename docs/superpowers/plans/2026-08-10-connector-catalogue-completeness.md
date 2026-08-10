# Plan — connector catalogue completeness

Spec: `docs/superpowers/specs/2026-08-10-connector-catalogue-completeness-design.md`

Nine tasks. Server first (1–4), then client (5–7), then verification (8–9).
Tests are written before the change they cover.

---

## 1. Ranker: `hasActions` as a sort term — `pipedream-search.ts`

RED first in `pipedream-search.test.ts`:

- `rankApps` puts an action-less whole-word name match (`SAP S/4HANA Cloud`,
  score 90) above an action-having prefix match (`Sapling.ai`, score 80).
- Within one score band, an action-having app precedes an action-less one.
- `compareByProminence`: featuredWeight still wins over `hasActions`;
  `hasActions` wins over name.

GREEN: add the `hasActions` term to `compareByProminence` and to `rankApps`'s
tie-break, ranked below score and below featuredWeight.

## 2. Snapshot: stop splitting — `pipedream-index.ts`

RED in `pipedream-index.test.ts`:

- `buildSnapshot` keeps action-less apps in `apps`.
- `byCategory` buckets them, so category counts include them.
- Utilities and native slugs are still dropped by the crawl.
- Rewrite the existing `keeps action-less apps aside` test, which asserts the
  behaviour being removed.

GREEN: delete the `ordered`/`withoutActions` split and the `withoutActions`
field from `CatalogSnapshot`; build `byCategory` from every app.

## 3. Catalogue predicate — `pipedream-catalog.ts`

Collapse `isCatalogApp` into `isThirdPartyApp`. Keep `isCatalogApp` as the
exported name (it has call sites) but drop the `hasActions` requirement.
Rewrite the module doc: it currently argues *for* the filter this change
removes, so leaving it would be a lie in the file that caused the bug.

## 4. Page + fallback — `pipedream.ts`

- `pipedreamCatalogPage`: `excludedNoActions` becomes a literal `0`, marked
  deprecated. Delete the `rankApps(snapshot.withoutActions, …)` call.
- `browsePipedreamApps` keeps filtering with the now-widened `isCatalogApp`, so
  warm and cold pages agree.

## 5. Card badge — `connector-browse.tsx`

- `CatalogEntryCard` renders a `No agent tools` badge in `CatalogCard`'s
  existing `badges` slot when the entry is easy-connect and
  `app.hasActions === false`.
- Drop the `excludedNoActions` prop from the `CatalogNoMatch` call site.

## 6. Empty state — `catalog-empty-state.tsx`

Remove the `excludedNoActions` prop and its branch. `CatalogNoMatch` returns to
one sentence.

## 7. Blocked submit — `connector-connection-modal.tsx` + `easy-connect-add-flow.tsx`

- Modal: optional `blockedReason?: string | null`. When set, render a notice in
  the body, disable submit, and guard the `onSubmit` handler.
- `EasyConnectAddFlow`: pass the reason when `app.hasActions === false`.
- `use-catalog.ts`: drop `excludedNoActions` from `CatalogState`.

## 8. Local gates

- `bun test` over `apps/api/src/connectors`
- `bun test` over the connectors web feature
- `tsc --noEmit` in `apps/web`, `npx eslint` on every touched file

## 9. Live verification

Against a running API with the index warm:

- `q=auth0` returns Auth0 (Management API) — today it returns 0.
- `q=sap` returns 30 with SAP S/4HANA Cloud first — today 21, absent.
- `q=sap s/4hana` returns 2 — today 0.
- `q=teams` returns 139 — today 92.
- Browse total is 3,230 — today 1,967.

Browser: the badge renders on a tool-less card, and its add modal shows the
disabled submit with its reason.

**Do not commit or push.** Explicit instruction from the user.

---

## Outcome — deviations from the plan

1. **The prop is `unavailableReason`, not `blockedReason`.** The first name
   broke `connector-authorization-lock.test.ts`, which counts
   `/lockedReason=/g` in `connectors-view.tsx` — `b·lockedReason=` matched.
   Two near-identical prop names in one file is also its own readability
   problem, so the rename stands on its own merit. The shared helper is
   `easyConnectUnavailableReason` to match.
2. **That regex is now `\blockedReason=`.** Unanchored it could also pass
   wrongly: delete the real `lockedReason=`, add any prop ending in those
   letters, and the count still reads 1.
3. **Three add surfaces, not one.** `connectors-view.tsx` (Add-connector modal)
   and `onboarding/steps/tools-step.tsx` list the same catalogue and build their
   own modals. Both would have kept offering the dead end. A source-assertion
   test now covers all three, and was mutation-checked — removing the prop from
   `tools-step.tsx` makes it fail.
4. **Two more filters had to go — the plan only found one.** The first pass
   removed `hasActions` and *kept* `UTILITY_APP_SLUGS` / `NATIVE_APP_SLUGS`,
   reasoning they were product decisions rather than capability gates. That was
   wrong, and Jay caught it with `q=slack`: Pipedream reports 11, Kortix
   reported 10, because `NATIVE_APP_SLUGS` dropped `slack` ("Slack (legacy)")
   and `slack_bot` ("Bot for Slack").

   The set never contained `slack_v2` — the record that IS the main Slack, and
   which was on the browse page throughout — so it never achieved its stated
   purpose, it only produced a count that disagreed with upstream. 13 of the 19
   `UTILITY_APP_SLUGS` entries match nothing in the catalogue at all, and 2 of
   the 6 live ones (`RSS`, `HTTP / Webhook`) are real records.

   **`pipedream-catalog.ts` is deleted.** No membership predicate remains.
   3,238 in, 3,238 offered.

5. **A test was left failing by the first pass.**
   `src/__tests__/unit-connector-discover-catalog.test.ts` asserted the old
   `isCatalogApp` contract. It was never run — the earlier sweep covered
   `src/connectors` only, and the file lives in `src/__tests__`. Rewritten to
   assert the *absence* of any predicate. Lesson: run the whole package, not the
   directory you edited.

6. **`browsePipedreamApps` now filters nothing.** A predicate there would make
   the catalogue shrink the moment the crawl landed.

## Verification results

`bun test`:

- `apps/api/src/connectors` — 117 pass. 2 pre-existing failures in
  `manifest-crud*.test.ts` from a missing `@aws-sdk/credential-provider-node`
  (confirmed absent via `require.resolve`); neither file was touched here.
- `apps/web` connectors + customize + onboarding — 808 pass, 0 fail.

`tsc --noEmit` in `apps/web`: clean across `src/`.
`eslint` on all 12 touched files: 0 errors, 10 pre-existing
`react-hooks/*` warnings in `connectors-view.tsx`.

Live Pipedream catalogue, running the shipped `crawlCatalog` / `buildSnapshot` /
`rankApps` / `pageOf` over 3,238 real records:

| Check | Result |
| --- | --- |
| Raw records in → apps offered | **3,238 → 3,238, zero exclusions** |
| Browse catalogue total | 3,238 (was 1,967) |
| `q=slack` | **12 (was 10)** — `slack_v2`, `slack`, `slack_bot` all present |
| `q=sap` | 30 results (was 21), SAP S/4HANA Cloud first (was absent) |
| `q=teams` | 139 (was 92) |
| Exact-name lookup for 8 formerly slug-blocked records | all 8 return that record first |
| Exact-name lookup for 8 formerly-unreachable apps | all 8 return that app first |
| Same-band ordering inversions over 7 queries | 0 |
| Inert apps on browse page 1 | 1 — Google, `featuredWeight: 9900`, i.e. Pipedream's own promotion |
| Partition within `featuredWeight: 0` | first inert at 1755, last connectable at 1754 — exact |
