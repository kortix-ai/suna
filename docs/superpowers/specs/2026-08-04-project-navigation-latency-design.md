# Fix slow project page-to-page navigation, and upgrade to Next.js 16

- **Date:** 2026-08-04
- **Branch:** `fix/slow-page-navigation`
- **Surface:** `apps/web`
- **Status:** approved design, pending implementation plan

---

## Problem Statement

Clicking any link in the project sidebar is slow. The delay affects every
destination — a session in the session list, `/files`, and the project home —
and it affects every project. The interface gives no feedback during the wait,
so the click reads as unresponsive rather than as loading.

Two distinct defects produce this, and neither is the Next.js version:

1. **Dynamic routes without a loading boundary are not prefetched at all.**
   Next.js prefetches a dynamic route only as far as its nearest `loading.tsx`.
   `projects/[id]/` has none, so a click waits out a full server round-trip
   before anything paints. Next's own documentation names this first under
   "What can make transitions slow?".
2. **Middleware performs blocking network work on every navigation.** Every
   client-side transition in the App Router issues an RSC request, and every RSC
   request runs middleware. Middleware currently makes an uncached HTTP call for
   the maintenance config and a GoTrue call for the user, in series, before the
   route renders.

A third, less frequent cost: `projects/[id]/layout.tsx` re-verifies auth that
middleware already verified. Partial rendering means this runs on project
switches and hard loads, not on every navigation.

**Cost of not solving it:** the core loop of the product — moving between
sessions and files inside a project — feels broken. This is the most-repeated
interaction in the app.

---

## Evidence

Every claim below is from source at commit `981922c2b7`.

### Per-navigation blocking work

| Where | Work | Frequency |
|---|---|---|
| `apps/web/src/middleware.ts:219` | `getMaintenanceConfig()` → `fetch(BACKEND_URL)` with `cache:'no-store'`, `AbortSignal.timeout(2_000)`, plus an Edge Config read and a possible Vercel API `PATCH` | every non-public request, production only (`EDGE_CONFIG` set) |
| `apps/web/src/middleware.ts:393` | `supabase.auth.getUser()` — GoTrue network round-trip | every non-auth-route request |
| `apps/web/src/app/(app)/projects/[id]/layout.tsx:18` | a second `supabase.auth.getUser()` | project switch and hard load only (partial rendering skips unchanged shared layouts) |
| `apps/web/src/app/(app)/projects/[id]/` | no `loading.tsx` → prefetch skipped entirely | every navigation to project home |

Local development does not pay the maintenance-config cost: `getMaintenanceConfig()`
returns the in-memory store immediately when `EDGE_CONFIG` is unset
(`apps/web/src/lib/maintenance-store.ts:129`). The cost is production-only.

### Corroboration already in the repo

`apps/web/src/app/(app)/projects/[id]/files/loading.tsx` documents the exact
mechanism in its own doc comment:

> "This route is dynamic — the project layout awaits cookies() — and for a
> dynamic route Next.js prefetches only as far as the nearest loading boundary.
> Without this file the sidebar's `<Link prefetch>` has nothing to store."

A previous author reached the same conclusion for `/files`. The same fix was
never applied to `projects/[id]/`.

### Dead code found in the auth gate

- `PROTECTED_ROUTES` (`middleware.ts:135`) is declared and never read. The gate
  is actually **default-deny**: anything not matching `PUBLIC_ROUTES` requires
  auth (`middleware.ts:472-492`).
- `BILLING_ROUTES` is `[]` and its branch (`middleware.ts:495`) returns the same
  value as the line after it.

The default-deny behavior is what makes removing the layout's `getUser()` safe.
It is also stronger than the allowlist the dead constant implies.

### Next.js version facts

- Installed: `next@15.5.21` (`apps/web/package.json:162`), also pinned by root
  `pnpm.overrides` (`next@>=15.0.0 <15.5.21` → `15.5.21`).
- Latest: `16.3.0` (npm `dist-tags.latest`), but published 2026-08-03T20:34Z and
  therefore refused by the repo's 72h `minimum-release-age` cooldown. Target is
  `16.2.0` — see R5.
- Node 22 across all CI workflows; Next 16 requires ≥ 20.9. No blocker.

---

## Goals

1. A sidebar click paints a response immediately instead of freezing the
   previous page until the server answers.
2. Remove the uncached per-navigation network fetch from the middleware path.
3. Remove the duplicate auth round-trip from the project layout.
4. `apps/web` runs on Next.js 16.2.0 with a green production build.
5. Every change ships with a test that fails before the change and passes after.

## Non-Goals

