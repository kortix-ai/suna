# Connector catalogue completeness

**Date:** 2026-08-10
**Status:** approved, implementing
**Surface:** `apps/api/src/connectors/*`, `apps/web/src/features/workspace/capabilities/connectors/*`

## Problem

39.1% of the Pipedream catalogue is invisible on Kortix, and no query reaches
any of it — including an app's own exact name.

Reported as "the search still aint searching" (Marko, 2026-08-10): `q=SAP`
returns 21 results on Kortix and 30 on `mcp.pipedream.com/?q=sap`, and neither
`SAP S/4HANA Cloud` nor `SAP S/4HANA Cloud (Sandbox)` is among the 21.

SAP is one symptom. The defect is catalogue-wide.

### Measured, against the live Pipedream API

Probes run 2026-08-10 with the repository's own credentials, read-only.

| Fact | Value |
| --- | --- |
| Third-party apps Pipedream publishes | 3,230 |
| Shown on Kortix (`has_actions === true`) | 1,967 |
| **Hidden (`has_actions === false`)** | **1,263 (39.1%)** |
| Of the hidden, trigger-only | 102 |
| **Hidden apps reachable by their own exact name** | **0 of 1,263** |

Per-query damage on ordinary searches:

| Query | shown | hidden | notable casualty |
| --- | --- | --- | --- |
| `auth0` | **0** | 1 | Auth0 (Management API) — the only match |
| `sap s/4hana` | **0** | 2 | SAP S/4HANA Cloud, and its Sandbox |
| `sap` | 21 | 9 | SAP S/4HANA Cloud (score 90, whole-word) |
| `teams` | 92 | 47 | Microsoft Teams Bot, Microsoft Teams Events |
| `adobe` | 2 | 4 | Acrobat Sign, Document Generation API, Lightroom |
| `sharepoint` | 2 | 1 | Microsoft Sharepoint Dev |
| `xero` | 1 | 1 | Xero Payroll (non-US) |
| `redis` | 1 | 2 | Redis Cloud REST API |

### What is NOT broken

Ruled out with evidence, so nobody re-investigates them:

1. **The matcher.** `rankApps` finds all 30 apps for `sap` over the full
   snapshot — the same 30 Pipedream's own page shows. Upstream matches missed:
   **0**.
2. **The crawl.** 33 pages, 3,238 records, **0 duplicates**, `total_count`
   3,238. Cursor paging over `sort_key=featured_weight` does not skip records.
3. **Pipedream's `has_actions` flag.** Probed `/actions` and `/triggers` for all
   9 apps hidden from `q=sap`: every one returns **0 actions and 0 triggers**.
   The flag is truthful. These apps really would produce a zero-tool connector.

## Root cause — THREE exclusions, not one

`pipedream-catalog.ts` held three independent filters, added at different times,
each hiding real records behind a rule the user could neither see nor defeat. A
search that came up short was indistinguishable from a broken search box.

| Filter | Hid | Status |
| --- | --: | --- |
| `authType === 'oauth'` | 2,579 of 3,238 | removed before this work |
| `hasActions` | 1,263 (39.1%) | removed here |
| `UTILITY_APP_SLUGS` + `NATIVE_APP_SLUGS` | 8 | removed here |

**The slug sets are the `q=slack` bug.** Pipedream's explorer reports 11 matches
for "slack"; Kortix reported 10. `NATIVE_APP_SLUGS = {'slack','slack_bot'}`
dropped `slack` ("Slack (legacy)") and `slack_bot` ("Bot for Slack").

That set was also incoherent. It never contained `slack_v2` — **the record that
IS the main Slack**, which sat on the browse page the entire time. So it never
achieved the "native Kortix apps are offered elsewhere" goal it was written for;
it only produced a count that disagreed with Pipedream. `UTILITY_APP_SLUGS` was
similarly stale: 13 of its 19 slugs match nothing in the catalogue, and the 6
that do include `RSS` and `HTTP / Webhook`, which are perfectly real records.

The resolution is the same for all three: **no membership predicate at all.**
`pipedream-catalog.ts` is deleted. A capability limit belongs on the card and at
the submit button, where the user can read it — never in a filter that makes an
app vanish.

### The `hasActions` half, in detail

`isCatalogApp` required `hasActions` — `apps/api/src/connectors/pipedream-catalog.ts:56`.

`buildSnapshot` acts on it at `pipedream-index.ts:101-102`, splitting the crawl
into `apps` (ranked, served) and `withoutActions` (held, never ranked). No code
path ever ranks `withoutActions`, so its 1,263 records cannot be returned by any
query.

