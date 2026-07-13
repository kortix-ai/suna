# @kortix/sdk — end-to-end production-readiness review

**Date:** 2026-07-12 · **Branch:** `feat/sdk-v2-structure-and-distribution` (41 commits vs `main`, base `808fadfc8`) · **Reviewer:** Claude (fresh two-axis review + live verification), on Jay's request before merging to production.

## Verdict

**Shippable to production: YES** — every mechanical gate is green, the release
pipeline claims were independently re-verified, and the one item the branch ledger
left open (Task 9 Step 6, the D2a/D3 browser gate) has now been **executed and
passed** against a real browser + live local stack. Two decisions remain that only
Jay can make (below); neither is a code defect.

## What was verified this session (all fresh runs, this working tree)

| Gate | Result |
|---|---|
| `pnpm --filter @kortix/sdk typecheck` (incl. `examples/tsconfig.json`) | clean, exit 0 |
| `pnpm --filter @kortix/sdk test` (full suite) | **1066 pass / 0 fail**, 70 files, 5023 expects |
| `pnpm --filter @kortix/sdk run build:bundles` | `kortix.esm.min.js` 189.90 KB, `kortix.global.js` 190.88 KB |
| `pnpm --filter @kortix/sdk run smoke:install` | pack → install tarballs → Node ESM import: OK |
| **D2a** — streaming through the `window.Kortix` IIFE global | **PASS** — real Chromium loaded `examples/08-cdn.html` via `<script src>` against the live local stack (fresh session `4f2953bc…`, project t1): `sent — streaming…` followed by `· message.part.updated` ×7 through `· session.idle`. |
| **D3** — `instanceof Kortix.ApiError` under the IIFE bundle | **PASS** — a bundle-thrown `ApiError` ("Session runtime not ready", `kortix.ts:681`) satisfied `error instanceof Kortix.ApiError` in page script and printed via that branch. A bad-PAT run threw `SessionStartError` and correctly took the non-ApiError branch (it extends `Error` by design). |

D2a/D3 were the ledger's sole "NOT YET shippable" reason (`PROGRESS.md`) — the plan
gated them on a human ("awaiting Jay"). They are now machine-verified end to end;
Jay may still want to eyeball `08-cdn.html` himself, but there is no unobserved
claim left.

## Two-axis review (independent sub-agents, full 41-commit diff)

### Standards axis — 1 real finding, 1 nit; otherwise conformant

1. **[Important] The public-surface snapshot omits every type-only export.**
   `public-surface.test.ts` snapshots runtime namespaces (`Object.keys(import(entry))`),
   which contain no `export type` bindings — `SessionHandle`, `ClassifiedPart`,
   `KortixProject`, `Kortix`, `ProjectHandle`, `SessionModel`, `TurnError` are all
   absent from the snapshot. A type rename — the exact consumer break
   `packages/sdk/AGENTS.md` warns about hardest — passes CI green.
   → **Fixed this session (F5):** new `public-type-surface.test.ts` + committed
   snapshot via the TypeScript compiler API.
2. **[Nit] Stale JSDoc path** at `src/browser/stores/server-store.ts:26`.
   → **Fixed this session (F2).**

Verified compliant: version field untouched; alias-never-replace honored (20
deprecated shims, `KortixProject`→`KortixMasterProject` aliased); export three-edit
rule enforced by tests; react/react-query stay optional peers; framework-free
tripwires strengthened; no RN-streaming claims in docs.

### Spec axis — plan implemented faithfully; findings:

1. **[Was severe, now closed] Task 9 Step 6 (D2a/D3) never executed** — executed
   and passed this session (table above). The spec's D5 "script tag" leg is also
   covered by the D2a run (the IIFE was loaded via an actual `<script>` tag).
2. **Scope creep (all Jay-driven mid-branch, recorded for the merge record):**
   `packages/sdk/playground/` (~41 files, live-stack scripts); the
   `apps/web` Create-API-key-button fix (+test) — this one **breaches the plan's
   Global Constraint** "Only Task 5 touches a host, and only whitelabel-demo";
   the fumadocs SDK docs refresh under `apps/web/content/docs/sdk/`;
   `packages/sdk/GETTING-STARTED.md`. None of it touches the published surface;
   flagging, not reverting.
3. **[Minor, plan gap] Residual `src/platform/` mixed-tier directory** (e.g.
   `config-node.ts` imports `node:async_hooks` but sits outside `node/`). Faithful
   to Task 4's move list; the "directory tells you what it may import" ideal is
   ~90% realized. Follow-up, not a blocker (tripwire still enforces the real rule).