1. **Redesigning the session loader.** `InstantSessionShell` /
   `SessionStartingLoader` and their 300ms crossfade are out of scope, by
   explicit decision. No `loading.tsx` is added to `sessions/[sessionId]/`.
2. **`experimental.staleTimes`.** Next's own documentation says it is
   "experimental and subject to change, not recommended for production". Next
   16's prefetch-cache rewrite is the first remedy; revisit only if measurement
   shows it is insufficient.
3. **`middleware.ts` → `proxy.ts`.** Deprecated, not removed. Renaming the file
   in the same change that alters the auth gate doubles review risk for no
   user-visible gain. Follow-up.
4. **`supabase.auth.getClaims()` in middleware.** It avoids the network only for
   projects using asymmetric JWT signing keys; with a symmetric secret it "always
   sends a request similar to `getUser()`" (`@supabase/auth-js@2.110.0` typings,
   `GoTrueClient.d.ts:2450`). Whether this project uses asymmetric keys is a
   Supabase dashboard setting, not readable from the repo. Measure first.
5. **`await cookies()` removal from the project layout.** It is a deliberate
   dynamic-render opt-in. Removing it changes rendering semantics well beyond
   this change.
6. **Broader bundle-size work.** `@/features/project-files` is ~9,291 LOC and
   may well be a real contributor to the Files route feeling heavy, but that is
   a separate investigation.

---

## User Stories

1. As a user working inside a project, I want a sidebar click to respond
   immediately, so that I can tell the app registered it.
2. As a user switching between `/files` and a session, I want the transition to
   complete without a visible stall, so that moving around the project does not
   interrupt my work.
3. As an engineer on this repo, I want the auth gate to be readable and free of
   dead constants, so that I can verify what actually protects `/projects/*`.
4. As an engineer on this repo, I want `apps/web` on a supported Next.js
   release, so that security fixes and ecosystem packages stay available.
5. As a platform admin, I want a maintenance lockdown to still take effect
   promptly, so that caching the config does not defeat its purpose.

---

## Requirements

### P0 — Must have

#### R1. TTL-cache the maintenance config

**File:** `apps/web/src/lib/maintenance-store.ts`

Add a module-scope cache around `getMaintenanceConfig()` with a 5-second TTL and
in-flight request coalescing, so concurrent navigations share a single upstream
fetch instead of issuing one each.

`setMaintenanceConfig()` must invalidate the cache synchronously so an admin
toggle takes effect on the next request, not up to 5 seconds later.

**Trade-off, accepted:** a blocking lockdown engages up to 5 seconds later per
serverless instance. Acceptable for a maintenance flag; must be stated in a code
comment at the cache definition.

**Test-isolation constraint (discovered while planning).** The existing
`maintenance-store.test.ts` imports the module once at file scope
(`maintenance-store.test.ts:42`) and asserts exact `events` arrays per test —
e.g. `['database-read', 'edge-read', 'edge-write', 'edge-read-consistent']`
(`:80`). A module-scope TTL cache is shared across those tests, so the second
test would hit a warm cache, record no events, and the **existing suite would
fail**. The implementation must therefore export a test-only reset:

```ts
/** Test-only. Clears the TTL cache so each test starts cold. */
export function __resetMaintenanceCacheForTests(): void
```

called from the existing `beforeEach`. Without it, R1 breaks four passing tests.

Acceptance criteria:
- Given `EDGE_CONFIG` is set and `getMaintenanceConfig()` was called once,
  when it is called again within the TTL,
  then no upstream fetch is issued and the first result is returned.
- Given no cached value, when N concurrent calls are made,
  then exactly one upstream fetch is issued and all N callers receive its result.
- Given a cached value, when `setMaintenanceConfig()` is called,
  then the next `getMaintenanceConfig()` issues a fresh fetch.
- Given the upstream fetch throws, when the TTL has not elapsed,
  then the existing fail-open fallback behavior is unchanged.

#### R2. Remove the duplicate `getUser()` from the project layout

**File:** `apps/web/src/app/(app)/projects/[id]/layout.tsx`

Delete the `createClient()` / `supabase.auth.getUser()` / `redirect('/auth')`
block (lines 15-19). Middleware default-denies unauthenticated access to
`/projects/*` before the layout ever runs.

Keep `void (await cookies())`.

Acceptance criteria:
- The layout module imports no Supabase server client.
- `/projects` remains absent from `PUBLIC_ROUTES` in `middleware.ts`.
- An unauthenticated request to `/projects/<id>` still redirects to
  `/auth?redirect=…` (behavior owned by middleware, asserted by test).

#### R3. Add `loading.tsx` for `projects/[id]/`

**File:** `apps/web/src/app/(app)/projects/[id]/loading.tsx` (new)