**Secondary — why it reads as silently broken.** The server already computes
`excludedNoActions` (`pipedream.ts:520`) and ships it to the browser. Its only
consumer, `CatalogNoMatch`, renders **inside the `isEmpty` branch**
(`connector-browse.tsx:398-421`). With 21 results on screen `isEmpty` is false,
so the explanation is unreachable in exactly the case that prompted the report.
The affordance was built for "0 results"; `q=SAP` is "21 wrong results".

## Design

Show every app Pipedream publishes. Mark the ones that carry no agent tools, and
stop the user at the point of action rather than by hiding the record.

### 1. Server: the catalogue is the whole catalogue

- `buildSnapshot` stops splitting on `hasActions`. `apps` holds every record;
  `withoutActions` is removed from `CatalogSnapshot`.
- `byCategory` is built from all of them, so category counts become true counts.
- **`pipedream-catalog.ts` is deleted**, along with `isCatalogApp`,
  `isThirdPartyApp`, and both slug sets. `crawlCatalog` pushes every record.
- `browsePipedreamApps`, the cold-start live fallback, filters nothing either —
  a predicate there would make the catalogue quietly shrink once the crawl
  landed.

Result: 3,238 apps in, 3,238 apps offered. Exact parity with Pipedream.

### 2. Ordering: reachable, without displacing usable apps

`hasActions` becomes a sort term ranked **below** match score and **below**
Pipedream's featured weight:

- `rankApps`: score → `hasActions` → prominence.
- `compareByProminence`: featuredWeight → `hasActions` → name.

Consequences, both intended:

- `q=SAP` puts **SAP S/4HANA Cloud first** — score 90 (whole word) beats
  Sapling.ai's 80 (prefix). This is the outcome `pipedream-search.ts:37` already
  documents as correct and which the filter made unreachable.
- Browsing a category leads with connectable apps. The tool-less ones sit at the
  tail of their score band instead of vanishing.

### 3. Client: state the limitation, twice

- `CatalogEntryCard` passes a `No agent tools` badge through `CatalogCard`'s
  existing `badges` slot when `app.hasActions === false`.
- The card stays clickable and opens the normal add modal. The submit is
  **disabled** with the reason stated inline. A non-responding card reads as a
  bug; a disabled action with a sentence is an answer.
- `ConnectorConnectionModal` gains an optional `blockedReason` prop: renders a
  notice in the body, disables submit, and guards `onSubmit`.

`hasActions` already travels the full path — `connectors.ts:945` →
`PipedreamApp` → `CatalogEntry.app` — and is read nowhere on the client. No SDK
change, no new wire field, no snapshot regeneration.

### 4. Retire `excludedNoActions`

Nothing is excluded any more, so the field is structurally 0.

- Server keeps returning `0` and is marked deprecated.
- The SDK field stays `excludedNoActions?: number`, deprecated. Removing it
  would break a published optional type for no gain.
- The client stops reading it: the `CatalogNoMatch` prop and its branch in
  `catalog-empty-state.tsx` are removed.

## Blast radius

Stated plainly, because this is not only a search change:

- The browse catalogue grows from 1,967 to 3,238 apps.
- Six Pipedream workflow primitives are now listed — `HTTP / Webhook`,
  `Schedule`, `RSS`, `Formatting`, `Helper Functions`, `Pipedream Utils`. They
  are odd catalogue entries, and the ones without actions carry the badge. If
  they prove to be noise, the answer is to rank them down, not to hide them —
  hiding is what produced this bug three times.
- Both legacy Slack records appear alongside `slack_v2`.
- Every category count rises. Section headings state larger, and now true,
  totals.
- Users can reach 1,263 apps that cannot be connected. That is the trade the
  badge and the disabled submit exist to pay for.

## Non-goals

- **Description-match noise.** `q=sap` matches ~20 WhatsApp/SMS apps because
  `sap` is a substring of "What**sap**p" in their descriptions
  (`SCORE.description = 10`). Pipedream's own page shows the same 30, so this is
  parity, not regression. Tightening it would diverge from upstream and is a
  separate decision.
- **Trigger-only apps.** 102 of the 1,263 publish triggers but no actions.
  Kortix does not consume Pipedream triggers, so they are treated identically to
  the other 1,161.
- **Native/utility exclusions.** `slack` and the 19 workflow utilities stay out.

## Verification

1. Unit: ranker and snapshot. The regression test that would have caught this is
   **an action-less app is reachable by its own exact name**.
2. Live API: `q=auth0`, `q=sap`, `q=sap s/4hana`, `q=teams` against a running
   server, asserting result counts and that the named apps are present.
3. Browser: the badge renders and the add modal's submit is disabled with its
   reason.