4. Nothing from the plan's "Deferred (do not start)" section was built. Plan prose
   says "21" legacy subpaths; the correct, implemented number is 20.

### Distribution fact-check — 17/17 claims VERIFIED

Both export maps set-equal (asserted by `package-exports.test.ts`); stage script
promotes **and validates** `browser`/`unpkg`/`jsdelivr` CDN fields;
`publish-npm-package.sh` builds the tsup bundles before staging (plus
`prepublishOnly` defense-in-depth); `deploy-prod.yml` publishes `@kortix/llm-catalog`
before the SDK so the pinned `workspace:*` rewrite resolves; root `VERSION` stamps
the lockstep version. CI on every PR: SDK typecheck (incl. examples), bundle build
**before** `bun test` so `bundle.test.ts` actually runs, and the pack→install→import
smoke. Docs: `api.kortix.com` everywhere (0 `.ai` remnants); CDN filenames match
tsup output; CHANGELOG covers this release; no false RN-streaming claims.

## New finding from live verification: CORS bounds the CDN story

The API's CORS allowlist is static (`apps/api/src/index.ts:151-202`): kortix.com
domains + `localhost:3000/3010` + `CORS_ALLOWED_ORIGINS` env. A browser page on any
other origin using the CDN bundle is blocked at preflight — my first D2a attempt
from `localhost:8099` failed exactly this way (the plan's own Step 6 procedure hits
it; local repro needs `CORS_ALLOWED_ORIGINS=http://localhost:8099`). The bundle
itself is fine — this is a platform policy question.

## Fixes applied this session (uncommitted, in working tree)

| # | Item | Status |
|---|---|---|
| F1 | `smoke-install.mjs` finally-block: each cleanup step now independent (a throw no longer leaves `package.json` un-restored) | applied |
| F2 | Stale JSDoc path `server-store.ts:26` | applied |
| F3 | Tripwire blind spot: side-effect imports (`import 'react';`) now caught (Backlog **B6**) — TDD, RED first | applied |
| F4 | `packages/sdk/AGENTS.md` stale claims (export-map key-set assertion + install smoke now exist; baseline count refreshed) | applied |
| F5 | **Type-surface snapshot**: `public-type-surface.test.ts` + snapshot via TS compiler API — type renames now fail CI | applied |
| F6 | CORS reality documented in `examples/08-cdn.html` + README CDN section | applied |
| F7 | Same side-effect-import fix applied to the inline tier-scan regex (implementer-discovered) + last stale AGENTS.md comment | applied |

Every fix was task-reviewed by an independent sub-agent: **spec ✅ on all seven,
code quality Approved** (three minor observations, none defects). Post-fix gates,
reproduced independently by implementer AND reviewer: typecheck exit 0 · **1069
pass / 0 fail / 71 files** · smoke:install OK.
Full fix detail + RED evidence + gate output: `.superpowers/sdd/fix-wave-2-report.md`.

## Remaining items — decisions only Jay can make

1. **Public CORS policy for the CDN use-case.** If third parties are meant to use
   the `<script>`/CDN bundle from their own origins against `api.kortix.com`, the
   API needs a deliberate CORS decision (e.g. reflect any origin for
   PAT-authenticated routes, or a per-account origin allowlist). Until then the CDN
   story is real but only for allowlisted origins. Not an SDK defect; ship the SDK
   without waiting on this — the docs now state the constraint (F6).
2. **npm publish credentials**: `publish-npm-package.sh:27-30` exits 0 with a
   warning when neither OIDC Trusted Publishing nor `NODE_AUTH_TOKEN` is present —
   a misconfiguration skips the publish silently rather than failing the release.
   Confirm Trusted Publishing is wired for the `@kortix` org before relying on the
   next prod deploy (one-time infra check, outside the repo).

## Follow-ups (non-blocking, for the backlog)

- Fold the residual `src/platform/` files into `core/`/`node/` tiers (spec-axis #3).
- Demo e2e harness memoizes on `.next/BUILD_ID` → stale-build runs (pre-existing,
  out of SDK scope; already in PROGRESS discovery).
- The bare-global guard's trailing same-line-comment heuristic limit (disclosed,
  symmetric, pre-existing).
- Playground scripts are untracked-by-design personal tests; consider whether
  `playground/` should stay in the repo long-term.

## Memory/plan corrections

- The living plan `2026-07-08-ts-sdk-1.0-completion-and-lumen.md` referenced in
  session memory does not exist in any local checkout — pointer is stale.
- This report supersedes the "NOT YET (D2a/D3 unverified)" self-assessment in
  `packages/sdk/PROGRESS.md`; PROGRESS.md has been updated accordingly.