Modeled structurally on `projects/[id]/files/loading.tsx`. Its purpose is
twofold: paint instantly on click, and give Next.js a prefetch target for a
dynamic route.

`projects/[id]/page.tsx` has no wrapper of its own — it returns `<ProjectHome>`
directly, and `ProjectHome` supplies the container
(`project-home.tsx:140-142`). The loading boundary must therefore match
**`ProjectHome`'s root**, not `page.tsx`:

```
bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden px-4.5
```

Inside it, static placeholder blocks built only from Tailwind classes. It must
not import heavy feature modules — a large payload defeats the prefetch it
exists to enable — and specifically must not import `ProjectHome`, which pulls
the composer, `SessionWelcome`, and the billing stack.

Acceptance criteria:
- The file exists and default-exports a component.
- It imports nothing from `@/features/project-files`, `@/features/file-viewer`,
  or `@/features/workspace/project-layout/project-home`.
- Its outer container classes match `ProjectHome`'s root, so the handover does
  not shift layout.

#### R4. Delete dead middleware code

**File:** `apps/web/src/middleware.ts`

Remove `PROTECTED_ROUTES` (never read) and the `BILLING_ROUTES` no-op branch
plus its now-unused constant.

Rationale: R2 asks reviewers to trust the default-deny gate. A dead allowlist
that appears to be the gate actively obstructs that review.

Acceptance criteria:
- No behavioral change to any route's auth outcome.
- Both constants and the dead branch are gone.

#### R5. Upgrade to Next.js 16.2.0

**Why 16.2.0 and not 16.3.0 (decided 2026-08-04).** The repo `.npmrc` sets
`minimum-release-age=4320` (72h) as supply-chain hardening. `next@16.3.0` was
published 2026-08-03T20:34Z and is refused by pnpm, as are `next-intl@4.13.5`,
`@next/third-parties@16.3.0`, `eslint-config-next@16.3.0` and
`fumadocs-mdx@15.2.2`. The user chose 16.2.0 over adding exclusions to
`minimumReleaseAgeExclude`, which the `.npmrc` reserves for emergency hotfixes
and gates behind a security review. Nothing this work depends on is lost:
Turbopack-by-default, the prefetch-cache rewrite (layout dedup + incremental
prefetching), `proxy.ts` and React 19.2 all shipped in 16.0.0.

**Package changes** (`apps/web/package.json`, `apps/whitelabel-demo/package.json`,
root `package.json`):

| Package | From | To |
|---|---|---|
| `next` | 15.5.21 | 16.2.0 |
| `react`, `react-dom` | ^19.1.0 | ^19.2.0 |
| `@types/react`, `@types/react-dom` | ^19.1.17 / ^19.2.3 | latest |
| `eslint-config-next` | 15.2.2 | 16.2.0 |
| `@next/third-parties` | ^15.3.1 | ^16.2.0 |
| `@sentry/nextjs` | ^10.47.0 | ^10.69.0 |
| `next-intl` | ^4.5.3 | ^4.13.4 |
| `@logtail/next` | ^0.3.1 | ^0.4.0 |
| `fumadocs-core`, `fumadocs-ui` | 15.8.5 | 16.14.0 |
| `fumadocs-mdx` | 11.10.1 | 15.2.1 |

Root `pnpm.overrides` next pin must be updated in lockstep, and
`apps/whitelabel-demo` bumped so the workspace resolves one Next version.

**Config changes** (`apps/web/next.config.ts`):
- Delete the `webpack` block. Turbopack is the default builder in 16, and a
  custom `webpack` config makes `next build` **fail**. `turbopack.resolveAlias`
  already externalizes `canvas`, so the block is redundant.
- Delete the `eslint` key — removed in 16.

**Script changes** (`apps/web/package.json`):
- `"lint": "next lint"` → ESLint CLI (`next lint` is removed in 16).
- Drop `--turbopack` from the `dev` script; it is the default.

**Markup change** (`apps/web/src/app/layout.tsx`):
- Add `data-scroll-behavior="smooth"` to `<html>` to preserve the
  `scroll-behavior: smooth` set at `globals.css:774`. Next 16 no longer
  overrides it during transitions by default.

**Verified non-issues** (confirmed absent by grep, no work required):
`revalidateTag`, parallel routes / `default.js`, `next/legacy/image`, `useAmp`,
`serverRuntimeConfig` / `publicRuntimeConfig`, `unstable_rootParams`,
`experimental_ppr`, `unstable_cacheLife` / `unstable_cacheTag`.

**Already compliant** (no work required): flat ESLint config
(`apps/web/eslint.config.mjs`), top-level `turbopack` key, explicit
`images.qualities`, async `params` / `searchParams`, `devIndicators: false`
(only the three sub-options were removed), Node 22, TypeScript 5.

Acceptance criteria:
- `next build` completes successfully with the default (Turbopack) builder.
- The docs site (`/docs`, `/use-cases`) builds and renders under fumadocs 16.
- One Next.js version resolves across the workspace.

### P1 — Nice to have

- **R6.** Explicit `prefetch` on the session-list `<Link>`s
  (`project-session-list.tsx:373`, `:523`). Deliberately deferred: Next 16's
  rewrite already prioritizes prefetch on hover and cancels on viewport exit, so
  the default may be sufficient once R3 gives it something to store. Decide
  after R3 and R5 land.

### P2 — Future considerations

- **R7.** `middleware.ts` → `proxy.ts`.
- **R8.** `supabase.auth.getClaims()` in middleware, conditional on the project
  using asymmetric JWT signing keys.
- **R9.** Bundle-size investigation of `@/features/project-files`.
- **R10.** Replace the floating `"@supabase/ssr": "latest"` and
  `"@supabase/supabase-js": "latest"` specifiers with pinned versions. Noticed
  during this work; a floating `latest` in a lockfile-managed monorepo is a
  reproducibility hazard.

---

## Testing

Test-first for every requirement. Each test must be observed failing before the
corresponding implementation lands.

| Requirement | Test | Location |
|---|---|---|
| R1 | TTL hit issues no fetch; concurrent calls coalesce to one; `setMaintenanceConfig` invalidates | extend `apps/web/src/lib/maintenance-store.test.ts` |
| R2 | `/projects` absent from `PUBLIC_ROUTES`; layout imports no Supabase server client | new `apps/web/src/app/(app)/projects/[id]/project-layout-auth-contract.test.ts` |
| R3 | `loading.tsx` exists; imports no heavy feature module | new contract test mirroring `files-route-contract.test.ts` |
| R4 | no dedicated test — pure deletion of code with zero referents (verified by grep). R2's gate assertion plus the existing suite cover the behavior. | — |
| R5 | `next build` succeeds | manual gate, recorded in PR |

The R2 test is the load-bearing one. It converts an invisible assumption ("the
middleware gate covers this route") into a failing test if anyone ever adds
`/projects` to `PUBLIC_ROUTES`, instead of silently leaving the layout
unauthenticated.

Existing suites must stay green: `bun test` in `apps/web`.

---

## Verification

Agreed with the user: build yes, browser no. This overrides the repo
`CLAUDE.md` end-to-end requirement.

1. `bun test` in `apps/web`
2. `npx eslint <changed files>`
3. `tsc --noEmit`, filtering for changed files only — the repo emits ~1500 known
   bogus `TS2786` errors from a React 19↔18 types mismatch
4. `next build` — the real gate for the Turbopack switch and fumadocs 16

**Explicitly not verified:** click-to-paint latency. No browser is driven and no
dev stack is booted, per standing instruction. The PR must state this plainly
rather than imply a measured improvement.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| fumadocs 15→16 + mdx 11→15 breaks the docs site | high | Isolate as its own commit. 11 files, all docs/use-cases. If it stalls, pin fumadocs and drop R5's docs portion rather than blocking the navigation fix. |
| Removing the `webpack` block breaks the canvas/Konva externalization | medium | `turbopack.resolveAlias` already covers it. `next build` proves it. Fallback: `next build --webpack`. |
| R2 removes auth that middleware does not actually cover | low | Default-deny verified in source; guarded by the R2 contract test. |
| Maintenance lockdown delayed by up to 5s | low | Accepted and documented. `setMaintenanceConfig` invalidates immediately. |
| Navigation is still slow after all of this | medium | The dominant term is unmeasured. If it persists, the next suspects are P2 R9 (bundle size) and Non-Goal 2 (`staleTimes`). |

---

## Open Questions

1. **(engineering, non-blocking)** Does the production Supabase project use
   asymmetric JWT signing keys? Determines whether P2 R8 is a real win or a
   no-op. Answerable only from the Supabase dashboard.
2. **(engineering, non-blocking)** Is 5 seconds the right maintenance-config
   TTL? Chosen as an obviously-safe default. Any value from 1–30s is defensible.
3. **(user, non-blocking)** After R3 and R5 land, is navigation acceptable, or
   is P1 R6 / Non-Goal 2 needed? Requires the user to exercise the UI, since
   this work does not measure latency.

---

## Delivery

- Branch: `fix/slow-page-navigation`
- One PR to `main`, per the user's scope decision (navigation fix and Next 16
  upgrade together).
- Commits sequenced so the navigation fix is separable from the Next 16 upgrade
  if the latter has to be dropped.
