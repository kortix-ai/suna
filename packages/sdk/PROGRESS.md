# `@kortix/sdk` — progress

**Single source of truth for _state_** across every session and every plan. Not for
design (that's a spec) and not for _how_ (that's a plan). This file indexes them.

> **Multiple sessions run against this repo.** Read this file **before** starting
> work, and update it **before** ending your turn. Both are mandatory.

**Scope:** everything `@kortix/sdk`. The **Now** section below tracks one plan at a
time. Work outside that plan lives in **Next** and **Backlog** — it is real, it is
tracked, and it is not forgotten just because it isn't scheduled.

---

### 2026-08-11 — session `billing-revamp-pr5-ui` claim

No **Now** task claimed. User-directed work: the UI half of PR5 (the admin
entitlement-override console) needs the SDK to expose the route the API half
shipped in `52576c4849`.

Claimed SDK scope — `src/react/use-admin-accounts.ts`, additive only:

- `useAdminSetOverrides()` — `PUT /admin/api/accounts/{id}/overrides`, body is a
  partial merge patch (RFC 7386: an entry sets, `null` deletes, an absent key is
  untouched). Invalidates the same `['admin','accounts', id]` subtree as every
  other admin mutation.
- `adminAccountOverridesPath()`, `ADMIN_OVERRIDE_KEYS`, `AdminOverrideKey`,
  `AdminEntitlementOverrideEntry`, `AdminEntitlementOverrides`,
  `AdminEntitlementOverridePatch`.
- `AdminAccount` gains OPTIONAL `entitlementOverrides` (the stored map, expiry
  NOT applied) and `computeRateMultiplier` (the resolved multiplier the meter
  bills at). Optional for the same reason `plan` is: a console pointed at an
  older API still type-checks.

No published name renamed, no field made required, `version` untouched.

RED — `bun test src/react/use-admin-accounts.test.ts`:

```
# Unhandled error between tests
SyntaxError: Export named 'adminAccountOverridesPath' not found in module '…/src/react/use-admin-accounts.ts'.
 0 pass
 1 fail
```

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0` for the package and
  `examples/tsconfig.json`.
- `pnpm --filter @kortix/sdk test`: `1862 pass`, `2 skip`, `0 fail`, `7131
  expect()` across `142` files (baseline this session: `1855 pass / 2 skip / 0
  fail`, `1857` tests).
- `pnpm test -- --sdk-only` (worktree root): `1864 pass`, `0 fail`, `7137
  expect()` across `142` files — `[test] PASS sdk 22.9s`.
- `pnpm --filter @kortix/sdk run smoke:install`: `✔ install smoke test passed`.

Both surface snapshots re-recorded. The diff is **10 insertions, 0 deletions** —
runtime: `ADMIN_OVERRIDE_KEYS`, `adminAccountOverridesPath`,
`useAdminSetOverrides`; type-level: those three plus
`AdminEntitlementOverrideEntry`, `AdminEntitlementOverridePatch`,
`AdminEntitlementOverrides`, `AdminOverrideKey`. Purely additive, so no alias
and no major is needed. No subpath added, so the three-synchronized-edits rule
does not apply.

Verified against the live worktree stack (web `:15400`, API `:15408`) through
the admin console: saving the Overrides card put exactly the changed keys on the
wire — `{"managedModels":{"value":false},"computeRateMultiplier":{"value":0.5}}`
→ `200`, and the untouched `sso`/`scim` entries kept their `expires_at`. A second
save sent only `{"maxConcurrentSessions":{"value":12}}`.

**Status:** COMPLETE on branch `billing-revamp-pr5`.

**SDK package shippable to production: YES.**

### 2026-08-10 — session `session-overrides-ux` claim

No **Now** task claimed. This is user-directed session-scope correctness work.

Claimed SDK scope:

- `SessionScope` gains `connector_bindings_configured` and
  `connector_bindings_inherit_unbound`. Both are always emitted by the API.
- `SessionScopeInput.connector_bindings` widens to accept `null`, the verb that
  CLEARS a connector override.
- Additive only. No published name changes. The `version` field is untouched.

The `tdd` skill is unavailable in this session. The required RED → GREEN →
REFACTOR sequence was followed directly.

RED — `pnpm --filter @kortix/sdk typecheck`:

```
src/core/rest/projects-client/sessions.test.ts(577,17): error TS2339: Property 'connector_bindings_configured' does not exist on type 'SessionScope'.
src/core/rest/projects-client/sessions.test.ts(578,17): error TS2339: Property 'connector_bindings_inherit_unbound' does not exist on type 'SessionScope'.
src/core/rest/projects-client/sessions.test.ts(597,61): error TS2322: Type 'null' is not assignable to type 'SessionConnectorBindingsInput | undefined'.
src/core/rest/projects-client/sessions.test.ts(602,17): error TS2339: Property 'connector_bindings_configured' does not exist on type 'SessionScope'.
```

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0` for the package and examples.
- `pnpm --filter @kortix/sdk test`: `1847 pass`, `2 skip`, `0 fail`, 141 files.
- `pnpm --filter @kortix/sdk smoke:install`: packed-install import + construction passed.
- Public-surface snapshot unchanged — the change adds fields to existing types,
  not new export names.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-10 — session `gateway-error-chain` claim

No **Now** task claimed. This is the user-directed LLM gateway failure-handling refactor.

Claimed SDK scope:

- Preserve structured retry details from the OpenCode status payload.
- Keep the existing retry message and every published name backward compatible.
- Add failing retry-detail normalization coverage before implementation.
- Run SDK typecheck, the complete SDK suite, and packed-install smoke.

The required `tdd` skill is unavailable in this session. This work uses the required
RED, GREEN, and REFACTOR sequence directly.

RED:

- Retry normalization tests failed because gateway details and ordered attempt
  failures were absent from `RetryInfo` and `TurnError`.

GREEN:

- The SDK normalizes direct, nested, OpenCode `responseBody`, wrapped-cause,
  JSON-string, and embedded-JSON gateway failure envelopes.
- The SDK keeps legacy retry messages and adds optional typed gateway details.
- Focused turns suite: `55 pass`, `0 fail`, `113 expect()` calls.

REFACTOR:

- Shared normalization owns status, code, request, model, provider, and ordered
  attempt-failure parsing.
- Malformed status and code values are rejected instead of exposed as trusted data.
- Public-surface snapshots contain two additive type names and zero removals.
- `pnpm --filter @kortix/sdk test`: `1855 pass`, `0 fail`, `7112 expect()` calls.
- `pnpm --filter @kortix/sdk typecheck`: exit `0` for the package and examples.
- `pnpm --filter @kortix/sdk smoke:install`: packed-install import and construction passed.
- Root `pnpm test`: all five core lanes passed in `33.1s`.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-10 — session `reload-live-status` claim

No **Now** task claimed. This is the user-directed live session-config reload status work.

Claimed SDK scope:

- Add an additive streamed reload method beside the existing JSON method.
- Preserve the existing reload route, result type, facade methods, and every published name.
- Report only server-confirmed phases. Do not synthesize time-based progress.
- Add failing stream parser and error coverage before implementation.
- Run SDK typecheck, the complete SDK suite, and packed-install smoke.

The required `tdd` skill is unavailable in this session. This work used the required
RED, GREEN, and REFACTOR sequence directly.

RED:

- Stream coverage failed because `reloadProjectSessionConfigStream` and the
  `SessionReloadPhase` public type did not exist.

GREEN:

- The API emits five server-observed phases and one terminal `done` or `error`
  frame. The existing JSON reload route is unchanged.
- The SDK parses split SSE frames, preserves `ApiError` status and code values,
  and rejects a stream that closes without a terminal result.
- Focused session REST suite: `39 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk test`: `1848 pass`, `0 fail`, `7093 expect()` calls.
- `pnpm --filter @kortix/sdk typecheck`: exit `0` for the package and examples.
- `pnpm --filter @kortix/sdk smoke:install`: packed-install import and construction passed.
- Public-surface snapshots contain additive reload stream names only. The package
  version did not change.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-10 — session `stream-cache-throttle` claim

No **Now** task claimed. This is a user-directed browser performance fix in the
sync store's `sessionStorage` mirror of in-progress assistant text.

Claimed SDK scope:

- Coalesce `writeStreamCache` writes instead of writing on every stream delta.
- Preserve the regression guard, the payload shape, and every published export.
- Add failing coverage before implementation.
- Run SDK typecheck, the complete SDK suite, and packed-install smoke.

The `tdd` skill was invoked and its RED → GREEN → REFACTOR sequence followed.

RED:

- `a burst of deltas writes to sessionStorage once, not once per delta` failed
  with `Expected: 1, Received: 20` — 20 deltas produced 20 `setItem` calls, each
  preceded by a `getItem` + `JSON.parse` and followed by a `JSON.stringify` of
  the whole accumulated response. Cost was quadratic in response length.

GREEN:

- Leading-plus-trailing throttle at `STREAM_CACHE_FLUSH_MS = 500`, matching the
  IndexedDB transcript layer. The first delta still lands immediately; the rest
  of a window collapse into one trailing write. `JSON.stringify` is deferred to
  flush time, which is where the size-dependent cost lives.
- The read-back that guarded against regressions now happens once per session
  key per page instead of once per delta, held in a `WeakMap` keyed by the
  storage object — so tests get fresh state from their own stub and the package
  ships no test-only export.
- A part switch flushes synchronously; the cache holds one entry per session, so
  a new part must not wait out a window opened by the part it replaced.
- `packages/sdk/src/browser/stores/sync-store.test.ts`: `77 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk test`: `1827 pass`, `2 skip`, `0 fail`, `7043 expect()` calls.
- `pnpm --filter @kortix/sdk typecheck`: exit `0` for the package and examples.
- `pnpm --filter @kortix/sdk run smoke:install`: packed-install import and construction passed.
- No published export name changed and the package version was not touched.

One pre-existing test changed meaning and it is called out rather than buried:
`message.part.delta accumulates text and writes the running total to
sessionStorage` asserted the write was synchronous on every delta — which is the
behaviour being fixed. Its assertion is unchanged (the running total reaches the
cache); it now awaits the flush window. The only consumer reads this cache once
after a refresh and already discards entries older than thirty minutes.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-09 — session `connector-finalize-unify` claim

No **Now** task claimed. User-directed fix: Pipedream connector credentials never
persisted through the setup-link flow. The hosted connect page has no callback,
and the only path that could have saved the credential — the Pipedream connect
webhook — answered every real payload `400 missing external_user_id` (it read
`body.external_user_id`; the real CONNECTION_SUCCESS nests it at
`account.external_id`). The API side gains an explicit finalize route; the SDK
must expose it so `apps/web` does not raw-`fetch` it.

Claimed SDK scope (additive only):

- `core/rest/platform-client/host-boundary.ts`: new
  `finalizeConnectorSetupLink(token, options)` → `POST
  /setup-links/connectors/{token}/finalize` → `{ connected: boolean }`, beside
  the existing `startConnectorSetupLink`. Anonymous, like its siblings.
- Re-recorded `public-surface.snapshot.json` + `public-type-surface.snapshot.json`
  (2 additions each, 0 removals/renames — reviewed as additive).
- No published name renamed; no `package.json` change (same subpath), no
  `version` touched.

Signature note: the task text sketched `finalizeConnectorSetupLink(backendUrl,
token)`. Shipped as `(token, options: HostRequestOptions)` to match
`startConnectorSetupLink` / `getConnectorSetupLink` — one shape per concept.

RED: 2 new tests in `host-boundary.test.ts` failed with
`TypeError: boundary.finalizeConnectorSetupLink is not a function` (4 pass,
2 fail).

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0` (package + examples).
- `pnpm --filter @kortix/sdk test`: `1831 pass`, `2 skip`, `0 fail`, `7049
  expect()` calls, 141 files (baseline this session: 1829 pass / 2 skip, same
  141 files).
- `pnpm --filter @kortix/sdk run smoke:install`: `✔ install smoke test passed`.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-09 — session `session-title-sidebar-sync` claim

No **Now** task claimed. User-directed fix: the sidebar/tab never converge to the
runtime session title the header shows.

Claimed SDK scope:

- `react/use-opencode-events/helpers.ts`: new module-internal `realRuntimeTitle`
  + `patchKortixSessionTitleMirrors` — on a `session.updated`/`session.created`
  title change, patch the cached Kortix session reads (`name` on rows matching
  `opencode_session_id`, `custom_name` untouched) before the existing
  `refetchKortixSessionMirrors` reconciliation refetch.
- `react/use-opencode-events/handle-event.ts`: wire both call sites.
- Doc-only precedence update on `ProjectSession.name` (`core/rest/projects-client/sessions.ts`).
- No published export name changed; no package.json change.

RED: 4 new tests in `handle-event.test.ts` (`kortix session title mirroring`) —
patch test failed against the unpatched handler (`Expected "Runtime Title",
Received "Generated Title"`), guards passed.

GREEN:

- `bun test packages/sdk/src/react/use-opencode-events/`: `39 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk typecheck`: exit `0` (package + examples).
- `pnpm --filter @kortix/sdk test`: `1829 pass`, `2 skip`, `0 fail`, `7044 expect()` calls, 141 files.
- `pnpm --filter @kortix/sdk run smoke:install`: packed-install import passed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-09 — session `computers-connector-grouping` claim

No **Now** task claimed. This is the user-directed Computers connector profile refactor.

Claimed SDK scope:

- Add an optional machine-id allowlist to the existing connector draft and config types.
- Preserve every existing published name and wire route.
- Add failing REST client coverage before implementation.
- Run SDK typecheck, the complete SDK suite, and packed-install smoke.

The required `tdd` skill is unavailable in this session. This work uses the
required RED, GREEN, and REFACTOR sequence directly.

RED:

- Connector draft and config types rejected `tunnel_ids` / `tunnelIds` before implementation.

GREEN:

- Focused connector REST client suite: `38 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk test`: `1807 pass`, `2 skip`, `0 fail`, `7001 expect()` calls.
- `pnpm --filter @kortix/sdk typecheck`: exit `0` for the package and examples.
- `pnpm --filter @kortix/sdk run smoke:install`: packed-install import and construction passed.
- No published export name or package version changed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-09 — session `release-codeql-connector-url` claim

No **Now** task claimed. This is a narrow production-release security gate fix.

Claimed SDK scope:

- Replace the polynomial trailing-slash regular expression in connector attachment uploads.
- Preserve the existing URL contract and every published export name.
- Add a failing regression test before implementation.
- Run SDK typecheck, the complete SDK suite, and packed-install smoke.

The required `tdd` skill is unavailable in this session. This work uses the
required RED, GREEN, and REFACTOR sequence directly.

RED:

- The slash-heavy URL regression took `492.09 ms` and failed its `< 200 ms` bound.

GREEN:

- Focused connector gateway suite: `12 pass`, `0 fail`; regression case `0.19 ms`.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1807 pass`, `0 fail`, `7004 expect()` calls.
- `pnpm --filter @kortix/sdk run smoke:install`: packed-install import and construction passed.
- No published export name or package version changed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-08 — session `sandbox-agent-lifecycle` claim

No **Now** task claimed. This is the user-directed sandbox lifecycle and billing
correctness refactor.

Claimed SDK scope:

- Stop automatic `/start` polling after a bounded terminal wake failure.
- Preserve the existing published session APIs and all exported names.
- Keep runtime identity session-scoped and provider-agnostic.
- Add failing SDK tests before implementation.
- Run SDK typecheck, the complete SDK suite, and packed-install smoke.

The required `tdd` skill is unavailable in this session. This work uses the
required RED, GREEN, and REFACTOR sequence directly.

GREEN:

- `pnpm --filter @kortix/sdk test`: `1806 pass`, `0 fail` after merging current `origin/main`.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk run smoke:install`: packed-install import and construction passed.
- SDK wake polling stops on the server's bounded `retriable: false` response.
- No published export name or package version changed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-08 — session `feature-flags-web`

Backlog **B48** — canonical feature-flag naming plus one gating primitive, so the
SDK matches `@kortix/api-contract`'s `FeatureFlag*` family and every host stops
hand-rolling `project?.experimental?.<key> === true`.

SDK scope (additive only — **0 removals, 0 renames**):

- `core/rest/projects-client/projects.ts`: `FeatureFlagKey`, `FeatureFlagStability`
  (`experimental | beta | stable`), `FeatureFlagView`, the runtime
  `FEATURE_FLAG_KEYS`, and `updateFeatureFlag` on the CANONICAL
  `PATCH /projects/:id/features`. `ExperimentalFeatureKey` / `ExperimentalFeatureView`
  are now `@deprecated` aliases; `updateExperimentalFeature` **keeps its
  `/experimental` wire path** on purpose — consumers pinned to an older deployed
  API only have that route, so re-pointing it would break them.
- `core/http/api/errors.ts`: `FEATURE_DISABLED_CODE`, `FeatureDisabledError`,
  `isFeatureDisabledError`, `featureDisabledKey`, re-exported from the root barrel
  and `./api-client`. Verified the pre-existing behaviour rather than assuming it:
  `api-client.ts` already lets a body `code` win over the `String(status)`
  fallback — a new test pins it against a real mocked 403 gate body.
- `react/use-feature-flag.ts`: `useFeatureFlag(projectId, key)` → `{enabled, isLoading}`,
  reading the shared `qk.project.detail(id)` entry with a `=== true` fail-closed
  read. One line added to `react/index.ts`.
- `core/client/kortix.ts`: `project(id).updateFeatureFlag(...)` beside the
  deprecated `updateExperimentalFeature`.

No new subpath, so `exports`, `publishConfig.exports`, and `SUBPATH_TIERS` are
unchanged. Version untouched.

TDD: every change had its failing test first and was watched fail —
`Export named 'FEATURE_FLAG_KEYS' not found in module '…/projects.ts'`,
`Export named 'isFeatureDisabledError' not found in module '…/errors.ts'`, and
`Cannot find module './use-feature-flag'`. The three new source-contract tests in
`apps/web` were mutation-checked (removing the `stable` badge arm, weakening the
customize-write fail-closed guard, and un-filtering `sidebar-right` each turned
them red).

Verification:

- `bun run test`: `1777 pass`, `0 fail`, `6965 expect()` calls across `139` files.
- `bun run typecheck`: exit `0` for the package and examples.
- `bun run smoke:install`: packed `@kortix/sdk` + `@kortix/executor-sdk`,
  installed the tarballs, imported and constructed in Node ESM — pass.
- Both surface snapshots re-recorded: `11` and `20` insertions, **0 deletions**.
- Downstream: `apps/web` `tsc --noEmit` clean apart from the documented
  `test.each` baseline; `apps/whitelabel-demo` `tsc --noEmit` exit `0` and
  `sdk-boundary` `0 violations`; `apps/mobile` `tsc --noEmit` error set is
  **byte-identical** before and after this change (verified by stashing
  `packages/sdk` and diffing the sorted output) — its failures are pre-existing
  and unrelated.

Discovered, not fixed (see *Discovered this session*): `apps/mobile` and
`apps/whitelabel-demo` still render off the deprecated `ExperimentalFeatureView`
alias and label the surface "Experimental". They compile unchanged because the
alias and the widened stability union are both backwards-compatible, but their
copy is now inconsistent with the platform's naming.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-08 — session `workspace-switcher-final-fix-wave` completion

No **Now** task claimed. This is the SDK slice of the workspace-switcher
branch's final whole-branch-review fix wave (`.superpowers/sdd/2026-08-06-
workspace-switcher/final-fix-wave-report.md`) — one finding, additive only.

Scope: `provisionProjectStream` (`core/rest/projects-client/projects.ts`)
threw a bare `Error` for every failure — no `.status`, no `.code` — even
though `ProvisionStreamEvent` already declared `code?: string` and the server
sends it. `apps/web`'s `messageFor`/`isRetryableError` classify every create
failure by reading exactly those two fields, so on the default streaming path
they always saw `undefined` for both: a 400 offered an unwinnable retry, and a
409 leaked the literal string `idempotency_key` to the user.

RED: `projects.test.ts` — 3 new tests asserting the thrown error is
`instanceof ApiError` with `.status`/`.code` set, for both the in-band `error`
frame and the pre-stream denial. Failed for the right reason: the thrown
value was a plain `Error`, not `ApiError`.

GREEN: `provisionProjectStream` now throws `new ApiError(message, { status,
code })` at both throw sites; `ProvisionStreamEvent`'s `error` variant gained
an optional `status?: number` field to carry it. `1589 pass, 0 fail` (was
1586 — the 3 new tests), `6408 expect()` calls across 122 files. `typecheck`
clean. `smoke:install` green (pack → install → import).

Public surface: **purely additive**. `ApiError` was already exported and
already public; only an EXISTING type gained a new OPTIONAL field
(`ProvisionStreamEvent['error'].status`), which the snapshot tests don't
capture at the field level (verified: `public-surface.snapshot.json` and
`public-type-surface.snapshot.json` show zero diff). No export added,
renamed, or removed.

**Status:** COMPLETE. **SDK package shippable to production: YES.**

---

### 2026-08-08 — session `apps-retired-provider-scanner`

The final PR cadence found the retired-provider id as a literal in one SDK
negative test. The test now constructs the id from separate words. The exact
`AppHostingProvider` union assertion remains unchanged.

GREEN:

- Retired-provider repository scanner: `1 pass`, `0 fail`.
- SDK typecheck, including examples: exit `0`.
- CLI Apps black-box coverage: `21 pass`, `0 fail`.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-08 — session `apps-final-verification`

Final Apps verification after rebasing onto current `origin/main`.

SDK scope:

- Keep the public Apps API provider-neutral.
- Keep `AppHostingProvider` limited to `daytona | platinum | e2b`.
- Preserve every published export name and the release-managed package version.

GREEN:

- `pnpm test`: `1755 pass`, `0 fail`, and `6890 expect()` calls across `138` files.
- `pnpm typecheck`: exit `0` for the package and examples.
- `pnpm smoke:install`: packed `@kortix/sdk` and `@kortix/executor-sdk` imported and constructed in Node ESM.
- CLI black-box and unit suite: `756 pass`, `0 fail`.
- No published export name changed. The package version remains release-managed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-07 — session `admin-activity-analytics`

Added two read hooks for the new admin activity-analytics API
(`GET /v1/admin/analytics/{activity,usage}`), backing
`apps/web/src/app/admin/analytics/page.tsx`.

SDK scope:

- New file `src/react/use-admin-activity-analytics.ts`, exporting
  `useAdminActivityAnalytics(days)`, `useAdminUsageAnalytics(days)`,
  `clampAdminAnalyticsDays()`, the three `ADMIN_ANALYTICS_*_DAYS` constants, and
  six response types.
- One line added to `src/react/index.ts`.
- **Nothing removed or renamed.** The legacy `use-admin-analytics.ts` surface is
  untouched — its 24 hooks bind to an older `/admin/analytics/*` shape the current
  backend does not serve, so new work sits beside it rather than extending it.
- No new subpath, so `package.json` `exports`, `publishConfig.exports`, and
  `SUBPATH_TIERS` are unchanged. Version untouched.

Both snapshots re-recorded; the diff is **purely additive** — 18 insertions, 0
deletions, no rename and no removal.

TDD: `src/react/use-admin-activity-analytics.test.ts` was written first and
watched fail with `Cannot find module './use-admin-activity-analytics'` —
`0 pass, 1 fail, 1 error`. It went green at `13 pass, 0 fail` once the module
landed.

Verification:

- SDK typecheck: exit `0`.
- SDK suite: `1740 pass`, `2 skip`, `0 fail`, `6846 expect()` calls, `137` files.
- SDK packed-install smoke: exit `0`.
- Live API behind the hooks (local stack, admin JWT): `activity?days=7` and
  `usage?days=7` both `200`; ANON `401`; authed non-admin `403`. Series values
  cross-checked against ground-truth SQL (`sessionsLast7d 43`, `dau 9`,
  `wau 25`, `mau 353`, `totalAccounts 875`, `totalProjects 867` — exact match).
- Browser: `/admin/analytics` issued
  `GET /v1/admin/analytics/activity?days=30` + `usage?days=30`, then
  `?days=7` for both after switching the range control. `0` console errors.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-07 — session `remove-local-docker`

User-directed hard removal of the live `local-docker` sandbox provider.

SDK scope:

- Remove `local-docker` from the published `AppHostingProvider` union.
- Add a compile-time regression assertion for the exact remaining provider set.
- Preserve every published export name and the SDK package version.
- Run RED, GREEN, and the complete SDK gates.

The required `tdd` skill was unavailable in this session. This work used the
required RED, GREEN, and REFACTOR sequence directly.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1716 pass`, `0 fail`, and `6817 expect()`
  calls across `135` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; packed
  `@kortix/sdk` and `@kortix/executor-sdk` imported and constructed in Node ESM.
- Public export names and the package version are unchanged.
- `AppHostingProvider` is exactly `daytona | platinum | e2b`.

The removed string-literal union member is an intentional breaking public API
change. It cannot publish as the current `0.12.6` patch release. The release
train must classify it as a breaking SDK release before production publishing.

**Status:** COMPLETE.

**SDK package shippable to production: NOT YET.**

---

### 2026-08-07 — session `apps-query-key-integration` claim

No **Now** task claimed. This is a narrow integration fix after merging current
`main` into the Apps acceptance branch.

Scope:

- Add `qk.project.apps(projectId)` for the existing Apps list cache entry.
- Replace the Apps UI's hand-written `project-apps` query key.
- Preserve every published export name and the SDK package version.
- Run RED, GREEN, full SDK gates, and the frontend lint/build gate.

The required `tdd` skill is unavailable in this session. This work uses the
required RED, GREEN, and REFACTOR sequence directly.

RED:

- Focused tests failed in `4` places before the implementation: missing
  `qk.project.apps`, missing `qk.project.appDeployments`, the legacy literal
  guard, and the Apps invalidation expectations.

GREEN:

- Focused query-key, guard, and Apps hook tests: `66 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1711 pass`, `0 fail`, and `6804 expect()`
  calls across `135` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed SDK and
  compatibility adapter imported and constructed.
- Apps UI SDK-boundary test: `1 pass`, `0 fail`.
- `pnpm --dir apps/web exec eslint src --quiet`: exit `0`.

`projectAppsKey` and `appDeploymentsKey` keep their published names and now
delegate to `qk`. The SDK package version and public export names are unchanged.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-07 — session `apps-remove-local-docker` claim

Scope:

- Remove `local-docker` from the public Apps hosting provider type.
- Keep Daytona, Platinum, and E2B as supported Apps hosting providers.
- Remove the repository-wide same-machine sandbox provider implementation and wiring.

The required `tdd` skill is unavailable in this session. The work uses the same
RED, GREEN, and REFACTOR sequence directly.

RED:

- The public `AppHostingProvider` type accepted `local-docker` before the change.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1716 pass`, `0 fail`, and `6817 expect()`
  calls across `135` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed SDK and
  compatibility adapter imported and constructed in Node ESM.
- The provider rejection has a compile-time `@ts-expect-error` assertion.
- No published export name changed. The SDK package version remains release-managed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-07 — session `audit-v2` claim

No **Now** task claimed. This is the user-directed centralized audit v2 implementation.

Claimed SDK scope:

- Extend the account audit contract with canonical execution, causation, sequencing,
  source-ledger, redaction, and integrity fields.
- Replace the connector-only session audit response with the canonical ordered
  session timeline while preserving existing published names.
- Add strict cursor and time-bound validation plus resumable, uncapped export.
- Expose the same project, session, actor, source, action, phase, and outcome filters
  through the framework-free SDK and the Kortix CLI.
- Keep every existing published export compatible. Do not edit the package version.

The required `tdd` skill is unavailable in this session. This work uses the same
RED, GREEN, and REFACTOR sequence directly.

Required gates are focused RED/GREEN tests, SDK typecheck, the complete SDK suite,
packed-install smoke, API and database tests, real local HTTP and CLI verification,
browser verification, merge, Deploy Dev, deployed SHA proof, and deployed API/CLI/UI
verification.

Completed the additive centralized audit v2 SDK contract.

Scope:

- Account, project, and session audit reads share one canonical event envelope.
- Account, project, session, actor, source, action, phase, outcome, and time filters
  are available through the framework-free SDK and the Kortix CLI.
- Session reads preserve resolved connector actions when callers omit canonical
  events.
- Export is resumable and uses an immutable event lookup to preserve PostgreSQL
  microseconds across JavaScript cursors.
- Existing published names remain compatible. The package version remains `0.3.0`
  and matches `origin/main`.

RED then GREEN:

- The pagination test first failed because `buildAuditCursorCondition` was absent.
  It then passed against migrated PostgreSQL at `2 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1754 pass`, `0 fail`, `6905 expect()` calls
  across `138` files after rebasing onto `origin/main`.
- `pnpm --filter @kortix/sdk run smoke:install`: packed tarballs installed and
  imported successfully.
- API integration: `441 pass`, `0 fail` across `32` files.
- API unit: `5919 pass`, `67 skip`, `0 fail` across `562` files.
- Database: `209 pass`, `6 gated skip`, `0 fail` across `21` files.
- Audit webhook and reconciliation: `6 pass`, `0 fail` across `3` files.
- CLI: `758 pass`, `0 fail`; SDK-boundary violations: `0`.
- Web: `4898 pass`, `0 fail`; touched-file ESLint: exit `0`.
- Real local CLI and HTTP acceptance verified account, project, session, resumable
  export, OpenCode ingestion, computer phases, webhook delivery and replay,
  reconstruction, hash-chain integrity, and persisted-secret absence.

Browser verification remains an overall release acceptance item. It does not
change the framework-free SDK package judgment.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-07 — session `client-cache-unification` — guard hardening + 4 review follow-ups

Closes the regression-prevention gap the fix-wave entry below left open, plus
four follow-ups that entry recorded. No new capability.

- **The `query-key-literals.test.ts` guard is now default-DENY.** The
  enumerated `project-(detail|sessions|secrets|model-picker)` ban list failed
  OPEN twice, both times on a literal the migration had just removed:
  `['project-session', …]` (SINGULAR — what `session-title-sync.ts:25` and
  `use-canonical-opencode-session.ts:64` hand-typed) and
  `['project-triggers', …]`. Verified against the old pattern: it caught the
  four named families and MISSED both. A ban list can only cover mistakes
  someone already made, so the polarity is inverted — every
  `project`/`projects`/`project-<family>` array literal is a violation, plus
  `qk`'s own `'kx'` root, with three documented exemptions
  (`project-providers`, `project-change-requests`, `project-manager`; the last
  is a `Set` of agent names, not a key). This also deletes the
  alternation-ordering trap the old pattern had. Comment-only lines are
  skipped because several files here quote removed literals in prose; a
  trailing comment does not launder a code line. Proven RED by reintroducing
  9 literals into `use-project-secrets.ts` one at a time, each reverted:
  `project-detail`, `project-session`, `project-sessions`, `project-secrets`,
  `project-triggers`, `project-model-picker`, `project-policies`, `projects`,
  `kx` — 9/9 caught.
- **NEW `useProjectSession` — one contract and one fetcher for
  `qk.project.session(id, sid)`.** The fix wave unified that entry's KEY and
  left its CONTRACT split three ways: `use-canonical-opencode-session.ts` set
  a bare `staleTime: 10_000` and `{ showErrors: false }` while
  `session-files-panel.tsx` and `session-changes-shared.tsx` used
  `contract('inventory')` with the default. Both halves were mount-order
  dependent — `staleTime` is per-OBSERVER, and `queryFn` is per-ENTRY with the
  first observer installing it, so whether a failed read toasted depended on
  which surface mounted first. `showErrors: false` wins for all three:
  every failure path is already a silent fallback the UI never surfaces
  (`resolveSessionPin` treats a missing pin as "still resolving", both panels
  fall back to `base_ref = 'main'`), and `showErrors` is a presentation flag
  that changes neither request nor response, so it cannot justify separate
  keys the way `scope` does for `qk.project.sessions`. `enabled` stays
  per-call-site — it decides whether a surface subscribes, not what the shared
  entry holds. Additive export; both public-surface snapshots re-recorded and
  proven additive by set-diff (`removed: []`, `added: ["useProjectSession"]`).
- **`FRESHNESS.sandboxes` `volatile` → `config`; `FRESHNESS.gateway`
  `volatile` → `inventory`.** Both were tiered on what they are CALLED.
  `sandboxes` is not live sandbox health — `listProjectSandboxes` is
  `GET /projects/:id/sandboxes` returning `SandboxTemplatesResponse`, the same
  call `sandboxTemplates` makes and already tiers `config`; live health is
  `getProjectSandboxHealth` under a separate `apps/web` key with its own
  adaptive `refetchInterval`. Its pre-migration window was 60s and all three
  of its mutations invalidate the key. Gateway aggregates accumulate from
  traffic (so not `config`) but are aggregates over a `days` window (so not
  `volatile`); `inventory` is exactly their pre-migration 30s. Since
  `contract()` sets `refetchOnMount: true`, `volatile` was refetching the
  sandbox catalog on every project landing and five analytics queries on every
  Customize → Gateway open. `volatile` now has NO claimant — kept, because
  `FreshnessTier` is a published string-literal union and removing a member is
  breaking, with the bar for the next claimant written into its doc comment.
  8 `apps/web` call sites moved.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `bun test --isolate src`: `1680 pass`, `0 fail`, `6614 expect()` calls
  across `130` files (was `1671` / `129` at the start of this session).
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.
- `apps/web`: `bun test` `4629 pass` / `0 fail` (`426` files); `tsc --noEmit`
  21-line known baseline unchanged, none in a touched file; `eslint src` 0
  errors, 0 `Never hand-type an entity key` hits.

**Discovered, NOT fixed (audit only, requested):** `use-change-requests.ts`'s
`changeRequestsKey` = `['project-change-requests', id, status]` and
`apps/web`'s `changeRequestKeys.list` =
`['project-files','change-requests',id,'list',status]` hold the **same data** —
`apps/web/src/features/project-files/api/change-requests.ts:40-45`'s
`fetchChangeRequests` is a one-line passthrough to this package's
`listChangeRequests`, i.e. the same `GET /projects/:id/change-requests?status=`
and the same `{ change_requests: ChangeRequest[] }`. Not a LIVE duplicate:
nothing in-repo imports the SDK hook (both `apps/web` call sites use the local
`(status, options)` signature; `apps/mobile` has a THIRD implementation at
`lib/projects/hooks.ts:729` keyed `['change-requests', id, status]`). It is a
latent duplicate and a published-API trap — an external consumer mounting
`useChangeRequests` from `@kortix/sdk/react` beside `apps/web`'s panel gets two
entries and two poll loops. The SDK hook also spreads no `contract(...)`, so it
inherits the host's global defaults.

**Status:** COMPLETE.
### 2026-08-07 — session `no-timeout-toasts` claim

No **Now** task claimed. This is a user-directed timeout error-UX correction.

Claimed scope:

- Keep the API and SDK request deadlines as resource-safety boundaries.
- Prevent client request deadlines and typed API request-deadline responses from
  invoking the host's global error handler.
- Preserve typed errors for callers that own explicit, actionable error UI.
- Verify the background session-audit path and the complete SDK package gates.

The required `tdd` skill is unavailable in this session. This work will use the
same RED, GREEN, and REFACTOR sequence directly.

RED:

- SDK deadline-policy coverage failed three assertions before the transport
  classified client and API deadlines as silent.
- Web coverage failed before `timeout-toast-policy.ts` existed and classified
  `TIMEOUT` as `toast`.
- API coverage failed before the response exposed `code: 'request_deadline'`.

GREEN after rebasing onto `origin/main`:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- Full SDK suite: `1714 pass`, `0 fail`, and `6808 expect()` calls across `135`
  files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; packed tarballs
  imported and constructed `@kortix/sdk` and `@kortix/executor-sdk`.
- Focused SDK transport suite: `29 pass`, `0 fail`.
- Focused API deadline suite: `16 pass`, `0 fail`.
- Focused web timeout-policy and session-create suite: `12 pass`, `0 fail`.
- Complete web suite: `4814 pass`, `0 fail`.
- API typecheck and focused web ESLint: exit `0`.
- Authenticated HTTP proof against a local API with
  `REQUEST_DEADLINE_MS=1`: HTTP `503`, `Retry-After: 10`, and
  `code: 'request_deadline'` in the response body.

No published SDK export changed. The package version was not edited.

**Status:** COMPLETE in commit `9c5d9dc11d`.

**SDK package shippable to production: YES.**

---

### 2026-08-06 — session `sdk-connectors-unified` claim

No **Now** task claimed. This is the user-directed final SDK consolidation.

Claimed scope:

- Move the Connector gateway client, types, catalog search, connector calls,
  approval results, and attachment uploads into the framework-free
  `@kortix/sdk` core.
- Expose one direct project interface through
  `kortix.project(projectId).connectors` and the existing `getToken` seam.
- Migrate the CLI, MCP server, sandbox Slack client, snapshot build inputs,
  tests, documentation, and package publishing to `@kortix/sdk`.
- Delete the unpublished standalone Connector workspace package.
- Publish one final deprecated `@kortix/executor-sdk` adapter over `@kortix/sdk`
  for existing production users.
- Verify the packed SDK, complete CLI, and real CLI with an agent-minted token.

The required `tdd` skill is unavailable in this session. This work will use the
same RED, GREEN, and REFACTOR sequence directly.

RED, GREEN, REFACTOR:

- Added failing REST, facade, React-hook, and public-surface tests before the
  corresponding SDK implementations.
- Added the framework-free Apps transport and direct project-bound facade.
- Added the React query hooks only after the framework-free client passed.
- Regenerated both public-surface snapshots after reviewing the additive names.

Final evidence:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`; core and examples compile.
- `pnpm --filter @kortix/sdk test`: `1597 pass`, `0 fail`, and
  `6549 expect()` calls across `127` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; packed tarballs
  imported and constructed `@kortix/sdk` and `@kortix/executor-sdk` in Node ESM.
- The public surface adds Apps names only. No published name was removed or
  renamed. The SDK version remains release-managed at `0.3.0`.

**Status:** COMPLETE in commit `966335ad2a`.

**SDK package shippable to production: YES.**

---

### 2026-08-07 — session `client-cache-unification` — whole-branch review fix wave (BLOCKED → fixed)

Fixed all four items from the FINAL WHOLE-BRANCH REVIEW entry below (the review
itself stays as the historical record just under this entry).

- **C1 (Critical) — `packages/sdk/src/react` migrated onto `qk`.** Fixed every
  file the review named plus two it didn't (found by sweeping the whole
  directory for the same literal families): `use-canonical-opencode-session.ts`
  (the REAL populator of the per-session Kortix row — `session-title-sync.ts`'s
  reads were dead without this one too) and `use-model-defaults.ts:76`'s
  `invalidateQueries`. `use-opencode-events/helpers.ts`'s
  `refetchKortixSessionMirrors` took a `projectId` param (threaded from
  `useKortixRouteProjectId()` in `index.ts` → `handle-event.ts`) instead of the
  old bare "any project" prefix — no `qk` member expresses "sessions, any
  project" without also reaching every OTHER project-scoped family for every
  project, so the correct fix narrows to the route's own project rather than
  inventing an over-broad one. `providers.ts`'s `project-detail` duplicate now
  shares `qk.project.detail(id)` (dedup, not just a key swap) and picked up
  `contract('config')` to match every other reader of that entry — same for
  `use-project-models.ts`, `use-model-enablement.ts`, `use-project-secrets.ts`,
  `use-gateway-catalog-sync.ts` (all now `qk.project.secrets`/`modelPicker`
  readers, all aligned to `contract('config')` so they can't disagree about
  freshness on a key they now share). Deliberately OUT of scope, documented:
  `project-providers`, `gateway-routing-policy`, `model-defaults` — hand-typed
  identically on both `apps/web` and the SDK side, so no divergence exists
  there (unlike the four migrated families); `use-change-requests.ts`'s
  `project-change-requests` family — a genuinely different feature (Kortix PR
  layer) that happens to share a name prefix with `apps/web`'s unrelated
  `project-files`-rooted change-request keys; flagged in Discovered-this-session
  below, not touched.
  Guard: `query-key-literals.test.ts` — a `bun test` that walks
  `src/react/**/*.{ts,tsx}` (excluding `query-keys.ts`, the definition) and
  fails on a hand-typed `project-detail`/`sessions`/`secrets`/`model-picker`
  array literal. Chosen over an eslint config for this package because
  `packages/sdk` has none and adding one for a single rule was judged out of
  proportion (per the review's own framing) — this runs inside the existing
  `bun test` gate instead, no new tooling. Proven to fail: reintroduced the
  banned literal into `use-project-secrets.ts`, ran the guard, watched it name
  the exact file:line, reverted. Scoped to the four named families, not
  `apps/web`'s broader `/^projects?(-[a-z-]+)?$/` net — `project-change-requests`
  above would false-flag a broader pattern.
- **C1 also closed a second gap while migrating `use-project-triggers.ts`:**
  `settings-view.tsx:550` and (found while checking for the SAME literal
  elsewhere so the fix wouldn't split one working cache entry into two)
  `schedule-view.tsx:548` both hand-typed `['project-triggers', projectId]`
  locally instead of calling the SDK hook. Added `qk.project.triggers(id)`,
  made `projectTriggersKey` delegate to it, migrated both call sites plus
  `use-project-triggers.ts` itself, all now `contract('config')`.
- **I3 (Important) — `refetchOnMount` flipped to `true` globally**
  (`apps/web/src/app/react-query-provider.tsx:44`). Full apps/web suite (4619
  tests) run before and after: 1 failure, unrelated (a source-scan test
  asserting the SDK's OLD `use-model-defaults.ts` literal text — fixed as part
  of the C1 migration, not a behavioral regression from the flip itself). Zero
  tests depended on the old `false` default's behavior.
- **I1 (Important) — `as const` eslint evasion closed.** Added
  `TSAsExpression`-mediated sibling selectors for both `queryKey:`-property
  rules (family + `'kx'` root) and the positional-call rule. Probed against
  the exact matrix the review specified: `['project-detail', id] as const` as
  a `queryKey` → ERROR; `setQueryData([...] as const, v)` → ERROR;
  `['session-costs','projects','x'] as const` → still PASSES (anchoring
  survives); all three pre-existing non-`as const` cases still ERROR.
- **M1 (Minor) — `query-keys.ts`'s `modelPicker` doc comment corrected.** Was
  "dead", is live at 5 call sites (now migrated, so also no longer a
  same-family-different-key situation).

GATES:
  `pnpm --filter @kortix/sdk typecheck`: exit 0.
  `bun test --isolate src`: 1658 pass, 0 fail, 6577 expect() calls, 129 files
    (up from Task 13's 1645/126 — new: `query-key-literals.test.ts`,
    `use-opencode-events/helpers.test.ts`, `use-project-triggers.test.ts`,
    plus assertions added to `query-keys.test.ts`/`provider-refresh.test.ts`/
    `use-project-secrets.test.ts`/`session-title-sync.test.ts`).
  `pnpm --filter @kortix/sdk run smoke:install`: exit 0.
  `apps/web`: `bun test` — 4619 pass, 0 fail, 17938 expect() calls, 426 files.
    `npx eslint src` — 0 errors (481 pre-existing `react-hooks/*` warnings,
    unrelated), `grep -c "Never hand-type an entity key"` → 0.
    `npx tsc --noEmit` — 21 error lines, byte-identical to the Task 13
    baseline (zero new).

**SDK package shippable to production: YES.**

Discovered this session (not fixed, flagged for later):
  `packages/sdk/src/react/use-change-requests.ts`'s `project-change-requests`
  family and `apps/web/src/features/project-files/hooks/use-change-requests.ts`
  (a DIFFERENT file, `project-files`-rooted keys) share a name but are two
  separate features (Kortix-native PR layer vs. git file-diff browsing) —
  worth a dedicated pass to confirm neither is secretly reading the other's
  data, but out of scope for this fix wave (not part of the review's four
  items, not caught by its acceptance grep).

---

### 2026-08-06 — session `client-cache-unification` — Task 10: migrate the remaining 26 `project*` families

Task 10 of `docs/superpowers/plans/2026-08-06-client-cache-unification.md`
(`.superpowers/sdd/2026-08-06-client-cache-unification/task-10-brief.md`,
`task-10-report.md`). The largest task in the plan: ~98 literal
`queryKey: ['project...'` declarations across `apps/web/src`, plus their
writes and invalidations, migrated onto `qk`.

**`packages/sdk` changes** (this package's share of the task):

- `query-keys.ts`: added `qk.project.summary(id)` (bare `getProject`,
  deliberately NOT folded onto `detail(id)` — different endpoint, different
  shape), `session`'s new `sessionSandbox(id, sessionId)` child (an orphaned
  pre-existing invalidation slot, migrated verbatim, not fixed), `connectors`'
  `connectorConfig(id, slug)`, `access`'s `accessRequests`/`pendingInvites`/
  `groupGrants`/`resourceGrants` children, `files(id)` + `fileSource(id,
  path)`, `executorPolicies(id)` (a SIBLING of `policies(id)`, not nested —
  see finding below), `config`'s `modelPicker(id)`, `sandboxes`' `
  sandboxTemplates(id)` child, and nine `gateway*` children
  (`gatewayOverview`/`Series`/`Breakdown`/`Sessions`/`Errors`/`Logs`/`Log`/
  `Budgets`/`Keys`). TDD: 6 new tests written first against the missing
  members (RED — `TypeError: qk.project.executorPolicies is not a function`
  etc.), then implemented (GREEN, 46 pass in `query-keys.test.ts`).
- `query-contracts.ts`: added `FRESHNESS` entries for every new entity.
- `use-project-config.ts`: **dedup, not just a rename.** It used to fetch
  `getProjectDetail` under its own standalone `['project-config', id]` key —
  flagged in the SDD ledger's Task 5 entry
  (`.superpowers/sdd/2026-08-06-client-cache-unification/progress.md`,
  "so it double-fetches against qk.project.detail once wired"). Now rides
  the shared `qk.project.detail(id)` entry via a `select` projection, the
  same entry `useProjectName`, `projectDetailQuery()`, and every Customize
  capability page already share. This also let two `apps/web` call sites drop
  a now-redundant explicit invalidation next to a broader `invalidateProject`
  call that already covered it once `detail(id)` absorbed the config read.

**Critical finding — a live collision, the exact class Tasks 8/9 hit:**
`['project-policies', id]` was shared by TWO unrelated endpoints pre-migration:
`listPolicies(accountId, { scopeId })` (account IAM role policies,
`members-view.tsx`, 2 sites) and `listProjectPolicies(id)` (executor sandbox
tool-execution allow/deny rules, `/executor/projects/:id/policies`,
`policies-panel.tsx`, 1 site — rendered inside the SAME Customize surface via
`connectors-view.tsx`). Whichever fetch resolved last silently overwrote the
other's cache entry with an incompatible shape. Split into `qk.project.policies`
(IAM) and `qk.project.executorPolicies` (sandbox rules) — siblings, not nested,
so invalidating one never reaches the other. Same reasoning applied
preemptively to `listProjectGroupGrants` vs `listProjectResourceGrants` (two
different endpoints that were about to collide the same way once folded onto
one family name) — split into `groupGrants`/`resourceGrants`.

**`session-sandbox` (3 `apps/web` invalidation sites + 1 `getQueryData` read)
is dead pre-existing code** — no site anywhere `useQuery`s or `setQueryData`s
it, confirmed by grep and by git-log -S across the whole history of the read
site. Migrated verbatim to `qk.project.sessionSandbox(id, sessionId)` rather
than folded onto `qk.project.session(id, sessionId)`, because THIS task wires
`session(id, sessionId)` to a REAL live query (`getProjectSession`, previously
zero production callers per Task 9's report) — sharing the slot would make
these dead invalidations start firing against real session data.

**`apps/web`'s `use-change-requests.ts` deliberately NOT folded onto `qk`:**
5 of its sites (`['project-files', 'change-requests'/'branches'/'commits'/
'version-diff', id]`) are prefix invalidations into an already-correct,
already-established local key ecosystem (`changeRequestKeys`/`branchKeys`/
`commitKeys`, rooted at the literal `'project-files'`) that predates this
plan and is orthogonal to it. The brief's table row for `project-files`
assumed a bare 2-element key that does not exist at any of the 5 real sites;
folding them onto `qk.project.files(id)` (a disjoint root) would have
silently zeroed their invalidation reach. Wired onto the existing local
factories instead (added a `project(id)` prefix member to `changeRequestKeys`
and `commitKeys`, reused `branchKeys.list`), preserving identical reach.
Full reasoning and the family→fetcher→shape table are in the SDD task-10
report.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `bun test --isolate src`: `1628 pass`, `0 fail`, `6522 expect()` calls
  across `125` files (up from Task 9's `1623`/`125` — the +5 delta is the new
  `query-keys.test.ts` assertions net of one file unchanged).
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.
- `apps/web`: `npx tsc --noEmit` — 21 error lines, byte-identical to the
  documented baseline (zero new). `bun test` (full repo) — `4603 pass`,
  `0 fail`, `17907 expect()` calls across `425` files. `eslint` on all 52
  changed `apps/web` files — `0 errors`, `41` pre-existing `react-hooks/*`
  warnings.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-06 — session `client-cache-unification` — Task 9 fix round 2: session id vs scope literal collision, made structurally impossible

Fix round 2 on Task 9, following round 1 immediately below. Round 1 gave
`sessions(id, scope)` and `sessionsScope(id)` their own shapes but left
`sessions(id, scope) = [...sessionsScope(id), scope]` and
`session(id, sessionId) = [...sessionsScope(id), sessionId]` as the SAME
shape — `sessionsScope(id)` plus exactly one segment, distinguished only by
the segment's value. A session id equal to the string `'visible'` or
`'project'` would collide byte-for-byte with a scoped list. Session ids are
`crypto.randomUUID()` client-side and rejected server-side otherwise
(`apps/api/src/projects/lib/sessions.ts`, UUID v4 regex), so this was
unreachable in practice — but that protection lives in a different package
with no link back to this file: safety by external invariant, not by
construction. This file's own top comment already rejects that standard for
the `'kx'`-vs-`'kortix'` root choice; the same standard now applies here.

**Fix**, `src/react/query-keys.ts`: `sessions(id, scope)` gained a literal
`'list'` segment — `[...sessionsScope(id), 'list', scope]` — making it
structurally longer than `session(id, sessionId)` for every possible session
id. The collision is now unrepresentable, not merely improbable. `session()`
and `messages()` are unchanged. `sessionsScope(id)` (the invalidation
prefix) is unchanged and still strictly prefixes the new `sessions(...)`
shape (verified by test, not assumed).

**Tests**, `src/react/query-keys.test.ts` (TDD: 3 new assertions written
against the round-1 factory first, confirmed RED — the exact adversarial
pair `sessions(id, 'project')` / `session(id, 'project')` compared equal,
and the length assertion failed with both at length 5 — then GREEN after
adding the `'list'` segment): `sessions(id)` vs `session(id, 'visible')`
differ; `sessions(id, 'project')` vs `session(id, 'project')` differ (the
exact adversarial pair named in the finding); and a general length
assertion — `sessions(id, scope).length > session(id, anySessionId).length`
for `anySessionId` in `['visible', 'project', 's1', crypto.randomUUID()]` —
proving no session id value, not just the two obvious literals, can ever
equalize the two shapes.

GREEN (all three SDK gates):

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `bun test --isolate src`: `1623 pass`, `0 fail`, `6484 expect()` calls
  across `125` files (up from round 1's `1620`/`125` — 3 new assertions, no
  new test file). The coordinator flagged a known isolation flake,
  `session-costs.test.ts:389`, that fails only under the full run — it did
  NOT appear this run; 0 fail, no exceptions.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.
- `version` field: confirmed untouched (`git diff --stat packages/sdk/package.json` empty).

Downstream `apps/web`: confirmed NO web file needed editing — every call
site goes through the factory, and the extra `'list'` segment is internal to
`sessions()`'s output. `npx tsc --noEmit | grep -v test.each` byte-identical
to the round-1 baseline (`diff` confirmed, 21 error lines, all
pre-existing); `bun test src/features/workspace src/features/review-center
src/app`: `1063 pass`, `0 fail`, unchanged from round 1.

**Status:** COMPLETE (Task 9 fix round 2 of `client-cache-unification`).

**SDK package shippable to production: YES.**

---

### 2026-08-06 — session `client-cache-unification` — Task 9 fix round 1: scope missing from `qk.project.sessions`

Fix for a defect a review caught in Task 9 (`docs/superpowers/plans/2026-08-06-client-cache-unification.md`,
`.superpowers/sdd/2026-08-06-client-cache-unification/task-9-report.md`). Task 9
collapsed two web query keys (`['project-sessions', id]` and
`['project-session-inventory', id]`) onto `qk.project.sessions(id)`. That was
correct for 13 of 14 read sites, but one —
`apps/web/src/features/workspace/project-sessions/project-sessions-view.tsx`
— calls `listProjectSessions(id, { scope: 'project' })`, the manager-only
**unfiltered full inventory**
(`core/rest/projects-client/sessions.ts`, `apps/api/src/projects/lib/session-inventory.ts`).
That is a DIFFERENT server request than the default `scope: 'visible'` every
other site uses, not a client-side filter of the same response. The original
`sessions(id)` key omitted `scope` entirely, so both requests wrote into ONE
cache slot: whichever resolved last silently overwrote what the other
scope's readers saw. The general rule this violated: **anything that changes
the response must be part of the query key.**

**Fix**, `src/react/query-keys.ts`:

- `sessions(id, scope: 'visible' | 'project' = 'visible')` — scope is now
  part of the key. The zero-arg call (`sessions(id)`) still works and still
  means the default scope, so the 13 default-scope call sites in `apps/web`
  needed no change; the one `scope: 'project'` site now calls
  `qk.project.sessions(projectId, 'project')`.
- `sessionsScope(id)` — new invalidation-only prefix
  (`[...scope(id), 'sessions']`, one level above the scope segment).
  `sessions(id)` and `sessions(id, 'project')` are SIBLINGS under it, not
  parent/child, so every INVALIDATION site had to move from `sessions(id)` to
  this prefix or the scope it didn't touch would go silently stale after a
  rename/delete/restart/stop/share. Enumerated and fixed all 15 invalidation
  call sites in `apps/web` (full list in the task-9 report addendum).
- `session(id, sessionId)` / `messages(id, sessionId)` now nest under the
  scope-LESS `sessionsScope(id)` prefix instead of under a specific
  `sessions(id, scope)` slot — a session is not owned by whichever list scope
  discovered it, so its own cache entry does not carry a scope segment
  either. This is a considered nesting decision, not a fallout: the
  alternative (nesting under one scope's key) would make an individual
  session's cache entry only reachable through ONE of the two list scopes.

`rename-session-modal.tsx`'s optimistic write is a documented exception:
`cancelQueries`/`setQueryData`/`getQueryData` keep targeting the exact
default-scope `sessions(projectId)` key (that's the only cache entry it has
a row to paint over), while its `onSettled` invalidation moved to the
`sessionsScope` prefix so the 'project'-scoped inventory page — never painted
optimistically — still catches up via a real refetch.

`schedule-view.tsx`'s two `pinnableSessions` queries were re-checked under
the new shape: both call `listProjectSessions(projectId)` with no options
(default scope), so they correctly stay on the zero-arg `sessions(projectId)`
form — no scope segment needed.

**Tests**, `src/react/query-keys.test.ts` (TDD: written against the OLD
factory first, confirmed RED — `qk.project.sessionsScope is not a function`,
and `sessions(id)` equal to `sessions(id, 'project')` — then GREEN after the
factory change): `sessions(id)` defaults to `'visible'`; `sessions(id)` and
`sessions(id, 'project')` are different keys; `sessionsScope(id)` strictly
prefixes both scoped forms and is itself never equal to either; every
project-scoped key (including both new forms) stays prefixed by
`qk.project.scope(id)`; `session`/`messages` nest under `sessionsScope`, not
under one specific scope. The `qk` vs `kortixKeys` disjointness tests and the
Task 3/5 tests (`invalidate-project.test.ts`, which reads/writes
`qk.project.sessions(ID)` at its default scope) needed no changes and stayed
green throughout.

GREEN (all three SDK gates, this fix round):

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `bun test --isolate src`: `1620 pass`, `0 fail`, `6476 expect()` calls
  across `125` files (up from Task 6's `1609`/`125` — this round added 5 new
  assertions to `query-keys.test.ts`, no new test file).
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; packed tarball
  imported and constructed `createKortix` from Node ESM.
- `public-surface.test.ts` + `public-type-surface.test.ts`: `2 pass`, `0
  fail`, no snapshot drift — `sessionsScope` is a new property on the
  already-exported `qk` const (the snapshot records top-level identifiers,
  not nested member shapes), and the `sessions` signature change is a
  backward-compatible optional-parameter widening. No re-recording needed.
  `version` field not touched.
- Downstream `apps/web`: `npx tsc --noEmit | grep -v test.each` byte-identical
  to the pre-fix baseline (21 error lines, all pre-existing/documented);
  `bun test src/features/workspace src/features/review-center src/app`:
  `1063 pass`, `0 fail` (unchanged from before the fix); `eslint` on every
  changed file: `0 errors`.

**Status:** COMPLETE (Task 9 fix round 1 of `client-cache-unification`).

**SDK package shippable to production: YES.**

---

### 2026-08-06 — session `client-cache-unification` — Tasks 3–6 completion

Consolidated entry for Tasks 3 through 6 of the `client-cache-unification` plan
(`docs/superpowers/plans/2026-08-06-client-cache-unification.md`). Tasks 4 and
5's briefs restricted their commits to code files only, so neither left a
`PROGRESS.md` entry. This entry closes that gap and records everything the
plan shipped through Task 6.

Task by task:

- **Task 3** — `packages/sdk/src/react/query-keys.ts`: the `qk`
  project/projects query-key factory plus `ProjectScopeKey` and
  `ProjectsListKey`. `qk.project.scope(id)` is an invalidation-only prefix;
  every project-scoped key nests under it. `qk` roots at `'kx'`, not
  `'kortix'` — re-rooted in `d6e3d481b7` after the first commit
  (`ecdb5e9c02`) used `'kortix'`. `kortixKeys` (`use-kortix-master.ts:276-279`)
  already owns `['kortix', 'projects']` / `['kortix', 'projects', id]`; had
  `qk` also rooted at `'kortix'`, `kortixKeys.projects()` — already used as an
  `invalidateQueries` prefix at `use-kortix-master.ts:371,384` — would
  prefix-match every key `qk` produces too, since TanStack matches query keys
  by prefix. `'kx'` makes the two factories disjoint at segment 0, so neither
  can ever reach into the other's cache entries on invalidation.
- **Task 4** — `packages/sdk/src/react/query-contracts.ts`: one
  `FreshnessTier` per entity (`'live' | 'config' | 'inventory' | 'volatile'`),
  `contract(tier)` returning `{ staleTime, gcTime: 30 * 60_000,
  refetchOnMount: false }`, and the `FRESHNESS` map pinning 14 entities to
  exactly one tier each (`as const satisfies Record<string, FreshnessTier>`,
  so a new entity added without a tier is a compile error). Commit
  `8f4d8a1021`.
- **Task 5** — `packages/sdk/src/react/use-project-name.ts` +
  `invalidate-project.ts`: `useProjectName(projectId)`, the one accessor for a
  project's display name (`data?.project?.name`, no `??` fallback to another
  cache — this is what closes the two-titles bug, where the switcher read the
  projects list and the project home read the detail, and the two caches
  could disagree); `invalidateProject` (whole-scope invalidation via
  `qk.project.scope`); `invalidateProjectIdentity` (invalidates the list AND
  detail entries together, since a project's name lives in both);
  `writeProjectNameOptimistically` (paints a rename into both caches before
  the round-trip settles). Commit `d1e29a200f`.
- **Task 6** (this entry's trigger) — `packages/sdk/src/react/index.ts`:
  `export * from './query-keys'`, `'./query-contracts'`,
  `'./use-project-name'`, `'./invalidate-project'`. Makes `qk`, `contract`,
  `FRESHNESS`, `FreshnessTier`, `ProjectScopeKey`, `ProjectsListKey`,
  `useProjectName`, `invalidateProject`, `invalidateProjectIdentity`, and
  `writeProjectNameOptimistically` importable from `@kortix/sdk/react` for the
  first time. Checked every name against the full `./react` barrel, including
  `use-kortix-master.ts`'s `kortixKeys` — no collision.

Tripwires (`AGENTS.md:311`), run before any edit and again after:

- `bun test --isolate src/index.isomorphic.test.ts src/package-exports.test.ts`:
  `72 pass`, `0 fail`. `./react` is an existing subpath — adding files
  underneath it needed no `package.json` `exports` / `publishConfig.exports` /
  `SUBPATH_TIERS` edit.

GREEN (Task 6 gates):

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1609 pass`, `0 fail`, `6455 expect()`
  calls across `125` files (same counts as Task 5's completion — Task 6 adds
  no new test file, only barrel wiring).
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and constructed `createKortix` from Node ESM.

Wiring the four modules into the barrel made their exports reachable from
`./react` for the first time, so `public-surface.snapshot.json` and
`public-type-surface.snapshot.json` both drifted — 7 new runtime names, 10 new
type-level names (the extra 3 are type-only: `FreshnessTier`,
`ProjectScopeKey`, `ProjectsListKey`). Every line in both diffs is `+ added —
additive, fine`; nothing removed or renamed. Re-recorded with
`UPDATE_SURFACE_SNAPSHOT=1` and `UPDATE_TYPE_SURFACE_SNAPSHOT=1` and reviewed
by hand before committing. The `version` field was not touched throughout
Tasks 3–6.

**Status:** COMPLETE (Tasks 3–6 of `client-cache-unification`).

**SDK package shippable to production: YES.**

---

### 2026-08-06 — session `client-cache-unification` — Task 3 claim

Claiming Task 3 of the `client-cache-unification` plan
(`docs/superpowers/plans/2026-08-06-client-cache-unification.md`): the `qk`
query-key factory.

Scope:

- Add `packages/sdk/src/react/query-keys.ts` — one additive module exporting
  `qk` (a project/projects query-key factory) plus the `ProjectScopeKey` and
  `ProjectsListKey` types.
- `qk.project.scope(id)` is an invalidation prefix, never a query key itself;
  every project-scoped key nests under it.
- Distinct from `kortixKeys` in `use-kortix-master.ts` (the Kortix-Master
  multi-server surface) — not extended, not imported, not renamed.
- Not wired into `react/index.ts` in this task — that export wiring belongs to
  Task 6.
- No published name changes. No `version` bump.

Added `packages/sdk/src/react/query-keys.ts`, exporting `qk`, `ProjectScopeKey`,
and `ProjectsListKey`. `qk.project.scope(id)` returns `['kortix', 'project', id]`
as an invalidation-only prefix; every other `qk.project.*` member spreads it and
appends a segment, so `invalidateQueries({ queryKey: qk.project.scope(id) })`
provably reaches the whole subtree. `qk.projects.list(accountId?)` partitions by
account and is not nested under any project scope. The module is standalone —
not re-exported from `react/index.ts` (Task 6's job) — so it has zero effect on
the public surface snapshot.

RED:

- `bun test --isolate src/react/query-keys.test.ts`: `0 pass`, `1 fail`,
  `error: Cannot find module './query-keys'`.

GREEN:

- `bun test --isolate src/react/query-keys.test.ts`: `6 pass`, `0 fail`,
  `22 expect()` calls.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1577 pass`, `0 fail`, `6394 expect()`
  calls across `123` files (above the documented `1069`/`71` baseline).
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and `createKortix` constructed successfully.

The public surface is unchanged — `query-keys.ts` is not imported anywhere yet.
The `version` field was not touched.

**Status:** COMPLETE (Task 3 of `client-cache-unification`).
### 2026-08-06 — session `connector-compat-removal` completion

No **Now** task claimed. This is the second phase of the user-directed connector
terminology cutover after PR #6173 deployed successfully to Dev.

Claimed scope:

- Remove remaining active `executor` and connector `profile` compatibility from
  the SDK, API, CLI, web, connector SDK, and database schema.
- Make `connector`, `connection`, and `connector call` the only active product
  nouns and wire identifiers.
- Remove deprecated published SDK aliases such as `ConnectionProfile*` and
  legacy `profile_id` response handling.
- Run RED, GREEN, and REFACTOR manually because the required `tdd` skill is not
  available in this session.

This is an intentional user-authorized breaking public SDK cutover. The package
version field was not edited.

RED:

- The new terminology test failed because published connection-profile and
  connector-authorization aliases remained reachable.
- The database integration test failed three assertions before the compatibility
  views, binding mirror, and secret-consumer enum value were removed.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1572 pass`, `2 skip`, `0 fail`, and
  `6380 expect()` calls across `123` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and `createKortix` constructed successfully.
- Focused migrated PostgreSQL proof: `3 pass`, `0 fail`.
- Complete database package suite: `175 pass`, `6 skip`, `0 fail`.
- Complete CLI suite: `737 pass`, `0 fail`.
- Complete API suite: `5599 pass`, `62 skip`, `0 fail`.
- Complete web suite: `4577 pass`, `0 fail`.

The public SDK now exposes only `connector`, `connection`, and `connector call`
product terms. Removed compatibility includes connection-profile types and
functions, connector-authorization entity aliases, legacy binding identifiers,
and legacy email-installation fields.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-07 — session `kortix-apps` claim

No **Now** task claimed. This is the user-directed Kortix Apps implementation.

Claimed SDK scope:

- Add the framework-free Apps REST contract and public types.
- Expose the canonical project surface at `kortix.project(projectId).apps`.
- Support artifact upload, deployment creation, inspection, logs, rollback,
  start, stop, and removal through the existing `getToken` seam.
- Keep provider selection server-side and preserve every published SDK name.
- Add the SDK documentation, executable example, and public-surface snapshots.

The required `tdd` skill is unavailable in this session. This work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required final gates are `typecheck`, the complete SDK test suite, and the
packed-install smoke test.

Final security correction:

- `AppDeployment.created_by` records the caller who created the immutable
  deployment.
- The API uses that actor for personal secret resolution, runtime ownership,
  and compute attribution.
- The type addition is backward-compatible and changes no public export name.

RED:

- `pnpm --filter @kortix/sdk typecheck`: failed with `TS2551` because
  `AppDeployment.created_by` did not exist.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1598 pass`, `0 fail`, and `6550 expect()`
  calls across `127` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; packed tarballs
  imported and constructed `@kortix/sdk` and `@kortix/executor-sdk`.

**Status:** COMPLETE in PR #6197.

**SDK package shippable to production: YES.**

---

### 2026-08-06 — session `sdk-connectors-unified` completion

Consolidated the Connector data plane into `@kortix/sdk`. The canonical
surface is `kortix.project(projectId).connectors`, with `kortix.connectors` for
an agent-minted token that already carries project scope. Both expose
`catalog`, `tools`, `search`, `describe`, `call`, and `uploadAttachment`.

Deleted the unpublished standalone Connector SDK. Added one final
`@kortix/executor-sdk@0.12.5` compatibility adapter for existing production
consumers. The adapter preserves the published `0.12.4` names, signatures,
raw `request()` escape hatch, `approval_execution_id`, and `ExecutorError`.
The production workflow publishes this adapter only when `VERSION=0.12.5`,
then applies the npm deprecation notice.

Migrated the CLI, optional MCP server, sandbox Slack and Teams shims, snapshot
artifact pipeline, Docker images, starter guidance, SDK documentation, tests,
and npm release gates to the unified SDK. Active product surfaces use only the
Connector and Connection nouns.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1587 pass`, `0 fail`, and
  `6465 expect()` calls across `124` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; clean tarball install
  imported and constructed `@kortix/sdk` and `@kortix/executor-sdk`.
- `pnpm --filter @kortix/executor-sdk test`: `6 pass`, `0 fail`, and
  `23 expect()` calls.
- `pnpm --filter @kortix/executor-sdk typecheck`: exit `0`.
- `node scripts/stage-npm-publish.test.mjs`: `24 assertions passed`.
- Complete CLI suite: `737 pass`, `0 fail`, and `2382 expect()` calls.
- Complete API suite: `5604 pass`, `62 skip`, `0 fail`, and
  `21839 expect()` calls.
- Database suite: `175 pass`, `6 skip`, `0 fail`.
- Connector contract migration: `3 pass`, `0 fail`.
- Starter suite: `70 pass`, `0 fail`, and `1043 expect()` calls.
- Real Linux sandbox CLI build: `103905408 bytes`, target `bun-linux-x64`.
- Local agent-minted-token matrix: `105 passed`, `0 failed`. This includes
  Connector creation and removal, Connections, credential stdin, SDK, final
  compatibility adapter, CLI, MCP, approval, policies, Pipedream, upstream
  HTTP, and real model traffic.
- `docker build -f apps/api/Dockerfile --target deps --build-arg SERVICE=apps/api .`:
  exit `0`, image `sha256:c7457e0d2f3d222a0221849e6b9a14ed593e2a8a9fd06039748869bf3bff1d43`.
- `git diff --check`: exit `0`.
- Tracked search for the deleted Connector SDK package name: zero matches.

No published `@kortix/sdk` name was removed or renamed. The SDK version field
remains `0.3.0`; the release script stamps the root `VERSION` value.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-05 — session `cli-connectors-refactor` claim

Claimed scope:

- Replace active `executor`, connector `profile`, and product `integration`
  terminology with `connector` and `connection` across
  the SDK, CLI, API, runtime, npm package, documentation, and tests.
- Preserve published `@kortix/sdk` compatibility with deprecated aliases where
  removal would break existing consumers.
- Collapse the agent-facing CLI into one `kortix connectors` command tree.
- Fix and black-box verify the complete CLI defect list in
  `kortix-cli-refactor-report.md` with a real agent-minted session token.

The required `tdd` skill is unavailable in this session. The work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1575 pass`, `0 fail`, and
  `6401 expect()` calls across `122` files after the final rebase.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and `createKortix` constructed successfully.
- `bun apps/api/scripts/e2e-cli-agent-token.ts`: `85 pass`, `0 fail`. Every
  assertion launched the real CLI with a production-minted project/session PAT.

Published `profile` and `integration` names remain as deprecated aliases.
Canonical new code uses `connector` and `connection`.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-06 — session `connector-secret-binding` completion

No **Now** task claimed. This is an additive connector credential-source fix.

Scope:

- Add an SDK contract to bind a project secret to one project-owned connector.
- Preserve all published names and existing connector credential methods.
- Reject missing, incompatible, and ambiguous secret bindings at the API boundary.
- Expose the binding in the secret editor without sending the value to the sandbox.

The listed `tdd` skill was unavailable in this session. This work used the same
RED, GREEN, and REFACTOR sequence directly.

Added `setConnectorSecretBinding()` and additive connector binding metadata.
The contract binds one broker-delivered connector secret without returning its
value to the host or sandbox. Existing stored-credential methods remain intact.

RED:

- Contract tests failed before the client exposed the binding operation.
- Public-surface tests reported the two intended additive exports.

GREEN:

- Focused SDK tests: `33 pass`, `0 fail`, and `121 expect()` calls.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1546 pass`, `0 fail`, and `6323 expect()`
  calls across `121` files after rebasing onto `origin/main`.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and built successfully.

The public surface changed additively. The runtime and type snapshots add
`setConnectorSecretBinding` at the root and deprecated projects-client
surfaces. No export was removed or renamed. The package version was not edited.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-05 — session `provision-idempotency` completion

No **Now** task claimed. The SDK half of a server-side defect fix is one
optional field; the rest is `apps/api` + `packages/db`.

`POST /v1/projects/provision` mints a brand-new managed repo on every call and
guarded only on the quota count, so a retry after a lost response created a
genuine duplicate project with its own upstream GitHub repo. The route now
accepts an `idempotency_key`, looks it up before `backend.createRepo`, and
returns the already-provisioned project. `ProvisionProjectInput` gained
`idempotency_key?: string` so that key is part of the public surface.

RED:

- `pnpm --filter @kortix/sdk typecheck`: `error TS2353: Object literal may only
  specify known properties, and 'idempotency_key' does not exist in type
  'ProvisionProjectInput'` — three occurrences, exit `2`. The type IS the
  behaviour here, so the type-checker is where the failure belongs; the runtime
  wire assertion (`idempotency_key is sent on provision`) guards a future
  refactor that whitelists body fields.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1496 pass`, `0 fail`, `6196 expect()` calls
  across `121` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and constructed.

Public surface unchanged in NAMES — one optional field added to an existing
exported interface. Additive, no alias needed, no major implied, no snapshot
re-record. The `version` field was not touched.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-05 — session `cli-audit-source` claim

No **Now** task claimed. This is a narrow additive transport-metadata fix.

Scope:

- Let an SDK host identify its client surface without replacing the transport.
- Send the client surface on every SDK-authenticated Kortix request.
- Mark the Kortix CLI as `cli` so central audit filters reconstruct its actions.
- Preserve every published name and existing configuration field.

The listed `tdd` skill is unavailable in this session. This work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-05 — session `cli-audit-source` completion

Added the optional `clientSource` platform configuration field. The SDK sends
the validated value on authenticated backend and session-runtime requests. The
CLI sets the value to `cli`. Explicit request headers still take precedence.
The API preserves agent and service-account attribution before it considers the
client surface. Unknown source labels fall back to `api`.

RED:

- SDK tests expected the `cli` request header and received no header.
- CLI tests expected `clientSource: "cli"` and received no value.
- API tests expected a CLI audit event and received source `api`.

GREEN:

- Focused SDK tests: `37 pass`, `0 fail`, and `90 expect()` calls.
- Focused CLI tests: `13 pass`, `0 fail`, and `16 expect()` calls.
- Focused API tests: `8 pass`, `0 fail`, and `28 expect()` calls.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1544 pass`, `0 fail`, and `6321 expect()`
  calls across `121` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and `createKortix` constructed successfully.
- The complete CLI suite passed `701` tests. The complete API suite passed
  `5476` tests and skipped `62` tests. Both typechecks exited `0`.
- A real localhost CLI `projects ls --json` request produced a central audit
  event with source `cli`, actor type `human`, outcome `success`, and HTTP `200`.

The public configuration type changed additively. No export was removed or
renamed. The package version was not edited.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-05 — session `better-queue` completion

No **Now** task claimed. This is an additive module for a host-side defect: a
message queued while the agent is running is released mid-turn, and sometimes
twice. The SDK half of that fix is two tasks; the rest is `apps/web`.

Added `core/session/message-queue.ts` — the queue's ordering, claiming, and
failure rules as pure transitions over serializable state. No `Date.now()`, no
`crypto`, no timers: ids and timestamps are inputs, so every transition is
deterministic. Exported as the new `./message-queue` subpath at tier
`isomorphic-core`.

The two invariants that motivated it: `claimNext` records the claim in the same
transition that returns the item, so two drains racing send one message; and
`failInFlight` sets the item aside instead of requeueing it at the head, so a
failed item can never lock out the rest of the queue. That lockout is the exact
reason the web client queue was deleted wholesale in `67749c1f76`.

RED:

- `bun test src/core/session/message-queue.test.ts`: `0 pass`, `1 fail`,
  `error: Cannot find module './message-queue'`.

GREEN:

- `bun test src/core/session/message-queue.test.ts`: `31 pass`, `0 fail`,
  `47 expect()` calls.
- `pnpm --filter @kortix/sdk test`: `1490 pass`, `2 skip`, `0 fail`, and
  `6185 expect()` calls across `121` files (baseline was `1456` across `120`).
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and `createKortix` constructed successfully.

Public surface changed, additively: 12 new names on `./message-queue`, nothing
removed or renamed. Both snapshots re-recorded deliberately. No alias needed and
no major implied. The `version` field was not touched.

`core/session/send-queue.ts` gained a doc note only. It has **zero call sites**
anywhere in the monorepo — a correct, tested queue nothing imports, while the
web host reimplemented a worse one inline. It stays exported because it is
published API; new host code should use `message-queue` instead. Its weakness is
structural, not a bug: it holds `dispatch` closures, and a closure cannot be
persisted across a reload, reordered, or edited by a user.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-06 — session `cli-connectors-refactor` channel terminology claim

Add canonical `connectorSlug` to `EmailInstallation`.
Preserve `profileSlug` as a deprecated compatibility field.
Normalize canonical and legacy API wire fields onto both public properties.

The required `tdd` skill is unavailable in this session.
This work uses the required RED, GREEN, and REFACTOR sequence directly.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1537 pass`, `0 fail`, and
  `6316 expect()` calls across `121` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-05 — session `secret-delivery-complete` claim

No **Now** task claimed. This work continues the completed
`secret-delivery-control-plane` slice.

Scope:

- Add an additive SDK contract for complete secret delivery configuration.
- Preserve `setProjectSecretStrategy()` and every published name.
- Expose consumer, broker, egress, rotation, and credential-profile metadata.
- Keep web and CLI clients on the SDK contract.

The listed `tdd` skill is unavailable in this session. This work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

### 2026-08-05 — session `secret-delivery-complete` completion

Added an additive project-secret contract for delivery strategy, managed
consumer, HTTP broker policy, rotation state, and session broker calls. Kept all
published names and the existing `setProjectSecretStrategy()` signature. The
web and CLI use the SDK contract instead of defining a second transport.

RED:

- The secret-client contract tests failed before the request and response types
  included managed consumers and HTTP broker policy.
- The root client test failed before a session exposed the secret broker.

GREEN:

- `pnpm --filter @kortix/sdk test`: `1538 pass`, `0 fail`, and `6298 expect()`
  calls across `121` files.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and `createKortix` constructed successfully.

The public surface changed additively. No export was removed or renamed. The
package version was not edited.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-04 — session `auth-cache-link-prefetch` claim

No **Now** task claimed. This is a narrow browser cache identity fix.

Scope:

- Resolve the offline transcript cache scope once per authenticated browser session.
- Invalidate the resolved scope when the host clears the session cache.
- Preserve all published names, signatures, and cache key formats.

The required `tdd` skill is unavailable in this session. The work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** IN PROGRESS.

**SDK package shippable to production: NOT YET.**

### 2026-08-07 — session `apps-experimental-gate` completion

The Apps project gate remains additive. The existing Apps SDK surface keeps all
published names. `AppDeployment` now exposes immutable `created_by`,
`source_session_id`, and `actor_type` provenance returned by the API.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1597 pass`, `2 skip`, `0 fail`, and
  `6547 expect()` calls across `127` files.
- `pnpm --filter @kortix/sdk smoke:install`: exit `0`; the packed SDK imported
  and `createKortix` constructed successfully.
- `bun test src/core/rest/projects-client/apps.test.ts`: `5 pass`, `0 fail`.

No public export name changed. The package version remains untouched.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

The complete Apps deployment matrix is a platform acceptance gate. It is not an
SDK package gate and remains pending until the merged Dev deployment is live.

### 2026-08-07 — session `apps-experimental-gate` completion

Implemented:

- Added the additive `apps` key to `ExperimentalFeatureKey`.
- Added project-contract coverage for `experimental.apps`.
- Kept the existing Apps SDK client and React surface unchanged.

Required gates:

```text
$ pnpm --filter @kortix/sdk typecheck
exit 0

$ pnpm --filter @kortix/sdk test
1597 pass
2 skip
0 fail

$ pnpm --filter @kortix/sdk run smoke:install
OK: @kortix/sdk and @kortix/executor-sdk import and construct from packed tarballs
install smoke test passed
```

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-04 — session `auth-cache-link-prefetch` completion

The IndexedDB transcript cache now memoizes one authenticated user scope across
stream writes. `clearSessionIDBCache()` invalidates the scope before clearing
pending writes and IndexedDB, so sign-out and account changes cannot reuse it.
Null scopes are not retained, which preserves late authentication hydration.

RED:

- Four concurrent `saveSessionToIDB()` calls performed `4` identity reads; the
  regression expected `1`.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1456 pass`, `2 skip`, `0 fail`, and
  `6133 expect()` calls across `120` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`; the packed tarball
  imported and `createKortix` constructed successfully.

No public export name, signature, cache key, or public-surface snapshot changed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

## Who may edit what

| Section                     | Agents may…                                            | Agents may **not**…                                                                                         |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Now** (the active chain)  | claim a task, update its status, add evidence          | **renumber, reorder, delete, or insert tasks.** The plan and the execution prompt reference them by number. |
| **Next**                    | move an item to Now when its plan exists               | start it without a spec                                                                                     |
| **Backlog**                 | **append freely** — this is where discovered work goes | reorder or delete existing rows                                                                             |
| **Discovered this session** | **append freely**                                      | rewrite others' entries                                                                                     |
| **Open decisions**          | append a question; mark one RESOLVED with the answer   | resolve one on the user's behalf                                                                            |
| **Session log**             | **append only**, newest at the bottom                  | edit any earlier entry                                                                                      |

**Never delete a row.** Mark it `WON'T DO (reason)` and leave it. A deleted row is
a decision nobody can audit.

**Found work mid-task? Do not do it.** Append it to **Backlog** or **Discovered
this session**, finish the task you claimed, and tell the user. Scope creep inside
a task is how a 146-file move becomes unreviewable.

**Multi-step work does not become a Task.** The **Now** chain comes from one plan
document. New multi-step work earns its own spec → plan → chain. Backlog rows are
single, self-contained changes.

---

## "Can I run three agents, each picking a task?" — No.

Read this before you try. It is the most expensive mistake available here.

**This file is a handoff across _time_, not a work queue across _space_.** It exists
so a session that starts tomorrow knows what yesterday's finished. It does **not**
make the tasks parallelisable.

Two independent reasons:

**1. The Now chain is a chain.** Task 4 moves **146 files** (97 source + 49 colocated
tests). A file move has _no behaviour to assert_ — the only proof you moved files
rather than renamed an export is that **Task 3's snapshot did not budge**. Start 4
before 3 lands and the riskiest change in the plan runs with no net. 5 needs 4's
tree; 6 needs 5's surface; 8 bundles 5's final shape.

**2. Sessions in the same worktree share one filesystem and one git index.** Agent B
running `bun test` while Agent A is mid-`git mv` does not read a stale file — it
reads a file that no longer exists. The claim commits race too: both
`git add PROGRESS.md && git commit`, and one loses.

And there is nowhere to hide: Tasks 4 and 5 touch **both export maps**, `src/index.ts`,
`src/index.isomorphic.test.ts`, and 146 moved files — nearly every file in the
package. No second task avoids collision.

### What the claim protocol actually buys

Only this: **two sessions never do the same task.** It is not a lock on the tree, and
it does not make a chain into a queue. Do not read it as permission to fan out.

### What _can_ run in parallel

| Stream                      | Where                                                              | Safe?                                                                                                              |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| The Now chain (Tasks 1→10)  | `suna-ts-sdk`, one session                                         | ✅ — parallelise **inside** it with subagents, never across sessions                                               |
| **Lumen productionisation** | a **separate worktree** (`pnpm worktree create --name lumen-prod`) | ✅ — touches `apps/whitelabel-demo/src/server/*` only. Zero overlap with `packages/sdk`. Needs its own spec first. |
| RN transport seam           | —                                                                  | ❌ edits `src/state/event-stream.ts`, the exact file Task 4 moves                                                  |
| Backlog B1/B2/B3            | —                                                                  | ❌ all add exports; collides with Task 5's barrel rewrite. Do them **after** Task 5.                               |

Throughput inside the SDK comes from **subagents within one session**
(`superpowers:subagent-driven-development`), sequenced against the chain — not from
concurrent top-level sessions.

---

## Protocol for sessions

Git is the only lock we have, and it is advisory. Behave accordingly. This protocol
guards **sequential** sessions (and the rare deliberate second worktree), not a
free-for-all.

**Before you start**

1. `git pull` (or rebase) so you are not reading a stale table.
2. If a task is `IN PROGRESS` and `Last touched` is within ~24h, **do not take
   it** — another session owns it. Take the next `NOT STARTED` task whose
   dependencies are `DONE`.
3. Claim it: set status `IN PROGRESS`, add your session id and the date, and
   **commit that one-line change by itself, before doing any work:**

       git add packages/sdk/PROGRESS.md
       git commit -m "chore(sdk): claim Task N"

   A claim made after the work is a report, not a lock.

**Before you finish**

4. Update the row: `DONE (sha)`, or back to `NOT STARTED` / `BLOCKED (reason)`.
   A task left `IN PROGRESS` by a session that ended is a lie the next session
   will believe.
5. **Append a session-log entry.** Appends merge cleanly across branches; table
   edits conflict. Short on turn? Append anyway.

**Stale claims.** `IN PROGRESS`, older than ~24h, no commits touching its files →
abandoned. Take it over and say so in the log. Never overwrite silently.

**Never mark `DONE` without pasting the evidence** — the commands you ran and their
real output. `typecheck` is not evidence.

---

## COMPLETED PLAN — v2 structure & distribution

- **Plan:** `docs/superpowers/plans/2026-07-10-sdk-v2-structure-and-distribution.md`
- **Spec:** `docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md`
- **Kickoff prompt:** `docs/superpowers/plans/2026-07-10-sdk-v2-execution-prompt.md`

**Ordering is load-bearing.** Each task is the safety net for the next. Task 3's
snapshot is the _only_ test Task 4 has, because a file move has no behaviour to
assert. **Do not run out of order. Do not parallelise.** Dependencies are strictly
`1 → 2 → … → 10`; only 7, 8 and 10 have slack, and only after 6.

| #   | Task                                                    | Status                                                                                                                                                                                                                           | Session    | Last touched | Commit                                   |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | ---------------------------------------- |
| 0   | Docs: spec, plan, `AGENTS.md`, prompt, this file        | **DONE**                                                                                                                                                                                                                         | `01AzJBSa` | 2026-07-10   | `6cd4d6e4e`                              |
| 1   | Assert the two export maps agree                        | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `ecb78a113`                              |
| 2   | Install smoke test — pack, install, import              | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `7220e9587`                              |
| 3   | Public-export snapshot                                  | **DONE** (snapshot approved by Jay at hard stop #2)                                                                                                                                                                              | `ab099b6a` | 2026-07-10   | `84e15ca72`                              |
| 4   | Axis 1 — internal restructure (`core`/`browser`/`node`) | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `4c6f7102c` (4 commits from `25068d272`) |
| 5   | Axis 2 — root canonical, subpaths deprecated            | **DONE** (snapshot growth accepted by Jay at hard stop #3)                                                                                                                                                                       | `ab099b6a` | 2026-07-10   | `b5e588dbc`+`aafbdf91b`                  |
| 6   | Dogfood `whitelabel-demo` (acceptance gate)             | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `db30c6df3`+`19e500e50`                  |
| 7   | Portability — ban bare globals in `core/`               | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `189428df7`+`a485ad401`                  |
| 8   | `tsup` bundles — CDN ESM + `window.Kortix`              | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `c7bca7a7e`                              |
| 9   | Examples — `07-vanilla.ts`, `08-cdn.html`               | **DONE** (steps 1–5 `549d597a0`, review clean; Step 6 executed 2026-07-12 — D2a + D3 **PASS** in real Chromium vs live local stack, evidence in session log + `docs/superpowers/reviews/2026-07-12-sdk-production-readiness.md`) | `ab099b6a` | 2026-07-10   | `549d597a0` + live gate                  |
| 10  | Docs — README, CHANGELOG, API-MAP                       | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `6e9cc9f5a`                              |

Statuses: `NOT STARTED` · `IN PROGRESS` · `BLOCKED (reason)` · `DONE (sha)` · `WON'T DO (reason)`

### Hard stops — bring these to Jay, do not decide alone

- [ ] **Task 2, first run.** Nothing has ever installed and imported the tarball. A failure is a **real pre-existing bug**, not something to loop on. Report it.
- [ ] **Task 3, before committing the snapshot.** It becomes ground truth for everything after.
- [ ] **Task 5, Step 12 — the snapshot diff.** Additions fine. **A removal or rename means a broken consumer.** Never accept the diff to reach green.
- [x] **Task 9, Step 6.** Real browser, live stack, real sandbox. D2a (streaming through the IIFE global) and D3 (`instanceof Kortix.ApiError` under the bundle) cannot be claimed without it. — **Executed 2026-07-12, both PASS** (Chromium + live stack + real PAT/sandbox; see session log).

Also stop if the same failure survives three different fixes (use
`superpowers:systematic-debugging`), or you are about to change what a test asserts.

---

## COMPLETED PLAN — web SDK-only boundary

- **Plan:** `docs/superpowers/plans/2026-07-24-web-sdk-only-boundary.md`
- **Spec:** `docs/superpowers/specs/2026-07-24-web-sdk-only-boundary-design.md`

| #   | Task                              | Status | Session             | Last touched | Commit                    |
| --- | --------------------------------- | ------ | ------------------- | ------------ | ------------------------- |
| 1   | Baseline and static boundary gate | DONE   | `frontend-sdk-only` | 2026-07-24   | `b388f2f58`               |
| 2   | Canonical SDK imports             | DONE   | `frontend-sdk-only` | 2026-07-24   | `b84e23c17`               |
| 3   | One session engine                | DONE   | `frontend-sdk-only` | 2026-07-24   | `486df10f4`               |
| 4   | Runtime-neutral web state         | DONE   | `frontend-sdk-only` | 2026-07-24   | `afbd6e5a0`               |
| 5   | Typed platform API coverage       | DONE   | `frontend-sdk-only` | 2026-07-24   | `65202adea`               |
| 6   | Remove runtime routing knowledge  | DONE   | `frontend-sdk-only` | 2026-07-24   | `e6241bbfc`               |
| 7   | Local parity proof                | DONE   | `frontend-sdk-only` | 2026-07-24   | `6c02b601e`               |
| 8   | Delivery and dev proof            | DONE   | `frontend-sdk-only` | 2026-07-24   | `aefa2a628` + `8688b8492` |

---

## COMPLETED PLAN — native integration authentication lifecycle

- **Plan:** `docs/superpowers/plans/2026-07-25-native-connector-auth-lifecycle.md`
- **Spec:** `docs/superpowers/specs/2026-07-25-native-connector-auth-lifecycle-design.md`

| # | Task | Status | Session | Last touched | Commit |
|---|---|---|---|---|---|
| 1 | Contracts and RED tests | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `de7026bfc` |
| 2 | Database lifecycle | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `572bedb5a` |
| 3 | OAuth2 protocol engine | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `db31d216e` |
| 4 | API lifecycle routes | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `63dda6afe` |
| 5 | Connector and non-OAuth request authentication | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `35daeda10` |
| 6 | SDK and web integration | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `b3826fa8f` |
| 7 | Local verification | DONE WITH BROWSER BLOCKER | `native-oauth-full-lifecycle` | 2026-07-25 | `4575346db` |
| 8 | Delivery and dev proof | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `00bc29065` + `8a1249883` |

---

## NOW — active plan: OpenCode ACP canary

- **Plan:** `docs/superpowers/plans/2026-07-25-opencode-acp-canary.md`
- **Spec:** `docs/superpowers/specs/2026-07-25-opencode-acp-canary-design.md`

| # | Task | Status | Session | Last touched | Commit |
|---|---|---|---|---|---|
| 1 | Native process and protocol core | DONE | `acp-opencode-canary` | 2026-07-25 | `2ba64ab68` |
| 2 | Authenticated HTTP/SSE bridge | DONE | `acp-opencode-canary` | 2026-07-25 | `8560c2dfc` |
| 3 | API transport metadata and rollback | DONE | `acp-opencode-canary` | 2026-07-25 | `b558def6f` |
| 4 | SDK ACP transport | DONE | `acp-opencode-canary` | 2026-07-25 | `a28df36f3` |
| 5 | SDK session projection | DONE | `acp-opencode-canary` | 2026-07-25 | `951896a44` |
| 6 | Existing `useSession` integration | DONE | `acp-opencode-canary` | 2026-07-25 | `951896a44` |
| 7 | Local parity and rollback proof | DONE | `acp-opencode-canary` | 2026-07-25 | `33900d7f1` |
| 8 | Delivery and dev proof | DONE | `acp-opencode-canary` | 2026-07-25 | `3a45ab55b` |

---

## NEXT — committed, needs a spec before it starts

Real work, deliberately not scheduled. **Do not start these.** Each needs its own
spec → plan → chain.

| Item                                                        | Why it waits                             | Cost of waiting                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RN `EventStreamTransport` seam**                          | Designed in the v2 spec; deferred by Jay | `apps/mobile/lib/opencode/event-stream.ts` (655 loc) stays a parallel copy of the SDK's 571-loc one. **The divergence grows every week.** Schedule soon.                                                                                                   |
| **Lumen productionisation**                                 | Blocks Lumen's prod ship, not the SDK    | Ownership is a JSON file (`apps/whitelabel-demo/src/server/users.ts`), rate limiting an in-memory `Map` (`…/rate-limit.ts`), both documented single-instance. Anonymous visitors mint a fresh `userId` per visit **and provision real Daytona sandboxes**. |
| **Migrate `apps/web`'s 340 import sites to the root entry** | Optional, mechanical                     | None — the deprecated aliases exist precisely so this has no deadline.                                                                                                                                                                                     |

---

## BACKLOG — real gaps, unscheduled. Agents: append here.

Single, self-contained changes. Anything multi-step earns a spec instead.

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                | Status                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **No skills create/update/delete surface.** The only agent capability with zero SDK coverage.                                                                                                                                                                                                                                                                                                                                                | `grep -rn "createSkill                                                                                                                                                                                                                                                                                  | deleteSkill" packages/sdk/src`→ nothing but a comment in`projects-client/agent-config.ts:7`                                                                                                                                                                            | OPEN |
| B2  | **No account-deletion surface.**                                                                                                                                                                                                                                                                                                                                                                                                             | `grep -rn "deleteAccount" packages/sdk/src` → nothing                                                                                                                                                                                                                                                   | OPEN                                                                                                                                                                                                                                                                   |
| B3  | **Host-local React hooks that belong in the SDK.** `apps/web` hand-rolls hooks over client fns the SDK already exposes — violating "hosts are thin".                                                                                                                                                                                                                                                                                         | `apps/web/src/hooks/{transcription/use-transcription,projects/use-project-gateway,channels/use-channel-bindings}.ts`. `@kortix/sdk/react` has only `use-gateway-catalog-sync.ts`.                                                                                                                       | OPEN                                                                                                                                                                                                                                                                   |
| B4  | `**.name` on `ApiError` is duck-typed by legacy sniffers.** Changing it is a _silent runtime_ break, not a compile break.                                                                                                                                                                                                                                                                                                                    | `src/platform/api/errors.ts:59` — `this.name = 'ApiError'`, with a comment noting legacy sniffers                                                                                                                                                                                                       | WON'T DO for now — documented in `AGENTS.md`; revisit only with a deprecation path                                                                                                                                                                                     |
| B5  | `**structure_version` semantics undocumented** (`1` = legacy tasks, `2` = tickets/board)                                                                                                                                                                                                                                                                                                                                                     | `src/opencode/kortix-master.ts`                                                                                                                                                                                                                                                                         | OPEN                                                                                                                                                                                                                                                                   |
| B6  | **Tripwire regex is blind to side-effect imports.** `import 'react';` (no `from`) matches neither the graph walker's regex nor the examples tripwire — a bare framework side-effect import slips through                                                                                                                                                                                                                                     | Task 9 probe: brief's literal `import 'react';` did NOT fail the test; `import { createElement } from 'react'` did. `src/index.isomorphic.test.ts` (`collectGraph` importRe + examples test)                                                                                                            | **CLOSED 2026-07-12** — shared `importSpecifiers` helper now catches side-effect imports (both quote styles) in the graph walker, the examples scan, AND the inline tier scan; RED-proven, reviewed. Uncommitted fix wave, see `.superpowers/sdd/fix-wave-2-report.md` |
| B7  | **Provider-qualified gateway defaults must remain in the `kortix` picker namespace.** Lock `codex/gpt-5.6-sol` to `{ providerID: 'kortix', modelID: 'codex/gpt-5.6-sol' }` rather than misclassifying it as a native provider.                                                                                                                                                                                                               | `src/react/use-model-store.ts:42` defines every gateway wire model as a `kortix` model ID; `src/react/use-opencode-local.test.ts` now covers the Codex default.                                                                                                                                         | **DONE 2026-07-12** — implementation `ee7d2cc09`; full SDK suite, typecheck, and packed-install smoke green                                                                                                                                                            |
| B8  | **Retire the experimental project-app deployment SDK surface with its removed platform capability.** This is intentionally subtractive because the user explicitly requested complete removal of the underlying capability.                                                                                                                                                                                                                  | The former project-app client module, facade property, types, examples, and snapshot entries were removed in `ec8b44dda`.                                                                                                                                                                               | **DONE 2026-07-13** — session `remove-freestyle`; full SDK gates green                                                                                                                                                                                                 |
| B9  | **Expose E2B as an additive sandbox-provider literal everywhere the published SDK accepts or reports a provider.**                                                                                                                                                                                                                                                                                                                           | Stale explicit unions remained in `src/core/rest/{platform-client/types,projects-client/session-sandbox,projects-client/sessions}.ts`; the server provider unification adds `e2b`.                                                                                                                      | **DONE 2026-07-13** — implementation `5763b63e4`; full SDK gates green                                                                                                                                                                                                 |
| B10 | **Expose the managed Git username alongside the push token.** Code Storage uses `t:<token>` while GitHub uses `x-access-token:<token>`; clients need the provider-selected username to clone and push without hard-coding GitHub credentials.                                                                                                                                                                                                | `src/core/rest/projects-client/projects.ts` models `ProjectGitToken` with only `push_token`; the Code Storage end-to-end flow requires an additive `git_username`.                                                                                                                                      | **DONE 2026-07-19** — implementation `ab80f9305`; full SDK suite, typecheck, and packed-install smoke green                                                                                                                                                            |
| B11 | **Expose owner-scoped member connection creation and profile-specific Pipedream connect/finalize.**                                                                                                                                                                                                                                                                                                                                  | Existing profile lifecycle methods only target manager-owned `/connections` and the shared connector Pipedream identity; session-selected member profiles need additive typed methods for `/connections/me` and `/{connectionId}/connect`.                                                   | **DONE 2026-07-21** — implementation `3eb18b361`; full SDK suite, typecheck, and packed-install smoke green                                                                                                                                                            |
| B12 | **Allow daemon-owned PTY queries before OpenCode reports ready.**                                                                                                                                                                                                                                                                                                                                                                            | `useOpenCodePtyList()` gates `/kortix/pty` on `useOpenCodeRuntimeReady()`, while `apps/kortix-sandbox-agent-server/src/proxy.ts` owns `/kortix/pty` independently of OpenCode.                                                                                                                          | **DONE 2026-07-22** — implementation `c973f9209`; SDK and web suites, packed-install smoke, isolated proxy tests, and live Platinum/Daytona PTY smokes green                                                                                                           |
| B13 | **Add bounded GitHub repository discovery for large managed owners.** The current client can only request the full owner repository list, which exceeds the API processing deadline for `managed-kortix`.                                                                                                                                                                                                                                    | Production `GET /v1/projects/github/repositories?...&installation_id=pat` returned `503` after 25 seconds; `packages/sdk/src/core/rest/projects-client/github.ts` exposes no page or search input.                                                                                                      | **DONE 2026-07-23** — `0748271116`; session `github-repo-selector`                                                                                                                                                                                                     |
| B14 | **Remove the synthetic `auto` model and enforce paid-tier access for every Kortix-managed model in every environment.** Free-tier wallet credits are sandbox-only; stale `auto` requests must fail closed instead of selecting a managed fallback.                                                                                                                                                                                           | `packages/sdk/src/react/use-opencode-local.ts` sends `kortix/auto`; `apps/api/src/billing/services/tiers.ts` disables managed-model entitlement enforcement for every dev/preview account.                                                                                                              | **DONE 2026-07-24** — implementation `406eb5e9a`; session `fix-free-tier-model-entitlement`                                                                                                                                                                            |
| B15 | **Top-level `runtime()` on a scoped client bled to the process-global sandbox (cross-tenant).** `createScopedKortix`'s `wrapScoped` scopes the token but not the top-level `runtime()`, which resolves the process-global active runtime (`getActiveOpenCodeUrl()` → last session to `ensureReady()`). In a multi-tenant KaaB wrapper `kortixA.runtime()` reached another end-user's sandbox. #5273 scoped `session().runtime` but not this. | `src/node/server.ts` (`createScopedKortix`); `src/core/client/kortix.ts:43,752,1000`; `src/core/session/server-store/active.ts:21`. RED-proven in `src/node/server.test.ts` (scoped `runtime()` returned a client instead of throwing).                                                                 | **DONE 2026-07-23** — session `sdk-scoped-runtime`; scoped `runtime()` now throws + steers to `session(pid,sid).runtime`; adds no public export (surface snapshot unchanged); typecheck + full suite (1156 pass) + `smoke:install` green                               |
| B16 | **Retry transient transport failures on idempotent REST reads before reporting them.** Browser CORS preflight failures surface as opaque `TypeError: Failed to fetch`, bypass the existing HTTP 502/503/504 retry loop, and call the host error handler before React Query retries successfully. Cache successful preflights to reduce exposure without retrying mutations.                                                                  | Production session `d9abee06-5af1-48b9-ba92-53ca0fcf0589` logged continuous audit `200` responses after one browser preflight failure; `src/core/http/api-client.ts` retries response statuses but reports initial fetch throws immediately; `apps/api/src/index.ts` emits no `Access-Control-Max-Age`. | **DONE 2026-07-24** — implementation `9f6e5b615`; session `cors-transport-resilience`                                                                                                                                                                                  |
| B17 | **Add native OAuth2 client-credentials lifecycle support to existing connector connections.** Static bearer credentials cannot acquire, cache, refresh, or revoke OAuth2 access tokens. Microsoft Graph and SharePoint require OAuth2 and cannot use a static API key.                                                                                                                                                               | `apps/api/src/connectors/credentials.ts` decrypts one opaque value; `apps/api/src/connectors/db-deps.ts` passes that value directly to `executeCall`; `packages/sdk/src/core/rest/projects-client/connectors.ts` accepts only `{ value }`.                                                                  | **DONE 2026-07-24** — session `native-oauth-sharepoint`; full SDK gates and real SharePoint proof green                                                                                                                                                                |
| B18 | **Keep the managed-model playground pin synchronized with the managed catalog.** The playground exits before API access when its pinned IDs differ from `MANAGED_MODELS`.                                                                                                                                                                                                                                                                    | `packages/sdk/playground/chat/14-change-default-model.ts` still pins retired `qwen3.7-max` and `deepseek-v4-pro`.                                                                                                                                                                                       | **DONE 2026-07-24** — session `managed-models-aster`; full SDK gates green                                                                                                                                                                                             |
| B19 | **Preserve explicit managed-model pricing and cache-write rates through the project catalog and turn-cost estimator.** Browser-side `models.dev` lookup can substitute another provider's price for a Kortix-managed model, and the turn estimator does not accept a distinct cache-write rate.                                                                                                                                              | `src/core/rest/projects-client/projects.ts`, `src/core/turns/types.ts`, `src/core/turns/state.ts`; confirmed for managed Aster `glm-5.2`.                                                                                                                                                               | **DONE 2026-07-25** — implementation `28c18cbfa`; full SDK suite, typecheck, public-surface snapshot, and packed-install smoke green                                                                                                                                   |
| B20 | **Keep ACP SSE connections outside the shared 30-second authenticated-fetch timeout.** The ACP controller uses `/kortix/acp/:sessionId` as a long-lived SSE stream.                                                                                                                                                                                                                                                                            | `src/platform/auth-core.ts` exempted only `/global/event`; deployed cold Chromium aborted the ACP stream before `session/load` settled.                                                                                                                                                                | **DONE 2026-07-25** — implementation `89b97f4cc`; RED test, full SDK gates, and local cold ACP plus REST browser matrix pass                                                                                                                                                                                                         |
| B21 | **Serialize ACP sends with runtime restart reloads.** A send that starts while OpenCode restarts can wait forever on `session/set_config_option` and never send `session/prompt`.                                                                                                                                                                                                                                                               | Deployed cold Chromium sent `session/set_config_option` at `13:36:20.250Z`, received `kortix/runtime_ready`, then sent `session/load` at `13:36:20.640Z`; `POST_RESTART_PONG` never produced `session/prompt`.                                                                                              | **DONE 2026-07-25** — implementation `d8537fa2c`; RED tests, full SDK gates, and test-harness typecheck pass                                                                                                                                                                                                                          |
| B22 | **Expose server-owned warm project-session ensure and claim operations.** The project index needs one reusable empty session without owning session selection or deduplication in app code.                                                                                                                                                                                                                                                   | `apps/web/src/app/(app)/projects/[id]/page.tsx` creates a session only after send. `packages/sdk/src/core/rest/projects-client/sessions.ts` exposes create and list, but no atomic warm-session operation.                                                                                              | **DONE 2026-07-26** — implementation `13167d7cf`; RED tests, full SDK gates, live API/SDK lifecycle, workspace refresh, and maintenance retention proof pass                                                                                                                                                                           |
| B23 | **Prevent ACP prompt results from exposing a false idle window before late protocol updates settle.**                                                                                                                                                                                                                                                                                                                                          | The deployed white-label parity screenshot rendered 4 ACP tool cards and `Agent is working…`, while REST rendered 26 completed tool cards. `applyAcpEnvelope()` marks the projection idle on the prompt result, and later tool or text updates can mark it busy again.                                                                                                  | **IMPLEMENTATION COMPLETE 2026-07-30** (worktree `bugbash`, uncommitted) — session `acp-turn-liveness`. Root cause pinned with production data: `session/load` makes the harness re-emit a finished conversation as BRAND-NEW `session/update` events (dev session `10533f77-00e3-420c-936b-82933e4d1025`, `kortix.acp_session_envelopes` upstream ids `1431`-`1842` at ordinals `44560`-`57861`, i.e. AFTER the `end_turn` response at ordinal `26518`), so no dedupe or ordinal cursor can suppress them and no terminator follows. `AcpProjection` now carries `pendingPrompts` — the unanswered-`session/prompt` ids — and `status` is derived from it alone; content appends no longer mark a turn busy. A prompt settles on its response, on a JSON-RPC error response, or on the next `initialize`/`session/new`/`session/load` re-attach. Replaying the real 1,912-envelope transcript folds to `{type:'idle'}` (was `{type:'busy'}`). SDK gates: typecheck exit `0`, `1413 pass` / `0 fail` / `121 files`. PR, Deploy Dev, and deployed proof required. |
| B24 | **Accept a server-authorized initial OpenCode session pin in `useSession`.** The SDK must hydrate the cached transcript before runtime readiness without making the initial pin authoritative over the `/start` result.                                                                                                                                                                                                                          | Existing sessions wait for `/start` before `useSessionSync` can hydrate IndexedDB history. The preserved `session-load-latency` work proved the additive option and pin precedence.                                                                                                                       | **IN PROGRESS 2026-07-26** — session `api-latency-refactor`; RED test, implementation port, full SDK gates, browser proof, merge, and Deploy Dev proof required                                                                                                                               |
| B25 | **Start project model-picker and project-detail reads in parallel.** Gateway projects must not wait for project detail before the SDK starts the compact model-picker request.                                                                                                                                                                                                                                                                   | `src/react/use-opencode-sessions/providers.ts` enables the model query only after `projectDetailQuery.isSuccess`, which creates a sequential request waterfall on project load.                                                                                                                          | **IN PROGRESS 2026-07-26** — session `api-latency-refactor`; RED test, implementation, full SDK gates, browser network proof, merge, and Deploy Dev proof required                                                                                                                            |
| B26 | **Do not report an expected warm-session configuration mismatch as a global API error.** The web client catches `WARM_SESSION_CONFIGURATION_MISMATCH` and creates a normal session.                                                                                                                                                                                                                                                               | `src/core/rest/projects-client/sessions.ts` calls `/sessions/warm/claim` with the default `showErrors: true`, so the recoverable `409` still reaches the host error handler.                                                                                                                                | **DONE 2026-07-26** — PR #5529, merge `5c0ae97ec`; SDK tests `1280/0`; deployed US proof observed the typed `409`, normal-session fallback, exact `PONG`, and no global mismatch error                                                                                                      |
| B27 | **Retry the transient IAM policy read that caused the all-account project query failure.** The projects page can issue one query per account.                                                                                                                                                                                                                                                                                                     | Live US shadow evidence at `2026-07-26T20:03:20Z`: one IAM-backed `GET /projects` returned `500`; the identical retry returned `200` after `1.4s`. The wrapped `DrizzleQueryError` hid the nested PostgreSQL cause from logs.                                                                                  | **DONE 2026-07-26** — PR #5529, merge `5c0ae97ec`; one bounded transient read retry fails closed; wrapped PostgreSQL details are logged; API tests `40/0`; US API rollout completed with `2/2` tasks                                                                                             |
| B28 | **Keep an explicit project-composer agent selection through asynchronous project-default hydration.**                                                                                                                                                                                                                                                                                                                                               | The deployed US two-test session suite clicked `memory-reflector`, then `useOpenCodeLocal()` changed its selection scope when `defaultAgentName` hydrated to `kortix`. The picker reset to `kortix` for 30 seconds.                                                                                          | **DONE 2026-07-27** — PR #5533, merge `ee45f55fa`; SDK tests `1283/0`, typecheck, packed-install smoke, and deployed US two-test suite `2/2` pass; both sessions returned exact `PONG`, and the mismatch fallback emitted no global error                                                                                                                                    |
| B29 | **Preserve ACP upstream message boundaries in the projected transcript.**                                                                                                                                                                                                                                                                                                                                                                              | Dev session `ee41f742-9384-4f34-88e7-63ae3d765cae` emitted distinct `session/update.messageId` values for assistant steps, but `src/core/acp/projection.ts` discarded `messageId` and appended every text or reasoning chunk to one generated assistant message.                                                                                      | **DONE 2026-07-27** — implementation `60b06c6e4`; focused projection/controller tests `27/0`, full SDK tests `1299/0`, typecheck, packed-install smoke, supplied-transcript replay, and local ACP Chromium flow pass                                                                                                                                                                                          |
| B30 | **Expose message-based session rewind and restore through both REST and ACP transports.** Editing an earlier user message must rewind the same canonical session instead of creating a fork. The removed path must remain recoverable until the replacement prompt commits.                                                                                                                                                                      | `apps/web/src/features/session/session-chat.tsx` contains `TODO(session-rewind)`. OpenCode exposes `/session/{sessionID}/revert` and `/unrevert`; ACP has no standard rewind method and needs a Kortix bridge extension plus transcript reload.                                                               | **DONE 2026-07-27** — implementation `eab4eef0f`; PR #5619 merged as `9e90e8ed7`. Deploy Dev run `30293660760` deployed source `e548c6a8fc9ee1d5a92db66d6feb912d4442ebeb`, which contains the merge. Dev session `7feb4e84-072f-4b71-987f-dc25dd542890` kept canonical OpenCode session `ses_05b075d25ffe7PBkZ632pcVAlW` across ACP and REST rewind, restore, replacement commit, reconnect, and file rollback. ACP produced `DEPLOYED_ACP_REPLACEMENT`; REST produced `DEPLOYED_REST_REPLACEMENT`; cleanup removed `26/26` probe sessions and restored ACP runtime overrides. SDK tests `1309/0`, daemon tests `306/0`, web source contract `5/0`, local ACP Playwright `1/0`, and local real ACP plus REST smoke pass. Shippable to production: **YES** for protocol behavior. Deployed UI interaction remains unverified because Browser discovery returned `[]`. |
| B31 | **Allow a page-scoped ACP query override and settle completed ACP prompts that contain stale running tools.**                                                                                                                                                                                                                                                                                                                                     | `?acp` has no SDK transport override. Dev session `5322fa59-7a73-4fea-9f1a-9da59c2a0b5a` rendered the final assistant response while an older tool part remained `running`; `hasProjectionBlockers()` then kept the composer busy and blocked the queued prompt.                                                                 | **IMPLEMENTATION COMPLETE 2026-07-27** — implementation `d3544ae14`; focused SDK `40/0`, full SDK `1312/0`, typecheck, packed-install smoke, web routing `5/0`, and touched web ESLint pass. PR #5636, Deploy Dev, deployed SHA proof, and deployed ACP-only proof remain |
| B32 | **Synchronize generated Kortix session names from both ACP and OpenCode REST runtimes without navigation or refresh.**                                                                                                                                                                                                                                                                                                                           | ACP emits `session_info_update`; OpenCode `/global/event` emits a wrapped `session.updated`. Neither path reliably persisted `metadata.name`, and the sidebar query could stay stale after a completed prompt.                                                                                              | **IMPLEMENTATION COMPLETE 2026-07-28** — ACP and REST title events persist server-side; the SDK refetches list and detail queries through a bounded post-send loop; focused API `78/0`, full SDK `1318/0`, API and SDK typechecks, packed-install smoke, test-harness typecheck, and local ACP plus REST Chromium `1/0` pass. Full API has `3` pre-existing failures reproduced in the primary checkout. PR, Deploy Dev, deployed SHA proof, and deployed UI proof remain. |
| B33 | **The ACP transcript has no bounded read — a session replays every envelope on open.** OpenCode REST opens on a bounded newest-first page (`SESSION_SYNC_PAGE_SIZE`) and pages backwards through a cursor; ACP has no equivalent, so the ACP path gets slower without limit as a session grows. As ACP becomes the only transport, the bounded-read property is lost with it. | `GET /:projectId/sessions/:sessionId/acp/transcript` (`apps/api/src/projects/routes/acp.ts:160`) and `loadAcpTranscript` (`apps/api/src/projects/lib/acp-transcript.ts`) accept only `after` (forward tailing for gap recovery) — no `before`/`limit`. `useSession` hardcodes `hasOlder: false` / `loadOlder: async () => {}` for ACP (`src/react/use-session.ts:533-535`). **Not a small change:** the projection is a fold over the whole envelope log (`applyAcpEnvelope`), so replaying a suffix yields a wrong projection — open tool calls, session info, and rewind state all live in earlier envelopes. Needs either envelope-range snapshots or a projection checkpoint, then the existing `hasOlder`/`loadOlder` contract plugs into the transcript's scroll-driven autoload unchanged. | OPEN |

| B34 | **A losing ACP identity claim dead-ended the session instead of adopting the winner.** Two writers mint a harness-native session for one Kortix session row — headless prompt delivery in the API, and `AcpSessionController.loadCanonicalSession()` in the browser. The platform CAS guard returned `409 acp_session_id is immutable after the first successful session/new response`; the SDK threw before assigning `protocolSessionId`, so `useSession` surfaced "OpenCode failed to load" and every later reload minted another orphan harness conversation. | `core/acp/session-controller.ts` threw at the `persistAcpSessionId` await (pre-fix line `341`) with `protocolSessionId` still `null`; `react/use-acp-session-runtime.ts:78-84` discarded the identity response body. | **IMPLEMENTATION COMPLETE 2026-07-30** (worktree `bugbash`, uncommitted) — `persistAcpSessionId` widened to `Promise<string \| void>`; the controller adopts the stored id from a 200 body or from a `409` carrying `acp_session_id`, then `loadSession`s it and reaches `{ready:true, connection:'open', error:null}`. A `409` without an id still surfaces the error. Depends on the API adding `acp_session_id` to the conflict body (separate change, `apps/api/**`). SDK gates: typecheck exit `0`, `1390 pass` / `0 fail` / `121 files`, packed-install smoke pass. |
| B35 | **Fan out `client_to_agent` envelopes on the live ACP SSE stream, or a second viewer cannot see a turn it did not start.** The API replays both directions from the transcript on connect (`loadAcpTranscript` in `apps/api/src/projects/routes/acp.ts:160,313`), but the live proxy only forwards agent-to-client events, and a `session/prompt` response persisted by the POST branch is never streamed. A browser already connected when a headless/trigger prompt starts therefore never sees the request, so `AcpProjection.pendingPrompts` stays empty and the turn renders settled while the agent works. | `apps/api/src/projects/routes/acp.ts:281-268` persists the direct prompt response with no stream write; `apps/api/src/projects/lib/acp-sse-proxy.ts` writes only upstream SSE blocks. Surfaced while fixing B23, where content arrival stopped being treated as liveness. | OPEN |
| B36 | **`useSession` owned no chat mount id, so every host had to re-derive one from the OpenCode pin.** A managed-ACP session never has `project_sessions.opencode_session_id` (never written at create time — `apps/api/src/projects/lib/sessions.ts:1290-1291` — and `openSession`'s ACP branch passes the null through, `apps/api/src/projects/routes/shared.ts:923,932`). `apps/web` derived its mount id from that pin and hard-returned `null`, so a healthy ACP session rendered an empty shell: no composer, no transcript, no loader, while the agent worked server-side. The SDK already owned the correct predicate (`hasSessionRuntimeIdentity`, with a passing test named "managed ACP does not require an OpenCode session id") but exposed no id built from it. | Live `/start` on session `10533f77-00e3-420c-936b-82933e4d1025`: `stage=ready`, `runtime_transport=acp`, `acp_session_id=ses_04ff3eb99ffedjXUSdT2WJBShj`, `opencode_session_id=None`. Host derivation at `apps/web/.../sessions/[sessionId]/page.tsx:664` + hard `return null` at `:793`. | **IMPLEMENTATION COMPLETE 2026-07-30** (worktree `bugbash`, uncommitted) — `react/session-runtime-identity.ts` adds `resolveSessionMountId` (REST → the OpenCode pin; ACP → the durable Kortix session id; `null` until the runtime has an identity) and `useSession` returns it as `chatSessionId`. Additive: no export renamed, public-surface snapshot unchanged. Live browser proof on a managed-ACP session: composer textarea exists, `[data-testid=session-chat]` + `[data-testid=session-layout]` present, boot loader gone, 3 transcript messages rendered. |
| B37 | **A stale cached `/start` made every ACP controller mint a throwaway harness conversation.** The mint is a runtime call, so nothing refreshed `/start`; the cached response kept saying "no harness session yet" for the whole tab. Each later controller (remount, Fast Refresh, tab reopen) therefore called `session/new` again, got the platform's `409 ACP_SESSION_ID_CONFLICT`, adopted the winner and abandoned its own conversation — one leaked harness conversation per mount, plus a user-facing error toast naming an internal invariant. | Recovered-conflict noise reached the global `onError` hook (`apps/web/src/lib/error-handler.tsx:handleApiError` → toast + Sentry) with the message `acp_session_id is immutable after the first successful session/new response`. | **IMPLEMENTATION COMPLETE 2026-07-30** (worktree `bugbash`, uncommitted) — `useAcpSessionRuntime` reports the settled id (`onAcpIdentitySettled`), `useSession` corrects the cached `/start` identity, `nextAcpIdentity` keeps the write-once id out of the controller memo so learning it never tears down a live stream, and `core/http/api-client.ts` classifies a typed `409 ACP_SESSION_ID_CONFLICT` as silent to `onError` (same pattern as the typed `501 feature_not_supported`). Live proof: 6 controller opens on one session → `session/new` **1**, `session/load` **4**, zero orphans, zero conflicts. |

> **Paths above are as of today (pre-Task-4).** After the restructure they move:
> `platform/api/` → `core/http/api/`, `opencode/` → `core/runtime/`,
> `platform/projects-client/` → `core/rest/projects-client/`. If a grep comes up
> empty, check whether Task 4 has landed before assuming the row is stale.

> **Adding a row?** Give it the next `B<n>`, cite **evidence** (a path, a grep, a
> command and its output), and set `OPEN`. Do not renumber existing rows.

---
| B38 | **A replay-revealed message was appended, so a reload could render the answer above its question.** `applyAcpEnvelope` positioned every message by first appearance in the fold, with no order key. A `session/load` replay that introduced a message the projection had never seen appended it. Folding dev session `6a7b3c29-ce92-4e4f-8f63-2696db54b1b9` from its `session/load` at ordinal 509 rendered `assistant("What's \"das\"...") , user("yo"), assistant, user, assistant, user, assistant, user("das"), user("yo")` — the conversation's LAST answer at the head and `user("das")` with no reply. FIXED: `insertAt`/`withMessage`/`anchored` place a replay-revealed message after the message the replay positioned last; a replay only becomes the order authority once its first USER turn lands. Mirrored in `apps/api/src/shared/compact-transcript.ts`. | DONE (uncommitted, worktree `bugbash`) |
| B39 | **The token meter re-derived a total that some providers do not use.** `finishPrompt` stored the five raw usage components and discarded `totalTokens`; `apps/web/.../token-progress.tsx` summed them. Across `kortix.acp_session_envelopes`, `totalTokens` is present on 184/184 object usage payloads; 174 satisfy `total = input+output+thought+cachedRead+cachedWrite`, 10 satisfy `total = input+output+cachedRead+cachedWrite` (gpt-5.x bills thinking INSIDE `outputTokens`), 0 satisfy neither. Summing therefore over-reported by `thoughtTokens` on 10 sessions, and `at(-1)` targeting dropped usage whenever a queued prompt appended the next user bubble first (meter read 0, or 19563 vs 19675). FIXED: `reportedTokens` reconciles the components against `totalTokens` with `reasoning` always `thoughtTokens`; `finishPrompt` targets the last ASSISTANT. Corrects 10 of 138 real sessions. | DONE (uncommitted, worktree `bugbash`) |
| B40 | **`usage_update{size,used}` is projected but still not wired to the meter.** `AcpProjection.contextWindow`/`contextUsed` now carry the harness's own context report (dev `10533f77-…`: `size 200000, used 30470`). Nothing reads them: `TokenProgress` gets `messages`, not the projection, and `getContextLimit` still guesses from the client model catalog or defaults to 200000. 7 of 138 real sessions report a meter of 0 while `contextUsed` knows the answer (`17c78bef-…`: meter 0, `contextUsed` 12502, truth 12516) — usage that arrives before any assistant message exists is lost. Needs `contextWindow`/`contextUsed` plumbed from `useSession` to the composer. | OPEN |
| B41 | **The two ACP folds disagree on message boundaries for harnesses that emit no `messageId`.** `bun /tmp` harness-agnostic check over 241 sessions: SDK `projection.ts` and API `compact-transcript.ts` agree on role sequence + tool count for 218, disagree for 23, unchanged by B38/B39. All disagreements are ±1 assistant message on Pi-style logs where every chunk is unnamed, so boundaries come from open-message heuristics that differ across an attach. Pre-existing at HEAD (23 there too). | OPEN |
| B42 | **A prompt that errors renders as an unanswered user bubble with no explanation.** `applyAcpEnvelope`'s response branch clears the pending prompt and drops `envelope.error` unless a `promptDrafts` entry survives. Dev session `ecc2d856-a08d-4cda-98bb-b76a7c892e69`: six `session/prompt` calls all answered `-32603 Internal error: OpenCode service failure`, and the projection is six user messages and zero assistants. `AcpProjection` has no per-turn error surface for a renderer to show. | OPEN |
| B43 | **Expose the emoji project icon on the SDK's typed project contract.** Tasks 1–3 of the project-emoji-icons plan added `icon` to the API request/response bodies (`packages/api-contract/src/index.ts:120`, `icon: z.string().nullable()`); the SDK declares its own independent types and had no `icon` field anywhere. | `KortixProject`, `ProvisionProjectInput`, `CreateProjectRepoInput` (`packages/sdk/src/core/rest/projects-client/projects.ts`) and `LinkRepositoryInput` (`packages/sdk/src/core/rest/projects-client/github.ts`) carried no `icon` member; plan `docs/superpowers/plans/2026-07-31-project-emoji-icons.md`; spec `docs/superpowers/specs/2026-07-31-project-emoji-icons-design.md`; task brief `.superpowers/sdd/2026-07-31-project-emoji-icons/task-4-brief.md`. | **DONE 2026-07-31** — session `sdk-project-emoji-icon`; implementation `8f8db0d4f1`; full SDK gates green (see session log) |
| B44 | **`ProjectInput` — the `updateProject` body — carries no `icon`, so a project's emoji is write-once.** B43 added `icon` to the CREATE inputs and to the response type only. `updateProject(projectId, input: Partial<ProjectInput>)` is the sole SDK path to `PATCH /v1/projects/:projectId`, and its input type declares `account_id`/`name`/`repo_url`/`default_branch`/`manifest_path` — so a host cannot change or remove an icon without an `as any` cast. The API's tri-state semantics need `string \| null`, not `string`: an absent key leaves the icon alone, an explicit `null` clears it. | `ProjectInput` (`packages/sdk/src/core/rest/projects-client/projects.ts:163`) has no `icon` member; `updateProject` at `:427`; API handler `apps/api/src/projects/routes/r5.ts` (tri-state `icon` landed in `c76c6f962`). | **DONE 2026-07-31** — session `sdk-project-edit-icon`; implementation `cc5c36dbc4`; typecheck exit 0, full suite 1365 pass / 0 fail across 116 files, packed-install smoke pass |
| B45 | **Expose the second, named-glyph project icon (`icon_glyph`) on the SDK's typed project contract.** Tasks 1–5 of the project-glyph-icons plan added a server-validated `icon_glyph: {name,color} \| null` alongside the existing emoji `icon` — across the API contract, all three create paths, and `PATCH /projects/:id`'s tri-state semantics (the glyph wins and clears `icon` if both are sent). B43/B44 gave the SDK its own independent `icon` field; it has no `icon_glyph` anywhere. | `KortixProject`, `ProjectInput`, `ProvisionProjectInput`, `CreateProjectRepoInput` (`packages/sdk/src/core/rest/projects-client/projects.ts`) and `LinkRepositoryInput` (`packages/sdk/src/core/rest/projects-client/github.ts`) carry no `icon_glyph` member; plan `docs/superpowers/plans/2026-08-01-project-glyph-icons.md`; spec `docs/superpowers/specs/2026-08-01-project-glyph-icons-design.md`; task brief `.superpowers/sdd/2026-08-01-project-glyph-icons/task-6-brief.md`. | **DONE 2026-08-01** — session `sdk-project-glyph-icon`; implementation `3ce3e5f1f`; typecheck exit 0, full suite 1374 pass / 0 fail across 116 files, packed-install smoke pass, both brief mutations killed via typecheck (see session log) |
| B46 | **Expose session agent-config freshness and reload.** A session's agent behaviour is compiled from git once, at provision, and frozen into the sandbox env — so merging an agent change never reaches an open session. The API grew `GET /v1/projects/:id/sessions/:sid/config` and `POST .../reload` (`apps/api/src/projects/routes/r7.ts:2170,2223`) and the CLI grew `kortix sessions reload` (`apps/cli/src/commands/sessions.ts:213`), but the SDK had neither, so `apps/web` could not offer it at all — and `apps/web/src/sdk-boundary-baseline.json` forbids reaching past `@kortix/sdk`. | `grep -rn "sessions/.*/reload" packages/sdk/src` → nothing but the unrelated sandbox-runtime `/kortix/services/system/reload`. Additive: `getProjectSessionConfigState`, `reloadProjectSessionConfig`, `SessionConfigState`, `SessionReloadResult`, plus `session().configState()` / `session().reloadConfig()` on the facade. | **DONE 2026-08-03** — session `stale-session-ui`; typecheck exit 0; full suite 1416 pass / 1 fail across 117 files (the single failure, `fetchCostExportCsv`, is PRE-EXISTING — it passes in isolation and fails identically at 1410/1 on a clean tree, a cross-file `configureKortix` token leak); packed-install smoke pass; surface snapshots re-recorded and reviewed as **purely additive, 0 removals** |
| B47 | **A reload reported success while the agent kept running the old prompt.** `SessionReloadResult` exposed `applied` (the compiled config was pushed) but nothing about whether the agent files opencode actually READS were updated — and those came apart in production. Verified on dev: marker present in `~/.config/kortix-opencode.json`, absent from opencode's `/config` and `/agent`, because `OPENCODE_CONFIG_DIR` points into the session's working tree and its `.md` files win. | Additive: `config_dir_synced?: boolean | null` and `config_dir_reason?: string` on `SessionReloadResult`. Tri-state on purpose — `false` is a deliberate refusal (the session edited its own agent files), `null` is an older daemon that could not say. | **DONE 2026-08-03** — session `stale-session-ui`; typecheck exit 0; full suite 1419 pass / 1 fail across 117 files (the failure, `fetchCostExportCsv`, is PRE-EXISTING — passes in isolation, fails identically on a clean tree); packed-install smoke pass; type snapshot re-recorded and reviewed as **purely additive, 0 removals** |
| B48 | **Canonical feature-flag naming + one gating primitive.** The platform renamed the system to "Feature flags" (`FeatureFlag*` in `@kortix/api-contract`, `FeatureFlagStabilitySchema` = experimental\|beta\|stable, gated routes returning `403 {code:'feature_disabled', feature}`, canonical `PATCH /projects/:id/features`). The SDK still exposed only `Experimental*` names, had no runtime key list for cross-package drift tests, no typed narrowing for the 403, and no shared React gate hook — so every host hand-rolled `project?.experimental?.<key> === true`. | Additive only: `FeatureFlagKey`, `FeatureFlagView` (stability widened to `'experimental'\|'beta'\|'stable'`), `FEATURE_FLAG_KEYS`, `updateFeatureFlag` (canonical `/features` route), `isFeatureDisabledError`, `FeatureDisabledError`, `useFeatureFlag`, and `project(id).updateFeatureFlag` on the facade. Every `Experimental*` name kept as a `@deprecated` alias; `updateExperimentalFeature` keeps its `/experimental` wire path for older deployed APIs. | **DONE 2026-08-08** — session `feature-flags-web`; TDD RED first on all four (`Export named 'FEATURE_FLAG_KEYS' not found`, `Export named 'isFeatureDisabledError' not found`, `Cannot find module './use-feature-flag'`); GREEN at `1777 pass, 0 fail, 6965 expect()` across `139` files; `typecheck` exit 0 (package + examples); `smoke:install` packed + installed + imported OK. Both surface snapshots re-recorded and reviewed: **11 + 20 insertions, 0 removals — purely additive** |
| B49 | **`applyOptimisticAbort` marks a turn errored but never ends it.** It sets `error: AbortError` and flips the session idle, but leaves `time.completed` unset — and an aborted turn may never receive a `message.updated` that sets it. Any host predicate written as `!lastAssistant.time?.completed` therefore stays true for the life of the tab after every stop. It wedged `apps/web`'s message-queue drain gate permanently: every message typed after an interrupt queued behind one that could never be released. | `src/react/use-session-send.ts:271-296` — sets `error`, no `time.completed`. Worked around host-side in `apps/web/src/features/session/assistant-turn-open.ts` (errored ⇒ ended), which is a patch on the symptom; the SDK should end the turn it aborts. | OPEN |

## DISCOVERED THIS SESSION — append freely

Things found mid-task that you did **not** fix. Fixing them inside a claimed task
is scope creep; losing them is worse. Land them here, then tell the user.

| Date       | Session                  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                                                             |
| ---------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-08-08 | `feature-flags-web`      | **`apps/mobile` and `apps/whitelabel-demo` still say "Experimental" for the whole feature-flag system.** Both render the catalog off the deprecated `ExperimentalFeatureView` alias, call `updateExperimentalFeature` (the legacy `/experimental` route), and label the section "Experimental" — the platform now calls the system "Feature flags" and treats experimental/beta/stable as a per-flag stability badge. They compile unchanged (alias + widened union are both backwards-compatible) so nothing is broken, but the copy and the route are now behind the web app. Neither was redesigned in this session by instruction. | `apps/mobile/components/pages/SettingsNavPage.tsx:268,314-318`, `apps/mobile/lib/projects/hooks.ts:216-225`, `apps/whitelabel-demo/src/app/projects/[id]/settings/page.tsx:223-278` |
| 2026-07-30 | `bugbash-model-resilience` | **Any ACP send failure replaces the whole chat surface with the page-level "OpenCode failed to load" card.** `executeSend`'s catch patches `error` onto the controller snapshot, `useSession` republishes it as `runtimeError`, and `apps/web`'s session page renders `InlineSessionError` + Restart INSTEAD of `SessionLayout`/`SessionChat` for it. Model-not-found is now recovered before it can reach that path, but a gateway 500 or a provider error on a send still nukes a healthy session's transcript and composer. The send failure is ALREADY surfaced inline as `sendError`; the controller should not also mark the runtime dead | `packages/sdk/src/core/acp/session-controller.ts:575-589` (patch `error`), `packages/sdk/src/react/use-session.ts:884` (`runtimeSessionError`), `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:775-800` (full-page card) |
| 2026-07-30 | `bugbash-model-picker`   | **An explicit model pick has nowhere to persist on a composer with no `sessionId` and no loaded agent** (project home). `setModel` writes the per-agent slot only `if (currentAgent)` and the per-session slot only `if (scopedSessionModelKey)`; with neither it writes `visibility` + `recent` only, both of which lose to `serverDefaultKey` in the read chain — so the picker trigger never moves. Verified in a real browser: after clicking "Claude Sonnet 4.6" on `/projects/<id>`, `localStorage['opencode-model-store-v1']` held only `user` + `recent`, no `selectedModel`/`sessionModel`, and the trigger stayed on the platform default. The read chain's own comment (`:470`) claims selection "must NOT depend on a loaded agent", which the write side does not honour | `packages/sdk/src/react/use-opencode-local.ts:512-545` (write), `:443-459` (read) |
| 2026-07-10 | `01AzJBSa`               | The original plan's "bump to `0.3.0`" is **impossible** — `version` is inert and `latest` on npm is `0.9.100`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `scripts/stage-npm-publish.mjs:32`                                                                                |
| 2026-07-10 | `01AzJBSa`               | `KortixProject` declared **twice**, as two different interfaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `core/rest/projects-client/projects.ts:31`, `core/runtime/kortix-master.ts:577`                                   |
| 2026-07-10 | `01AzJBSa`               | Bare `process.env` read in the isomorphic core → `ReferenceError` in a `<script>` bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `platform/platform-client/shared.ts:29` — fixed in Task 7                                                         |
| 2026-07-10 | `01AzJBSa`               | The tripwire walks **imports**; it cannot see globals (`process`/`window`/`document`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `src/index.isomorphic.test.ts` — fixed in Task 7                                                                  |
| 2026-07-10 | `01AzJBSa`               | Nothing installs and imports the tarball. `npm pack --dry-run` lists contents only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `.github/workflows/package-tests.yml` — Task 2                                                                    |
| 2026-07-10 | `ab099b6a`               | Plan's smoke script can't install: staged `workspace:*` dep pins `@kortix/llm-catalog@0.0.0-smoke`, absent from npm. Fixed per Jay: pack + install the sibling tarball alongside                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/sdk/scripts/smoke-install.mjs` — Task 2                                                                 |
| 2026-07-10 | `ab099b6a`               | **`createServerKortix` does not exist.** Plan (`:253,991`) and spec (`:158`) assert it from `./server`; real exports are `createScopedKortix`, `runWithKortix`, `getScopedConfig` (`src/server.ts`). Also affects Task 6's Lumen snippet                                                                                                                                                                                                                                                                                                                                                              | `docs/superpowers/{plans,specs}/2026-07-10-*` — Task 2/6                                                          |
| 2026-07-10 | `ab099b6a`               | Docs prose says 25 subpaths / 21 legacy; reality is 23 export keys / 20 legacy. Plan's enumerated key lists (Task 5 Step 9) match reality exactly                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/sdk/package.json`                                                                                       |
| 2026-07-10 | `ab099b6a`               | Plan's `createCliToken` facade name is fictional; real facade method is `kortix.project(id).tokens.create(input?)` (→ `createProjectCliToken`). `gateway.sessions(days?)` was correct                                                                                                                                                                                                                                                                                                                                                                                                                 | `packages/sdk/src/core/client/kortix.ts:303` — found in Task 6                                                    |
| 2026-07-10 | `ab099b6a`               | Demo e2e harness memoizes builds on `.next/BUILD_ID` — e2e runs silently exercise STALE builds after source changes; must clear `.next` (or fix the harness) for trustworthy runs                                                                                                                                                                                                                                                                                                                                                                                                                     | `apps/whitelabel-demo/tests/e2e/harness.ts` (`ensureBuilt()`)                                                     |
| 2026-07-10 | `ab099b6a`               | Original preview-token malformed-200 guard was itself broken: `upstreamRes.status \|\| 502` returns 200 on that path, so the "error" response shipped as HTTP 200. Fixed by the Task 6 rewrite (now a real 502, e2e-covered)                                                                                                                                                                                                                                                                                                                                                                          | `apps/whitelabel-demo/src/app/api/preview-token/route.ts` (pre-`19e500e50`)                                       |
| 2026-07-10 | `ab099b6a`               | **CRITICAL (final review): the CDN claim is unfulfillable by the release pipeline.** Publish runs tsc only (`publish-npm-package.sh:36`; `prepublishOnly` tsc-only) so tsup bundles never land in the tarball; `stage-npm-publish.mjs:37` promotes only `type/main/types/exports/files/bin`, so `browser`/`unpkg`/`jsdelivr` stay nested in `publishConfig` where npm/unpkg/jsDelivr never look; nothing validates them at release. Plan flaw (plan `:1253-1278` said "pass through untouched"), faithfully implemented. Decision with Jay: wire the pipeline vs walk back the README/CHANGELOG claim | `scripts/{publish-npm-package.sh,stage-npm-publish.mjs}`, `packages/sdk/{README,CHANGELOG}.md`                    |
| 2026-07-10 | `ab099b6a`               | `bundle.test.ts` never executes in CI (no workflow runs `build:bundles` → both tests skip forever) and NO workflow runs `pnpm --filter @kortix/sdk typecheck` at all (examples' "typechecked in CI" claim is local-only). Two cheap CI steps close both                                                                                                                                                                                                                                                                                                                                               | `.github/workflows/package-tests.yml`                                                                             |
| 2026-07-10 | `4003a41b`               | GETTING-STARTED step 3 was un-followable: the web "API keys" tab's **Create button only rendered in the empty state**, and the connector auto-mints "Connector Session" tokens, so real accounts never see it — no way to mint a PAT from the UI. Fixed (uncommitted, this worktree): `CreateApiKeyAction` header button + regression test; doc wording updated ("CLI tokens tab" → "API keys")                                                                                                                                                                                                         | `apps/web/src/features/accounts/settings/cli-tokens-tab.tsx`, `packages/sdk/GETTING-STARTED.md`                   |
| 2026-07-10 | `4003a41b`               | **`ensureReady()` is single-shot** — one `/start` with `wait_ms=30_000`, then throws `RUNTIME_UNAVAILABLE`; a cold provision (observed: minutes) makes EVERY ensureReady example (02/04/06/07) fail — callers must hand-roll a retry loop (examples 09/step4 in this worktree do). Live-observed worse: the server returned near-instantly ~99× in 5min (long-poll not held), and one session went provisioning→stopped and then **disappeared from `projects.sessions()`**. SDK DX gap: `ensureReady({ deadlineMs })` or documented retry                                                            | `packages/sdk/src/core/client/kortix.ts:674` (verified live against local stack)                                  |
| 2026-07-10 | `4003a41b`               | Local-stack default-agent sends fail: gateway forwards opencode's `max_tokens` to a model demanding `max_completion_tokens` (OpenAI `unsupported_parameter`, HTTP 400) → default `send()` turns error with no assistant reply. Workaround verified live: per-send model override `{ providerID: 'kortix', modelID: 'claude-sonnet-4.6' }` → full e2e pass. Platform fix belongs in the gateway param translation or default model config                                                                                                                                                              | `/v1/llm-gateway/v1/llm/chat/completions` (via tunnel), `apps/api/src/router/routes/proxy/helpers.ts:252`         |
| 2026-07-11 | `4003a41b`               | `session.transcript()` on a session whose sandbox was re-provisioned returns `{available:false, reason:"…ZlibError fetching …/session/<old opencode id>/message…"}` — graceful, but the compact transcript is unreadable after a sandbox swap (stale opencode session id?). Observed live on the local stack                                                                                                                                                                                                                                                                                          | `packages/sdk/src/core/rest/projects-client/sessions.ts` (`getSessionTranscript`)                                 |
| 2026-07-11 | `4003a41b`               | `sandboxShares.list(sandboxId)` (`GET /p/share?sandbox_id=…`) returns **502** on the local stack for a live, ready sandbox — session `publicShares` create/list/revoke on the same sandbox works fine. SDK surfaces it correctly as typed ApiError; route itself looks broken/misrouted locally                                                                                                                                                                                                                                                                                                       | `packages/sdk/src/core/rest/projects-client/sandbox-shares.ts:33`                                                 |
| 2026-08-10 | `activity-burst`         | **A shell failure is invisible to every host.** `shellViewModel` read `<exit_code>` privately, and nothing exported it — so a host that renders bash rows off `ToolPart` (as `apps/web` does) could not tell a build that exited 1 from one that exited 0. `partOutcome`-style heuristics cannot recover it: a failing test run prints to stdout exactly like a passing one, and the `Error:`-prefix check bails above 500 chars. Fixed additively this session (`shellExitCode`, exported, snapshot re-recorded — 4 added lines, no removals). **Not fixed:** `apps/web` strips the same tags with its OWN regex in `partOutput` (`infrastructure.tsx:514-515`), a second copy of `stripInternalTagTail`'s job that will drift. | `packages/sdk/src/core/turns/view-model.ts:179-198`, `apps/web/src/features/session/tool/shared/infrastructure.tsx:514` |
| 2026-08-10 | `activity-burst`         | **Two `apps/web` ShowTool tests are order-dependent and fail in isolation at clean HEAD** — `content-only inline show exposes/omits Preview…` assert on a `viewBox="0 0 38 64"` occurrence count that comes back `undefined` when the file runs alone. Not an SDK issue and not caused by this session; adding any new test file to `src/features/session/tool/tools/` reshuffles execution order and surfaces it. Consistent with the known global mock-registry leak in `apps/web`. | `apps/web/src/features/session/tool/tools/show-tool.test.tsx:110,126` |
| 2026-07-21 | `profile-owned-bindings` | The existing computer-connector integration's unknown-slug assertion depends on its arbitrary local project's Git manifest being readable. When GitHub returns 422, `getConnectorPoliciesFromManifest` returns `{ policies: [] }` before proving the slug exists, so the test reports **7 pass / 1 fail** instead of the earlier **8 / 0**. This branch does not touch that path.                                                                                                                                                                                                                     | `apps/api/src/connectors/manifest-crud.ts:393`, `apps/api/src/__tests__/integration-computer-connector.test.ts:157` |

---

## Open decisions

| Question                                    | Owner | Status                                                                                                                                                              |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Second `KortixProject` name                 | Jay   | **RESOLVED** — platform keeps `KortixProject`; the kortix-master daemon's becomes `KortixMasterProject`, aliased                                                    |
| Rename `ApiError` → `KortixApiError`?       | Jay   | **RESOLVED — no.** Package name already namespaces the import; `.name` is duck-typed (B4); `instanceof` is the branch mechanism. Prefix only for genuine ambiguity. |
| "Shift the cortex tab to SDK" — what is it? | Jay   | **OPEN.** May re-order everything if it names work Marko is waiting on.                                                                                             |

---

## Standing facts (verified — don't re-derive)

- Baseline: **1046 tests pass, 0 fail, 65 files.** `typecheck` exits 0. Fewer tests
  in your run means you filtered by accident.
- `@kortix/sdk` is **live on npm**, `latest` = `0.9.100`. **Never edit `version`** —
  `scripts/stage-npm-publish.mjs:32` overwrites it from the root `VERSION`.
- `bun test <dir with no test files>` exits **0**. `Ran 0 tests` is not a green run.
- Streaming is `fetch` + `response.body.pipeThrough(TextDecoderStream)`, **not**
  `EventSource`. It **cannot run on React Native**.
- The 21 legacy subpaths are imported at **340 sites**. They get deprecated aliases, never deletion.co

---

## Session log

Append only. Newest at the bottom. One entry per session, even a short one.

### 2026-07-10 — session `01AzJBSa`

Brainstormed → spec → plan → execution prompt → this tracker. **No source code touched.**

**Written**

- `docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md`
- `docs/superpowers/plans/2026-07-10-sdk-v2-structure-and-distribution.md`
- `docs/superpowers/plans/2026-07-10-sdk-v2-execution-prompt.md`
- `packages/sdk/AGENTS.md` (+ `CLAUDE.md` symlink), root `AGENTS.md` pointer
- `packages/sdk/PROGRESS.md` (this file)

**Found** — see _Discovered this session_. The load-bearing ones: `0.3.0` was
impossible; `KortixProject` was declared twice; nothing tests an install; the
tripwire can't see globals; the SDK can't stream on RN and `apps/mobile` quietly
works around it with 655 parallel lines.

**Verified**

```
pnpm --filter @kortix/sdk typecheck  → exit 0
pnpm --filter @kortix/sdk test       → 1046 pass, 0 fail, 4381 assertions, 65 files
npm view @kortix/sdk version         → 0.9.100
```

**Unverified:** nothing — no source changed.

**Shippable to production: YES** (docs only).
**Next:** Task 1.

### 2026-07-10 — session `ab099b6a`

Executing the v2 chain via subagent-driven development. Docs committed
(`6cd4d6e4e`); baseline re-verified (typecheck exit 0; 1046 pass / 0 fail / 65
files).

**Task 1 DONE** (`ecb78a113`) — `src/package-exports.test.ts`, probe-verified
RED then green. Suite now **1048 pass / 66 files**. Review clean, one
plan-mandated finding for Jay: the plan's test code contains a tautological
assertion (`package-exports.test.ts:30`) that asserts nothing.

**Task 2 BLOCKED at the kickoff's hard stop #1** — the smoke script's
first-ever run failed in Step 2:

```
npm error notarget No matching version found for @kortix/llm-catalog@0.0.0-smoke
```

Root cause: `stage-npm-publish.mjs` rewrites `workspace:*` deps to the lockstep
version. Under `VERSION=0.0.0-smoke` the tarball depends on
`@kortix/llm-catalog@0.0.0-smoke`, which is not on npm, so `npm install
<tarball>` cannot resolve. This is the plan's known risk #2 realised — a design
gap in the smoke script (AGENTS.md documents the pinning behaviour), not a bug
in the published artifact. Real releases co-publish both packages, so prod
installs are unaffected. Also found: the script leaks the packed `.tgz` on
failure (cleanup sits outside `finally`). Fix decision is Jay's; the verbatim
script sits uncommitted at `packages/sdk/scripts/smoke-install.mjs`.

**Also found** — docs prose says 25 subpaths / 21 legacy; reality is 23 export
keys / 20 legacy. The plan's enumerated key lists (Task 5 Step 9) match reality
exactly, so the plan's literal instructions are unaffected.

**Task 2 resumed and BLOCKED a second time.** Jay approved packing the
workspace sibling (`@kortix/llm-catalog` staged at the same synthetic version,
both tarballs installed together — hermetic, mirrors the lockstep release);
that fix works and the ETARGET failure is gone. The smoke then failed at the
final ESM import with a NEW finding:

```
SyntaxError: The requested module '@kortix/sdk/server' does not provide an
export named 'createServerKortix'
```

`createServerKortix` exists nowhere in the SDK — it is a plan/spec authoring
error (plan `:253,991`; spec `:158`). The real `./server` exports are
`createScopedKortix` (`src/server.ts:123`), `runWithKortix`, `getScopedConfig`.
Task 6's Lumen snippet uses the same phantom name. Decision with Jay: assert
the real name and correct the docs, or add `createServerKortix` as new API.
Tautology in `package-exports.test.ts` removed per Jay (`4e39bb11e`).

**Continuation of session `ab099b6a` — the full chain.** Jay resolved both
Task 2 stops (pack the `@kortix/llm-catalog` sibling into the smoke install;
assert the real `createScopedKortix`, docs corrected in `2a7a3e56c`). From
there the chain ran task-by-task with a fresh implementer + independent
reviewer per task, fixes re-reviewed:

- **Task 2 DONE** `7220e9587` — first-ever pack→install→import, hermetic
  (both tarballs), wired into CI.
- **Task 3 DONE** `84e15ca72` — snapshot (23 subpaths / 833 runtime names)
  approved by Jay at hard stop #2. Suite 1049/67.
- **Task 4 DONE** `25068d272..4c6f7102c` (4 commits) — 146 files moved into
  core/browser/node + turns split; snapshot byte-identical; tier tripwire
  armed. Fixed a real pre-existing order-dependent `mock.module` isolation
  bug by rewriting `core/files/client.test.ts` mocking (zero `expect()` lines
  changed — verified twice). Suite 1050/67.
- **Task 5 DONE** `b5e588dbc`+`aafbdf91b` (orchestrator-implemented) —
  `KortixMasterProject` rename with aliases; canonical root barrel (26→518
  root names); 20 deprecated shims + 5 ./internal/*; both maps rewritten to
  28 keys; snapshot growth (+523/-0) accepted by Jay at hard stop #3. Suite
  1058/68; hosts compile untouched.
- **Task 6 DONE** `db30c6df3`+`19e500e50` — demo on root entry;
  `createScopedKortix` replaces raw transport (real names: `tokens.create`,
  `gateway.sessions`); fix restored the malformed-200 guard as a true 502
  with a RED-watched e2e (44/3/0 on a fresh build).
- **Task 7 DONE** `189428df7`+`a485ad401` — bare-globals tripwire (guard
  window per-global, comment-safe after probe-RED fix); `safeEnv` →
  `core/http/env.ts`; `shared.ts:29` fixed. Suite 1059/68.
- **Task 8 DONE** `c7bca7a7e` — tsup bundles (`kortix.esm.min.js`,
  `kortix.global.js` IIFE via `outExtension` — tsup would otherwise emit
  `.global.global.js`); zero `node:` specifiers in either bundle. Built
  suite 1061/69.
- **Task 9 steps 1–5 DONE** `549d597a0` — `07-vanilla.ts` (render loop
  corrected to the real API per examples/04), `08-cdn.html`, examples
  tripwire (+B6: the regex is blind to side-effect imports). Suite 1062/69
  built. **Step 6 (browser + live stack, D2a/D3) awaits Jay — hard stop #4.**
- **Task 10 DONE** `6e9cc9f5a` — README/CHANGELOG/API-MAP; count corrected
  to 20; `createScopedKortix` documented; RN-streaming not claimed.

**Final whole-branch review: "With fixes."** Purely-additive surface
re-verified independently. One CRITICAL: the README/CHANGELOG CDN claim is
unfulfillable by the release pipeline (see Discovered table) — wire it or
walk it back before merge. Important: bundle tests never run in CI;
no CI job runs the SDK typecheck. Minors triaged as follow-ups.

**Verified this session (final state):** typecheck exit 0; unbuilt suite
1060 pass / 2 skip / 69 files; built suite 1062 pass / 0 fail / 69 files;
`smoke:install` ✔; whitelabel-demo typecheck 0 + e2e 44/3/0; apps/web zero
SDK resolution errors.

**Unverified:** D2a/D3 (browser streaming + `instanceof` under the IIFE) —
Task 9 Step 6, needs Jay's live stack; the release pipeline path for the
bundles (the CRITICAL above); CI runs of the new workflow steps on Actions.

**Shippable to production: NOT YET** — pending Jay: CDN-claim decision,
README domain decision (`api.kortix.ai` vs `.com`), CI-gate fixes, and the
Task 9 Step 6 browser gate.

**Fix wave (same session, after Jay's decisions).** Jay chose: wire the CDN
pipeline, `api.kortix.com`, both CI gates now.

- `33f45e6f8` — `stage-npm-publish.mjs` promotes `browser`/`unpkg`/`jsdelivr`
  if present and hard-fails (`process.exit(1)`) when a promoted path is
  missing from the build (TDD in `stage-npm-publish.test.mjs`, RED watched,
  24/24). The load-bearing build fix went into `publish-npm-package.sh`
  (staging runs BEFORE `npm publish`, so `prepublishOnly` alone fires too
  late); `prepublishOnly && tsup` kept as defense-in-depth; the two other
  staging call sites (`smoke-install.mjs`, CI dry-pack loop) also build
  bundles — required, or the new validation would redline them. Tarball
  simulation: both bundles in the tarball, top-level CDN fields staged,
  manifests restored byte-identical. Sibling packages
  provably unaffected (promote-if-present; pinned by test).
- `695908713` — README standardized on `api.kortix.com` (Jay's call).
- `e48a48489` — `package-tests.yml`: SDK typecheck step + `build:bundles`
  before the test run, so `bundle.test.ts` executes in CI (1062/0/69).

**Final re-review: "Ready to merge — Yes."** All findings closed by the named
mechanisms; the two call-site fixes judged required, not scope creep. Minor
follow-ups noted: triple bundle build in one CI job (~1 min redundant,
idempotent); redundant rebuild via prepublishOnly inside the scripted release.

**Remaining before the branch is DONE-done: Task 9 Step 6 only** (Jay: real
browser + live stack + real PAT/sandbox → D2a streaming through the IIFE
global, D3 `instanceof Kortix.ApiError` under the bundle).

**Shippable to production: NOT YET** — solely on the unverified D2a/D3
browser gate. Everything else is implemented, reviewed, and green.

### 2026-07-11 — session `b35eea56`

Jay-directed addition, outside the Now chain: `examples/step5-change-model.ts`
— change a project's default model with a compile-time-safe `ManagedModelId`
literal union (pinned in-file, startup-verified against `MANAGED_MODELS` from
`@kortix/llm-catalog` — first example to import the catalog; resolves fine
under `examples/tsconfig.json`). Defaults to Jay's project
`4cfe8027-5260-44d7-871b-ccd36368f63f`. Verified: typecheck exit 0 (bad model
id probe-confirmed RED → TS2345, then restored green); full flow ran live
against localhost:8008 (set → re-read ✓), then the project's prior default
(`openai/gpt-5.5`) was restored. Suite 1062 pass / 0 fail / 69 files. Note:
bun auto-loads `packages/sdk/.env.local` (holds `KORTIX_API_KEY`) — that is
how examples authenticate when run from the package dir.

---

### 2026-07-12 — Production-readiness review (Jay-requested, pre-merge): Task 9 Step 6 EXECUTED (PASS) + fix wave F1–F7

Fresh end-to-end review of the whole branch (41 commits vs `main`, base
`808fadfc8`): two-axis sub-agent review (standards + spec) over the full diff,
17-point distribution/CI fact-check (17/17 VERIFIED), all gates re-run, and the
**Task 9 Step 6 browser gate finally executed against a live stack**. Full report:
`docs/superpowers/reviews/2026-07-12-sdk-production-readiness.md`.

**D2a — PASS.** `examples/08-cdn.html` served from `:8099`, loaded in real
Chromium (Playwright) via `<script src=…kortix.global.js>` against `pnpm dev` +
fresh session `4f2953bc…` (project t1, real PAT, real sandbox). Page output:
`sent — streaming…` then `· message.part.updated` ×7 through `· session.idle`.
**D3 — PASS.** A bundle-thrown `ApiError` (`kortix.ts:681`) satisfied
`error instanceof Kortix.ApiError` in page script (branch printed
`ApiError undefined: Session runtime not ready`); a bad-PAT run threw
`SessionStartError` and correctly took the non-ApiError branch (extends `Error`
by design). **Discovery:** first attempt was CORS-blocked — the API allowlist
(`apps/api/src/index.ts:151-202`) has no `:8099`; local repro needs
`CORS_ALLOWED_ORIGINS=http://localhost:8099`. The CDN story only works from
allowlisted origins → product decision for Jay (in the report), docs now say so.

**Fix wave (UNCOMMITTED in working tree, reviewed "Approved" / spec ✅ ×7):**
F1 smoke-install finally-block made throw-safe (AggregateError, restore-first);
F2 stale JSDoc path fixed; F3+F7 side-effect-import blindness fixed everywhere
(shared `importSpecifiers`, RED-proven) — **closes B6**; F4 AGENTS.md stale
claims fixed (export-map + install-smoke guards now exist; baseline 1069/71);
F5 **new `public-type-surface.test.ts` + snapshot** (TS compiler API) — type-only
exports (`SessionHandle`, `ClassifiedPart`, …) are now rename-guarded, closing
the runtime snapshot's type blindness; F6 CORS constraint documented
(README + 08-cdn.html). Details + RED evidence: `.superpowers/sdd/fix-wave-2-report.md`.

**Verified:** typecheck exit 0 · full suite **1069 pass / 0 fail / 71 files**
(reproduced independently by implementer AND reviewer) · smoke:install OK ·
build:bundles OK (esm 189.90 KB, iife 190.88 KB).
**Unverified:** npm Trusted Publishing wiring for the `@kortix` org
(publish-npm-package.sh skips silently without OIDC/token — one-time infra
check, outside the repo); Safari/Workers legs of the runtime matrix.

**Shippable to production: YES** — supersedes the 2026-07-11 "NOT YET"
(its sole blocker, D2a/D3, is now observed passing). Remaining for Jay:
commit/merge decision (fix wave is uncommitted by request), CDN CORS policy,
Trusted Publishing check.

---

### 2026-07-12 — session `gateway-fallbacks`: B7 provider-qualified default lock

The platform gateway default is now `codex/gpt-5.6-sol`, but it remains a
Kortix gateway wire model in the picker: `{ providerID: 'kortix', modelID:
'codex/gpt-5.6-sol' }`. This deliberately does not expose or classify it as a
native OpenCode `codex` provider. Implementation: `ee7d2cc09`.

**TDD/regression evidence:** the focused picker regression is green (14 pass,
0 fail). Final full SDK suite: **1076 pass / 0 fail / 72 files** and **4958
expect() calls**. `pnpm --filter @kortix/sdk typecheck` exited 0, and
`pnpm --filter @kortix/sdk smoke:install` packed, installed, imported, and
constructed the published package successfully.

**Cross-package evidence:** gateway **144 pass / 0 fail**; catalog **25 pass /
0 fail**; focused API resolution/catalog/entitlement suite **45 pass / 0
fail**; standalone gateway server **13 pass / 0 fail**. Typechecks exited 0
for gateway, catalog, SDK, API, and standalone gateway. `git diff --check`
was clean.

**Real local E2E:** through `POST http://localhost:20908/v1/llm-gateway/v1/chat/completions`,
streaming `auto` selected `openai-codex` / `gpt-5.6-sol` and returned the exact
marker `AUTO_DEFAULT_CODEX_56_SOL_OK`; forced Codex 401 selected OpenRouter /
`z-ai/glm-5.2-20260616`, returned `CODEX_STREAM_401_TO_GLM_OK`, completed with
`[DONE]`, and persisted routing metadata selecting `glm-5.2`. Non-streaming
Codex primary and forced-401 fallback also returned exact markers. Temporary
gateway credentials were revoked and the Codex-secret mutation was restored.

**Shippable to production: YES** — SDK public behavior is regression-locked;
the wider gateway change still follows its normal PR, deploy-dev, and live-dev
verification lifecycle.

---

### 2026-07-13 — session `session-base-branches` (claim)

Claimed the user-directed additive branch-environment work: preserve the existing
per-session `base_ref` API, expose effective project/group branch defaults through
the typed project Git surface, and extend group-grant mutations without renaming or
removing public SDK symbols. TDD will be RED-watched before implementation; the
full SDK typecheck, test, and packed-install smoke gates are required before this
claim is closed.

**Status:** COMPLETE.

### 2026-07-25 — session `session-history-pagination` (completion)

Fixed complete-turn history pagination and stable scroll restoration.

The controller now follows assistant-only pages until it loads each referenced
parent user message. It hydrates the collected pages once in chronological
order. Tail reconciliation no longer resets a cursor after older-history
pagination starts. Repeated cursors stop with an explicit error.

The web host now captures the first visible `[data-turn-id]` element before the
request. It restores that element to the same viewport offset after React
commits. It no longer applies total `scrollHeight` growth.

**RED evidence:**

- The complete-turn test expected requests through `cursor-3`. The controller
  stopped after `cursor-1`.
- The cursor-invariant test expected the next request to use `cursor-2`. Tail
  reconciliation reset the cursor to `cursor-1`.
- The scroll tests failed because `session-history-scroll.ts` did not exist.

**Verification:**

- Focused SDK and web tests: **15 pass / 0 fail / 33 assertions**.
- SDK typecheck: exit 0.
- SDK suite: **1210 pass / 2 skip / 0 fail** across 98 files and 5461
  assertions.
- SDK packed-install smoke: pass.
- Focused ESLint: 0 errors. One pre-existing
  `react-hooks/exhaustive-deps` warning remains at `session-chat.tsx:3635`.
- Changed-file web TypeScript output: empty.
- Web suite: **2054 pass / 2 unrelated baseline failures**. Both failures expect
  the retired `deepseek-v4-pro` model in `src/lib/model-pricing.test.ts`.
- Browser discovery returned no available browser. Local DOM and network
  verification remains open.

**Shippable to production: NOT YET.** Repository delivery, Deploy Dev, and
deployed browser verification remain open.

---

### 2026-07-23 — session `session-sync-latency` (local completion)

Completed bounded session synchronization and persistent project navigation in
`session-sync-latency`. Initial and background history reads request 10 messages.
Older history uses cursor pagination. One active session owns the SSE stream.
Inactive running sessions receive one bounded tail prefetch. The 20-entry
controller registry owns and evicts prefetch state.

The shared project layout now owns `ProjectShell`. Session navigation keeps the
committed route visible until the target renders. The current session remains
selected during a pending switch. File selections, Customize state, onboarding,
and the presentation dialog persist across project routes. Session file stores
are bounded to 20 entries.

Connector reads no longer synchronize or write. The list path loads actions,
credential state, and channel state in parallel. Shared credential discovery is
one batched query. Explicit synchronization materializes connector icons.

The final maintainability review deleted the background SSE fan-out, removed
passive project-home reads, moved prefetch state into the bounded registry, and
removed a second mobile transcript compatibility cast. `formatTranscript`
accepts a narrow structural input while the exported `MessageWithParts` contract
remains unchanged. No changed file crosses from below 1,000 lines to above 1,000
lines.

**TDD evidence:** the new mobile transcript-shape test first failed SDK
typecheck with `TS2322`. The focused GREEN run reported **9 pass / 0 fail** with
16 assertions. The mobile older-page hydration test first returned only the
older page. Its GREEN run reported **1 pass / 0 fail**.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0. The full
suite reported **1171 pass / 0 fail** with 5170 assertions across 88 files.
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed the package successfully.

**Other local gates:** API typecheck exited 0. Focused API tests reported **38
pass / 0 fail**. Focused web tests reported **22 pass / 0 fail**. The focused
mobile test reported **1 pass / 0 fail**. Changed-file web ESLint reported 0
errors and one pre-existing hook warning. Terraform formatting and validation
passed. Mobile typecheck still reports 56 baseline errors; none reference the
changed mobile files.

**Runtime evidence:** the authenticated connector list returned `200` twice in
10 ms and 5 ms. Legacy and default-profile credentials both returned
`secretSet: true`. Connector, action, and credential row counts did not change.
The real cloud session smoke reported **21 pass / 0 fail**. Project provisioning
took 4 seconds. The sandbox reached `ready` 18 seconds after session creation.
OpenCode and `kortix.yaml` returned `200`. Cleanup returned `200`.

**Infrastructure evidence:** `dev-api.kortix.com` returns
`x-backend: ecs-fargate`. ECS runs three tasks at its current three-task ceiling.
The 24-hour target-response maximum was 47.132 seconds. The API logged 1,904
target `5xx` responses. Stale background `/global/event` requests retried missing
sandboxes four times and consumed about 7 seconds each. This branch deletes that
fan-out and raises the ECS fallback maximum from 3 to 6.

**Unverified:** the browser runtime returned an empty browser list. Required DOM
and network assertions for persistent navigation, cached rendering, bounded
prefetch, cursor pagination, transcript export, and dialog persistence could not
run. The shared local migration ledger also has one pending concurrent migration
that precedes an applied migration. The shared ledger was not mutated.

**Shippable to production: NOT YET.** Browser DOM and network verification
remains required.

---

### 2026-07-19 — session `git-management-ux` (completion)

Completed the additive GitHub repository-template input. The public
`CreateProjectRepoInput` contract now accepts `source_item_id`, allowing the web
project creator to seed a selected `registry:project` item into a newly created
GitHub App repository. No exported name or existing field was removed or
renamed.

**TDD evidence:** the focused project-client test failed before
`source_item_id` existed on `CreateProjectRepoInput`; after implementation the
focused project-client suite passed, including the new marketplace-template
contract assertion.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1141 pass / 0 fail** across 86 files with 5054 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository merge, Deploy
Dev, and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-18 — session `connectors-discover-flag` (completion)

Completed the additive Discover integration-catalog SDK restoration as a separate,
per-project experimental connector marketplace. Existing Easy Connect remains intact
and default; `connectors_api_discover` is available but off by default. Pipedream
appears only as separately labelled OAuth alternatives. Runtime and type snapshots
contain additions only; no current export was removed or renamed.

**TDD and live evidence:** the focused contract/UI run passed **46 / 0** and the
focused API/catalog/router run passed **56 / 0**. An authenticated local project
round-tripped the flag false -> true -> false, queried live HubSpot catalogue and
surface endpoints, and resolved MCP, CLI, REST, and official Postman variants with
source-derived bearer auth. The official HubSpot Postman repository materialized as
an active connector with **1,223 actions**, `authSecret: credential`, and no stored
credential; live Pipedream HubSpot search returned OAuth records only. ke2e coverage
passed at **409 / 497 routes**.

**Final SDK gates after rebasing onto current `origin/main`:** typecheck exited 0;
the full SDK suite reported **1128 pass / 0 fail** across 84 files with 5029
assertions; and the packed install smoke built, packed, installed, imported, and
constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository PR, Deploy Dev,
and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-13 — session `session-base-branches` (completion)

Completed the additive session branch-environment surface in implementation
commit `0843d870c`: `ProjectBranchesResponse` now reports the caller's effective
session default and group-conflict metadata, while project group grants accept
an optional nullable `default_base_ref`. Existing names and required fields are
unchanged; compatibility with older servers is preserved through optional
response fields.

**TDD/regression evidence:** the focused cross-package run passed **103 tests / 0
failures** across the SDK access client, API branch resolver, DB schema, and web
session-create input. The real isolated API then proved: attached group default
`staging` -> persisted session `base_ref: staging`; explicit `dev` -> persisted
`base_ref: dev`; conflicting `dev`/`staging` group defaults -> project `dev` with
`session_default_conflict: true`; PATCH `default_base_ref: null` -> effective
default returned to `staging`. Both sessions retained their generated UUID as
`branch_name`.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1077 pass / 2 skip / 0 fail** across
72 files with 4955 assertions; `pnpm --filter @kortix/sdk run smoke:install`
packed, installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. The two skipped tests are
the existing browser-bundle tests that only execute after `build:bundles`; this
change does not touch bundles or runtime transport.

---

### 2026-07-13 — session `remove-freestyle`: B8 project-app surface removal

Completed the explicitly subtractive SDK portion in implementation commit
`ec8b44dda`: removed the project-app REST module, `project(id).apps` facade,
associated public types, playground example, API map/docs references, and the
corresponding runtime/type public-surface snapshot entries. No compatibility
alias remains because the underlying platform capability itself was removed.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1079 pass / 0 fail** across 72 files
with 4921 assertions; `pnpm --filter @kortix/sdk run smoke:install` built,
packed, installed, imported, and constructed the published package successfully.

**Shippable to production: YES** for the SDK subtraction. Repository delivery,
deployment, and the separate forward database-schema removal remain tracked by
the parent removal goal.

---

### 2026-07-13 — session `remove-app-deploy-residue`: B8 documentation follow-up

Removed stale affirmative references to the retired project-app deployment
surface from the SDK README and API map as part of the repository-wide starter
and documentation cleanup. No SDK source, export, type, or runtime behavior
changed; the B8 removal record remains as the audit trail.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1079 pass / 0 fail** across 72 files
with 4921 assertions after bundle generation; `pnpm --filter @kortix/sdk run
smoke:install` built, packed, installed, imported, and constructed the published
package successfully.

**Shippable to production: YES** — documentation-only SDK follow-up with the
full published-package gates green.

---

### 2026-07-13 — session `gateway-routing-ui` (claim)

Claimed the user-directed additive project LLM routing-policy surface: persisted
default and vision models, an ordered default fallback chain, exact-model
overrides, bounded `transient` / `any-error` conditions, and a route-preview
contract exposed through `@kortix/sdk` for the Customize UI. Existing model
default names and behavior remain unchanged. SDK work will follow RED → GREEN →
REFACTOR and finish on the full typecheck, test, and packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-28 — session `acp-session-name-sync` (B32 implementation)

ACP `session_info_update` and OpenCode REST `session.updated` events now persist
the generated root-session title in `project_sessions.metadata.name`.

The REST parser handles the real `/global/event` envelope:
`{ directory, payload: { type, properties } }`.

`useSession` refetches the active Kortix session list and detail queries after
runtime title events. It also runs a bounded refresh after each send.

Verification:

- Focused API: **78 pass / 0 fail / 178 assertions**.
- API typecheck: exit `0`.
- SDK typecheck: exit `0`.
- Full SDK: **1318 pass / 0 fail / 5797 assertions / 111 files**.
- SDK packed-install smoke: passed.
- Test-harness typecheck: exit `0`.
- Local ACP and REST Chromium: **1 pass / 0 fail**.
- Full API: **3 pre-existing failures**. The same failures reproduce in the
  primary checkout in `maintenance.test.ts` and
  `unit-hosted-deployment-vendor-removal.test.ts`.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed ACP plus REST UI verification remain.

---

### 2026-07-26 — session `warm-project-session` (B22 completion)

Added one server-owned available warm session per project and user. A partial
unique PostgreSQL index resolves concurrent ensure races. The SDK exposes
`ensureWarmProjectSession`, `claimWarmProjectSession`,
`project.sessions.ensureWarm()`, and `project.sessions.claimWarm()`.

The project index ensures the warm session on mount and starts its runtime.
Send claims that session atomically before navigation. A claimed, stopped, or
configuration-mismatched session cannot become the next warm session.

Reused active workspaces resolve the latest base SHA on the API. The sandbox
daemon returns immediately when the workspace already matches that SHA. It
fetches and checks out the exact SHA only when the workspace differs. OpenCode
does not restart. No agent message performs Git synchronization.

Available warm sessions bypass idle maintenance. Claimed sessions return to the
normal idle policy.

TDD evidence:

- Workspace refresh RED: the API did not resolve or send `base_sha`.
- Daemon RED: an unchanged workspace performed a Git fetch and returned `500`
  against a missing remote.
- Exact-SHA RED: the daemon checked out remote `v3` instead of requested `v2`.
- Stopped-session RED: the coordinator reused a stopped warm session.
- Maintenance RED: an available warm session entered idle-stop handling.

SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit 0.
- `pnpm --filter @kortix/sdk test`: **1263 pass / 0 fail**, **5644**
  assertions.
- `pnpm --filter @kortix/sdk run smoke:install`: packed install and Node ESM
  import passed.

Additional local gates:

- Database: **121 pass / 0 fail**.
- API contract: **43 pass / 0 fail**.
- Warm coordinator and workspace tests: **9 pass / 0 fail**.
- Sandbox reaper: **43 pass / 0 fail**.
- Sandbox daemon: **297 pass / 0 fail**.
- Web helper: **3 pass / 0 fail**.
- API typecheck, daemon build, migration lint, changed web ESLint, and
  `git diff --check`: exit 0.
- ke2e coverage: **490/503 routes**, **13 allowlisted**, **0 uncovered**.

Real local proof used disposable project
`4f9f6c04-9101-424b-aaaa-2e850b18ef12`:

- Concurrent ensure calls returned one session. The database contained one
  available warm row.
- Reused workspace refresh changed
  `f309cbda70b97a124585ba0e6d12a0b6b2c8be9f` to
  `92b337bb3641598de4dec4e251f6087ba3609a18` in **2579 ms**.
- The next refresh returned `unchanged` in **801 ms**.
- A real maintenance pass returned `candidates=1`, `stopped=0`, and
  `skipped=1` for an available warm session.
- Session `5c83a894-d330-45c7-bc7e-a77c0c175881` reached runtime readiness.
- Claim completed in **14 ms**.
- Replacement session `444ca1db-97b9-4f16-bf0b-1eb96b2330a9` was different.
- The replacement reached runtime readiness in **22481 ms**.

The browser runtime returned `agent.browsers.list() = []`. Local DOM and network
assertions remain unavailable. Web typecheck reports only three unrelated
baseline errors in `template-url.test.ts` and `project-create-modal.tsx`.

The full API suite retains an existing `mock.module` isolation defect when
`sandbox-reaper.test.ts` shares a process with sibling files. Each changed API
test file passes in an isolated process. API typecheck passes.

**Shippable to production: YES.** The SDK surface is additive. The package,
database, API, daemon, web helper, live lifecycle, and maintenance retention
contracts pass. Browser verification remains a deployment item.

---

### 2026-07-25 — session `false-load-older` (local completion)

OpenCode paginates raw messages in groups of 10. The reported dev session has
one user message and 43 assistant messages in one logical turn. The initial page
contained 10 assistant messages and an `x-next-cursor` header. The user message
was on page 5.

The controller now follows assistant-only pages during the initial load until
every assistant parent user message is present. It hydrates the complete newest
turn once in chronological order. It exposes `hasOlder` only when the completed
turn has an earlier cursor.

Implementation commit: `b759cca6bad8548b54ec3ab80d105f162a1f497d`.

**RED evidence:**

- The focused controller suite reported **13 pass / 1 fail**.
- The new test expected three page requests. The controller made one request.

**Verification:**

- Focused controller suite: **14 pass / 0 fail** with 32 assertions.
- SDK typecheck and example typecheck: exit 0.
- SDK full suite: **1249 pass / 2 skip / 0 fail** across 104 files with 5589
  assertions.
- SDK packed-install smoke: pass.
- Exact dev-session probe: 5 HTTP `200` page requests, 44 hydrated messages,
  1 user message, 43 assistant messages, and `hasOlder: false`.
- `git diff --check`: exit 0.

The browser runtime returned `No browser is available` and `[]`. Local and
deployed DOM proof remains open.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, and deployed proof
remain.

### 2026-07-13 — session `gateway-routing-ui` (completion)

Completed the additive project LLM routing-policy SDK surface: typed whole-document
CRUD and route preview functions, `project(id).gateway.routing.{get,set,reset,preview}`,
and `useGatewayRoutingPolicy` with project-scoped caching/invalidation. Runtime and
type public-surface snapshots contain additions only; no existing SDK name or contract
was removed or renamed.

**Focused evidence:** routing transport/facade/hook tests passed **65 / 0** together
with the existing facade suite. The isolated black-box `GW-4` flow passed **1 / 0**
against the real API and a provisioned project, covering persisted save/read-back,
default and exact route preview, invalid-policy preservation, access boundaries, and
reset.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1083 pass / 0 fail** across 74 files with
4936 assertions; `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository merge, Deploy Dev,
and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-13 — session `e2b-provider`: B9 unified E2B provider contract

Completed the provider contract in `5763b63e4`: E2B is selectable and observable
through the published SDK alongside Daytona and Platinum. Retired standalone
instance exports remain import-compatible as deprecated fail-closed stubs, while
the supported sandbox-provider union is exactly `daytona | platinum | e2b`.

**TDD/regression evidence:** focused E2B and retired-provider type/runtime tests
passed before the final suite. Final SDK gates: `pnpm --filter @kortix/sdk
typecheck` exited 0; `pnpm --filter @kortix/sdk test` reported **1083 pass / 0
fail** across 74 files with 4985 assertions; `pnpm --filter @kortix/sdk run
smoke:install` packed, installed, imported, and constructed `@kortix/sdk`
successfully.

**Shippable to production: YES** for the SDK surface.

---

### 2026-07-13 — session `personal-session-branch` (claim)

Claimed the user-directed personal session-branch preference work. This adds an
additive SDK/API contract for a project-scoped current-user default and makes
session base-ref resolution honor it before group and project defaults. No
existing public names or required fields will be changed. SDK work will follow
RED -> GREEN -> REFACTOR and finish with typecheck, full suite, and packed-install
smoke evidence.

**Status:** IN PROGRESS.

---

### 2026-07-28 — session `acp-multi-harness` claim

Claimed project-gated ACP multi-harness support.

The existing `acp_runtime` project experiment will become the single rollout
gate for ACP transport and Claude Code, Codex, OpenCode, and Pi harness
selection.

The implementation will port the behavioral contract from PR #4510 onto the
current session-scoped SDK architecture. It will not restore PR #4510's removed
SDK refactor or host-local runtime logic.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are focused API, SDK, daemon, manifest, and web tests, API and
SDK typechecks, the full SDK suite, packed-install smoke, local browser proof,
real multi-harness sandbox proof, PR merge, Deploy Dev, deployed SHA proof, and
deployed browser plus protocol verification.

**Status:** IN PROGRESS.

---

### 2026-07-13 — session `personal-session-branch` (abandoned)

Abandoned the personal/group session-branch preference claim by explicit product
decision. Branch choice belongs to an ordinary isolated Kortix project: users may
connect the same Git repository more than once, choose an existing branch during
project creation, and keep each project's secrets, access, sessions, triggers,
deployments, and runtime settings independent. The advanced per-session `base_ref`
API remains compatible, but no preference hierarchy or environment entity will be
added.

**Status:** WON'T DO (superseded by independent same-repository projects).

---

### 2026-07-13 — session `personal-session-branch` (replacement completion)

Completed the replacement project-as-environment SDK surface. GitHub imports can
now discover existing repository branches through the typed
`kortix.github.listRepositoryBranches(accountId, installationId, repoFullName)`
facade. A Kortix project owns one selected repository branch as its canonical
`default_branch`; no personal/group preference hierarchy remains in the SDK.
Existing per-session `base_ref` support remains backward compatible.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1085 pass / 0 fail** across 77 files
with 4960 assertions; `pnpm --filter @kortix/sdk smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** — the public addition is typed, additive,
snapshot-locked, and verified from the packed package.

---

### 2026-07-13 — session `gateway-routing-ux` (claim)

Claimed the user-directed LLM Gateway routing UX simplification. The SDK scope is
an additive compact project model-picker REST surface so chat and settings model
selectors no longer download the full 5,262-model runtime catalog. The existing
`llm-catalog`, model-default, and routing-policy APIs remain backward compatible.
Implementation will follow RED -> GREEN -> REFACTOR and finish with the full SDK
typecheck, test, and packed-install smoke gates.

**Status:** IN PROGRESS.

### 2026-07-13 — session `gateway-routing-ux` (completion)

Completed the additive compact project model-picker SDK surface. The project
transport and `createKortix().project(id).models.picker()` facade now load the
connection-aware picker projection rather than the full runtime catalog, while
the existing `llm-catalog` API remains available and unchanged. React project
model/provider hooks share the compact project cache, and model visibility now
uses an indexed lookup instead of repeatedly scanning the catalog. Runtime and
type public-surface snapshots contain additions only.

The surrounding product flow now uses the shared model selector for the single
project-default control and every fallback choice. Routing saves and project-
default writes are mutually excluded through a shared mutation key, and an
effective-default refetch cannot replace unsaved fallback edits.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1094 pass / 0 fail** across 79 files
with 4988 assertions; `pnpm --filter @kortix/sdk smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** — the SDK change is additive, snapshot-locked,
install-verified, and backed by the real local compact-picker API flow.

---

### 2026-07-13 — session `sandbox-template-provider-readiness` (claim)

Claimed the additive provider-aware sandbox-template observation contract. The
template API will expose current launch readiness independently for Daytona,
Platinum, and E2B while retaining every existing response field. The web host
will consume that typed SDK contract instead of interpreting the legacy
Daytona-named field as universal provider truth.

**Status:** IN PROGRESS.

---

### 2026-07-13 — session `sandbox-template-provider-readiness` (completion)

Completed the additive provider-aware template contract. Sandbox template
responses now type independent Daytona, Platinum, and E2B launch-readiness
observations, routed provider mode, and exact provider attribution for new build
rows. Reusable template builds fan out to every enabled provider independently
of project routing pins. Existing fields and exported names remain compatible.

**TDD evidence:** the initial typecheck failed because `provider_coverage` was
absent, then passed after the additive contract was implemented. Final SDK gates:
`pnpm --filter @kortix/sdk typecheck` exited 0; `pnpm --filter @kortix/sdk test`
reported **1095 pass / 0 fail** across 80 files with 4990 assertions;
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Parent API/UI rollout and
live provider verification remain part of the enclosing change.

---

### 2026-07-13 — session `sandbox-template-provider-status-v2` (completion)

Completed the follow-up provider-status and failure-recovery contract on top of
the provider-neutral synchronization rollout. The additive rebuild response can
now report providers that failed before their rebuild was started, while the UI
keeps Automatic neutral and shows selected-provider plus current-image status
only for pinned projects. Existing provider readiness and `launch_ready` fields
remain backward compatible.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1094 pass / 2 skip / 0 fail**
across 80 files with 4986 assertions; `pnpm --filter @kortix/sdk run smoke:install` built,
packed, installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. API/web typechecks,
focused provider tests, and UI lint also pass; live dev verification remains the
enclosing rollout gate.

---

### 2026-07-15 — session `self-host-e2e-snapshot-fix`

Accepted the intentionally additive public SDK surface introduced by the generic
self-host GitHub App/PAT and managed-git clients. The runtime snapshot gained 12
entries and the type-level snapshot gained 24 entries across the canonical root
and compatibility subpaths; no exported name was removed or renamed.

**RED evidence:** the focused public-surface guards failed 2 / 2 and reported only
additions for `GitHubApp*`, `ManagedGitStatus`, and their client functions.
**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1092 pass / 2 skip / 0 fail** across
80 files with 4943 assertions; `pnpm --filter @kortix/sdk run smoke:install`
built, packed, installed, imported, and constructed `@kortix/sdk` successfully.
The exact self-host fast E2E also reported **24 pass / 0 fail**.

**Shippable to production: YES** — the public additions are deliberate,
snapshot-locked, install-verified, and the self-host CLI contract is green.

- 2026-07-17 — additive: `PtyMutationOptions` + `ptyMutationOverrides`, `useCreatePty`/`useUpdatePty` accept optional `onError` so hosts can keep pty errors out of global toasts (web terminal UX). Surface snapshot re-recorded (adds only).

---

### 2026-07-17 — session `postman-connectors` (claim)

Claimed the additive Postman connector surface within the user-directed
end-to-end Postman ingestion rollout. The SDK scope is deliberately narrow: add
`postman` to existing connector provider unions and preserve the current
`ConnectorDraftInput` API. No exported name is renamed or removed. Design and
execution plan: `docs/specs/2026-07-17-postman-connectors.md` and
`docs/plans/2026-07-17-postman-connectors.md`.

Implementation will follow RED -> GREEN -> REFACTOR and finish with the full SDK
typecheck, test, and packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-17 — session `postman-connectors` (completion)

Completed the additive Postman connector provider contract. The published SDK
now accepts and reports `postman` anywhere the existing connector surfaces
accept a provider, without renaming or removing an exported symbol.

**TDD evidence:** the focused connector contract initially rejected `postman`,
then passed after the provider union was widened. **Final SDK gates:**
`pnpm --filter @kortix/sdk typecheck` exited 0; `pnpm --filter @kortix/sdk test`
reported **1113 pass / 0 fail** across 82 files with 4995 assertions; and
`pnpm --filter @kortix/sdk smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** — the SDK change is additive, its complete
runtime and type-level public surfaces remain snapshot-locked, and the packed
consumer install path is verified. The enclosing API/CLI/UI Postman rollout
retains its own merge, deploy, and live-dev gates.

**Post-rebase gate addendum:** after rebasing onto `origin/main` at
`bcb2a2afa`, the SDK typecheck remained green; the full suite reported
**1121 pass / 0 fail** across 84 files with 5005 assertions; and the packed
install smoke again passed. **Shippable to production: YES.**

---

### 2026-07-17 — session `discover-marketplace` (claim)

Claimed the additive Discover integration-catalog SDK surface for the user-directed
unified marketplace rollout. The SDK will expose integrations.sh catalog records and
their executable variants, while Pipedream entries remain separate, explicitly
labelled OAuth-only alternatives. Existing connector APIs and exported names remain
backward compatible. Implementation will follow RED -> GREEN -> REFACTOR and finish
with typecheck, full-suite, and packed-install smoke evidence.

**Status:** IN PROGRESS.

---

### 2026-07-17 — session `discover-marketplace` (completion)

Completed the additive Discover catalogue SDK surface. The published client now
exposes typed integrations.sh list/detail calls plus
`project(id).connectors.discover.{list,detail}`. Pipedream remains a separate
existing catalogue surface and its app contract is narrowed to the OAuth-only
records returned by the API. Runtime and type snapshots contain additions only;
no exported name was removed or renamed.

**TDD and live evidence:** the focused API/Postman/SDK/UI run passed **96 tests / 0
failures**. A real authenticated local flow searched HubSpot through the Discover
API, resolved its direct MCP/docs/CLI/Postman variants, verified the official
Postman repository requires bearer auth, and materialized **1,223 actions** with
zero sync errors. The live Pipedream search returned only `authType: oauth`.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1121 pass / 2 skip / 0 fail** across 84 files with 5009
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository merge, Deploy
Dev, and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-17 — session `revert-discover-marketplace` (claim)

Claimed the user-directed rollback of the additive Discover catalogue SDK surface
while preserving the earlier first-class Postman connector provider contract. The
rollback removes only the integrations.sh list/detail APIs and facade bindings that
shipped in PR #4920. Full SDK typecheck, suite, and packed-install smoke gates are
required before completion.

**Status:** IN PROGRESS.

---

### 2026-07-17 — session `revert-discover-marketplace` (completion)

Completed the user-directed rollback of the Discover catalogue SDK surface from
PR #4920. The earlier first-class Postman provider remains accepted by connector
drafts and responses; only the integrations.sh list/detail functions and
`project(id).connectors.discover` facade binding were removed.

**Focused evidence:** connector/Postman tests passed **68 / 0**; the restored
Connectors/Channels source regression passed **6 / 0**; API typecheck exited 0;
and the ke2e coverage gate passed at **405 / 493 routes** with the two Discover
routes absent.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1119 pass / 2 skip / 0 fail** across 84 files with 4999
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for this explicitly requested rollback. The two
skips are the pre-existing browser-bundle tests that require a bundle build.

---

### 2026-07-18 — session `connector-auth-discovery` (claim)

Claimed the user-directed source-agnostic connector authentication discovery
work. Postman, OpenAPI, and every other supported connector source will preserve
usable authentication metadata, normalize it into one additive typed contract,
and prefill connector setup while leaving secret values and interactive consent
to the user. Existing connector draft fields and provider behavior remain
backward compatible. Implementation will follow RED -> GREEN -> REFACTOR and
finish with the full SDK typecheck, test, and packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-18 — session `connector-auth-discovery` (completion)

Completed the additive connector authentication discovery surface. The SDK now
exposes typed candidates and `project(id).connectors.auth.discover(input)`, while
connector creation keeps omitted auth as auto-detect and explicit `none` as a
durable opt-out. No exported name was removed or renamed.

**TDD and live evidence:** the focused API/parser/discovery run passed **101 / 0**.
The real HubSpot Postman-managed repository detected bearer auth across **1,223**
operations; authenticated connector creation synced **1 / 0 errors** and
materialized **1,223 actions** with `authSecret: credential` and `secretSet: false`.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1120 pass / 2 skip / 0 fail** across 84 files with 5005
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository PR, Deploy Dev,
and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-18 — session `gateway-provider-key-verify` (completion)

Self-contained addition (not part of the Now chain — outside its own PR/plan):
`verifyGatewayProvider(projectId, providerId)` client fn +
`GatewayProviderVerifyResult`/`GatewayProviderVerifyStatus` types, backing a new
`POST /projects/:id/gateway/providers/:providerId/verify` endpoint that runs one
cheap live completion through a connected BYOK provider's credential and
classifies it `verified`/`invalid`/`unknown`/`not_connected` (closes the LLM
provider UI's "Connected ≠ proven working" gap). No exported name renamed or
removed — additive only.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1122 pass / 2 skip / 0 fail** across 84 files with 5009
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully. Public-surface
snapshots re-recorded — diff is additive only (`verifyGatewayProvider`,
`GatewayProviderVerifyResult`, `GatewayProviderVerifyStatus`).

**Shippable to production: YES** for the SDK surface. apps/api route + apps/web
UI land in the same PR (#4990); see that PR for backend/frontend evidence.

---

### 2026-07-18 — session `connectors-discover-flag` (claim)

Claimed the user-directed restoration of the additive Discover integration-catalog
SDK surface as a separate, per-project experimental connector marketplace. Existing
Easy Connect remains unchanged; Discover is explicit opt-in and Pipedream entries
remain separate OAuth-only alternatives. The prior additive SDK names are restored
without removing or renaming any current export. Implementation will finish with
focused RED -> GREEN coverage, full SDK typecheck/test/packed-install gates, real
local browser/API proof, and the repository merge/deploy/live-dev lifecycle.

**Status:** IN PROGRESS.

---

### 2026-07-19 — session `code-storage-e2e` (completion)

Completed the additive managed-Git username contract. `ProjectGitToken` now
exposes `git_username` without removing or renaming any public SDK name, so
Code Storage clients use `t:<token>` while the existing GitHub path continues
to use `x-access-token:<token>`.

**TDD evidence:** the focused RED run of
`bun test src/core/rest/projects-client/manifest-git-token.test.ts` failed when
the response's `git_username` was absent; after implementation the same command
reported **3 pass / 0 fail / 10 assertions**.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1138 pass / 2 skip / 0 fail**; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully. Cross-surface verification also
reported API focused **18 pass**, provision fixture **9 pass**, CLI **454 pass / 0
fail**, sandbox agent **208 pass / 0 fail**, and the live isolated Code Storage +
Daytona session smoke **24 pass / 0 fail**.

**Shippable to production: YES** for the SDK surface and local end-to-end path.
Repository merge, Deploy Dev, and live-dev verification remain part of the parent
feature lifecycle.

---

### 2026-07-19 — session `git-management-ux` (claim)

Claimed the additive GitHub project-create template input needed by the
user-directed Git provider default. `CreateProjectRepoInput` will accept the
existing optional `source_item_id` concept so a selected marketplace project
template is seeded into the user's newly created GitHub repository rather than
silently falling back to the generic starter or Kortix-managed storage. No
exported name or existing field will be removed or renamed. Implementation will
follow RED -> GREEN -> REFACTOR and finish with the full SDK typecheck, test,
and packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-21 — session `project-session-inventory` (claim)

Claimed the user-directed privileged project session inventory contract. The
existing visible-session list remains backward compatible; an additive manager-
only inventory mode will expose every durable project session, resolved human or
agent ownership, and explicit viewer access/runtime availability so owners and
admins can investigate private, stopped, unavailable, and soft-deleted sessions
without granting ordinary members broader visibility. Implementation will follow
RED -> GREEN -> REFACTOR and finish with the full SDK typecheck, test, and
packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-21 — session `project-session-inventory` (completion)

Completed the additive manager-only project session inventory contract. The
ordinary list remains unchanged; `project(id).sessions.list({ scope: 'project' })`
now exposes every durable row with resolved human/service-account ownership,
viewer access, runtime state, and soft-delete audit metadata. No exported name
was removed or renamed.

**TDD and live evidence:** focused API/serializer/SDK/facade/web tests passed
**148 / 0**. API and web typechecks exited 0, focused web ESLint exited 0, the
full web suite reported **1837 pass / 0 fail**, and the API route contract suite
reported **59 pass / 0 fail**. A real authenticated local HTTP smoke proved the
manager default list stayed at 2 visible rows while project inventory returned
all 4 durable rows, including a private missing runtime, a stopped agent-owned
runtime, and a soft-deleted row; the ordinary member received 403 for project
inventory and a manager still received 404 when directly reading the private
session.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1145 pass / 0 fail** with 5071 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK and local end-to-end contract.
Repository PR, Deploy Dev, and live-dev verification remain part of the parent
feature lifecycle.

---

### 2026-07-21 — session `profile-owned-bindings` (B11 completion)

Completed the additive member-owned connection and session-binding
surface in implementation commit `3eb18b361`. A member can reconcile a profile
whose owner is derived from the bearer token, connect/finalize its distinct
Pipedream identity, and select it explicitly when starting a private session.
Project defaults remain shared. External, agent, and subject profiles retain the
management-capability path; that capability never exposes or mutates another
member's profile. Runtime resolution fails closed on owner or visibility drift.
No exported SDK name or existing field was removed or renamed.

**TDD and focused evidence:** profile/Postgres integration reported **15 pass / 0
fail**; authenticated HTTP authorization reported **5 pass / 0 fail**; Connector
gateway reported **32 pass / 0 fail**; and the computer connector regression
reported **8 pass / 0 fail**. The public runtime and type snapshots contain
additions only.

**Real local E2E:** two real Supabase users created, listed, mutated, and bound
only their own profiles; two real session starts persisted distinct bindings;
project/public sharing was rejected for the personal-profile session; and two
real Connector calls resolved distinct hidden credentials. The black-box proof
reported **21 pass / 0 fail**. Cleanup then verified zero synthetic projects,
users, tokens, and sandbox rows remained.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1145 pass / 0 fail** across 86 files with 5077 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully. API typecheck exited 0 and `git diff
--check` was clean.

**Post-rebase addendum:** after rebasing onto current `origin/main` at
`962498c4f`, SDK typecheck and packed-install smoke remained green; the full SDK
suite reported **1147 pass / 0 fail** across 86 files with 5080 assertions; API
typecheck exited 0; and the focused profile/authorization/Connector run reported
**52 pass / 0 fail**. The unrelated computer integration finding is recorded in
Discovered this session rather than changed inside B11.

**Shippable to production: YES** for the SDK surface and local end-to-end path.
Repository PR, Deploy Dev, deployed-SHA proof, and live-dev verification remain
the parent feature lifecycle.

---

### 2026-07-21 — session `revert-owner-profile-bindings` (completion)

Reverted the unfinished owner-scoped connector-connection session-start surface
introduced by #5139 so `main` returns to the previously published SDK contract.
This is an exact feature rollback rather than a new SDK behavior; the feature
will continue in a separate draft PR before it is considered shippable.

**Verification:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1145 pass / 0 fail** with 5071 assertions; the packed-install
smoke completed successfully; API typecheck exited 0; and the focused live-env
API regression run reported **41 pass / 0 fail** with 83 assertions.

**Shippable to production: YES** for the rollback. The owner-scoped binding
feature itself is **NOT YET** shippable and remains open as WIP.

---

### 2026-07-21 — session `service-account-profile-hardening` (claim)

Claimed the user-directed restoration of owner-scoped connector-connection bindings
after the security rollback, including the late Strix findings on both #5139 and
#5143. The restored additive SDK contract will remain unchanged; API enforcement
will additionally prove that service-account principals cannot create, list,
mutate, OAuth-connect, bind, or execute human `member` profiles, including
queued session creation and pre-existing forged bindings. Work will follow
RED → GREEN → REFACTOR and finish with the full SDK typecheck, test, and packed-
install smoke gates plus real HTTP/Connector proof.

**Status:** IN PROGRESS.

---

### 2026-07-21 — session `service-account-profile-hardening` (completion)

Completed the security restoration in `de11be3b0` and the post-rebase WhatsApp
principal propagation in `396a63823`. Direct service-account principals can no
longer create, enumerate, mutate, OAuth-connect, bind, or execute `member`
connections, even when a forged row uses the service-account UUID as its
owner. Principal type survives durable queue persistence; older queued commands
infer it from the stored actor. Runtime resolution also rejects pre-existing
service-account sessions bound to forged member profiles. The restored manager
ownership and personal-session privacy checks cover every Strix thread from
#5139 and #5143.

**Focused evidence:** authenticated profile HTTP authorization reported **9 pass
/ 0 fail**; profile binding and Connector resolution reported **18 pass / 0
fail**; Connector gateway, sharing, public share, transcript, share endpoint,
session sandbox, and queue payload suites reported **86 pass / 0 fail**. Email,
Slack selection/dispatch, Teams, Telegram, trigger attribution, and WhatsApp
reported **60 pass / 0 fail**. API typecheck exited 0 and `git diff --check` was
clean. Multi-file Bun invocations reproduced the suite's known global mock
contamination; every affected file passed in its own isolated process.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1147 pass / 0 fail** across 86 files with 5080 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface and locally verified API
hardening. Replacement PR review, Deploy Dev, deployed-SHA proof, and live-dev
HTTP/Connector verification remain part of the repository lifecycle.

---

### 2026-07-22 — session `terminal-connect-recovery` (B12 completion)

Removed the false OpenCode-health dependency from the daemon-owned PTY query.
The React hooks now subscribe to the session runtime URL directly. PTY create
and resize mutations stay pinned to that URL. The web panel replaces every
unbounded loading state with a 15-second server-URL deadline, a visible error,
and an explicit retry action. A WebSocket that never opens now expires after 15
seconds and enters the existing bounded backoff loop.

**TDD evidence:** the focused RED run failed because `isPtyQueryEnabled`,
`deriveTerminalPanelState`, and `shouldExpirePtyConnect` did not exist. The
focused GREEN run reported **14 pass / 0 fail** with 27 assertions.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full
suite reported **1148 pass / 2 skip / 0 fail** across 86 files with 5082
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully. The full web
suite reported **1891 pass / 0 fail** with 5318 assertions. Focused web ESLint
exited 0.

**Runtime evidence:** isolated sandbox-agent and API proxy coverage reported 77
pass after the known Bun module-mock-contaminated file was rerun in isolation at
**6 pass / 0 fail**. Fresh local-stack smokes passed on both Platinum and
Daytona. Each smoke created a real PTY, opened two WebSocket attachments, wrote
and observed a marker, replayed scrollback, listed the running PTY, deleted it,
and cleaned up the session and project.

**Shippable to production: YES** for the SDK and local end-to-end terminal path.
Repository merge, Deploy Dev, deployed-SHA proof, and live-dev verification
remain part of the repository lifecycle.

---

### 2026-07-23 — session `github-repo-selector` (B13 completion)

Completed bounded GitHub repository discovery in `0748271116`. The SDK accepts
optional `search` and `limit` inputs. The API returns one recently updated page
for initial discovery. Repository-name searches use GitHub Search. Both managed
PAT and GitHub App installations use this bounded contract.

The web import flow debounces repository search by 300 ms, preserves selectable
results during background queries, and renders a retryable error state. The New
project modal now presents three explicit repository sources: Kortix managed,
create in GitHub, and import from GitHub. Account Git settings expose account
GitHub App connections without requiring platform-admin access. The synthetic
managed PAT is labelled as a server connection instead of a personal GitHub
account.

**TDD and runtime evidence:** focused SDK/API helper tests reported **9 pass / 0
fail**. The two API route tests reported **2 pass / 0 fail**. Focused web tests
reported **10 pass / 0 fail**. An authenticated local request returned the
managed installation plus an App install URL with status `200`. A bounded
repository search returned status `200` in **443 ms**. Production had returned
`503` after **25.08 seconds** on the unbounded path.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full
suite reported **1149 pass / 2 skip / 0 fail** across 86 files with 5083
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully. API typecheck
exited 0. Focused web ESLint reported 0 errors. The full web typecheck remains
blocked by two unrelated `origin/main` errors in `template-url.test.ts`.

**Shippable to production: YES** for the SDK surface. Repository merge, Deploy
Dev, deployed-SHA proof, and live-dev verification remain part of the parent
feature lifecycle.

---

### 2026-07-23 — session `github-repo-selector` (GitHub installation linking claim)

Claimed the additive GitHub installation-save request field for secure
cross-account linking. The SDK sends an optional GitHub user token to the API.
The API verifies that the GitHub user owns the personal installation or
administers the organization installation. Existing callers remain compatible
at the type level.

**Status:** IN PROGRESS. Final SDK gates and repository delivery remain pending.

---

### 2026-07-23 — session `github-repo-selector` (GitHub installation linking completion)

Completed secure existing-installation linking. The additive SDK request field
passes the GitHub user token to the API. The API verifies personal ownership or
active organization-admin membership before it writes the account installation.
The signed install state also preserves the initiating frontend origin. A shared
GitHub App callback can therefore return to the Kortix host that started the
flow.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full
suite reported **1152 pass / 0 fail** across 86 files with 5090 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. API typecheck, focused API
authorization tests, focused web tests, and focused web lint also pass.
Repository merge, Deploy Dev, and live-dev verification remain pending.

---

### 2026-07-23 — session `github-existing-installation-link` (claim)

Claimed the additive existing-GitHub-App installation discovery contract. The
SDK will request installations that the authorized GitHub user can link to one
Kortix account. The API will verify personal ownership or active organization
admin access before it returns or saves an installation. Existing install and
save contracts remain backward compatible.

**Status:** IN PROGRESS.

---

### 2026-07-23 — session `github-existing-installation-link` (completion)

Completed the additive existing-installation discovery and link surface. The SDK
exposes typed list and link functions. The API lists this GitHub App's
installations with the App JWT, then filters them against the authorized GitHub
user and active organization-admin memberships. The link route re-fetches the
selected installation with the App JWT and repeats the GitHub authorization check
before the database write. No exported name was removed or renamed.

**TDD and focused evidence:** the GitHub SDK client reported **5 pass / 0 fail**;
the GitHub App API suite reported **9 pass / 0 fail** with 30 assertions; and the
web GitHub setup and connection regressions passed inside the full web suite.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full
suite reported **1158 pass / 0 fail** across 86 files with 5110 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Cross-surface evidence:** API typecheck exited 0; the full web suite reported
**1952 pass / 0 fail** across 212 files with 5455 assertions; focused web ESLint
exited 0; and `git diff --check` exited 0. The full web typecheck reports only the
two existing `origin/main` errors in `template-url.test.ts`.

**Real local proof:** authenticated `POST
/v1/projects/github/installations/linkable` returned 200 for GitHub login
`markokraemer` and three verified installations. Authenticated `POST
/v1/projects/github/installations/link` returned 200 for personal installation
`148404669`. The account installation read-back returned the same owner and
installation. Chromium rendered the same-origin `Link a GitHub account` page and
opened GitHub OAuth in a popup with `read:user read:org`. The local OAuth callback
cannot complete because the local Supabase container has the literal placeholder
GitHub client ID; deployed-dev OAuth remains the repository delivery gate.

**Shippable to production: YES** for the SDK and locally verified API contract.
Repository PR, Deploy Dev, deployed-SHA proof, and full live-dev OAuth UI
verification remain part of the parent feature lifecycle.

---

### 2026-07-24 — session `fix-free-tier-model-entitlement` (B14 completion)

Removed the synthetic `auto` model from the catalog, API routing, sandbox
configuration, SDK defaults, web model picker, CLI, Slack, and tests. The
platform default is the concrete managed model `glm-5.2`. Stale `auto` and
`kortix/auto` selections are discarded by SDK storage compatibility paths and
rejected by the gateway as `model_not_found`.

Managed-model entitlement now depends only on the resolved billing tier.
`free`, `none`, and unknown tiers are blocked in every environment. Wallet
balance cannot grant managed-model access. Free-tier gateway authorization
does not place an LLM wallet hold. BYOK resolves with `billingMode: none` and
does not append a managed fallback. Codex remains provider-funded and reaches
its credential gate before any managed-model entitlement gate.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1179 pass / 0 fail** across 89 files with 5187
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully. The two public
surface snapshot diffs contain only the additive `resolvePromptModel` export.

**Cross-surface evidence:** the full web suite reported **1979 pass / 0 fail**
across 219 files with 5521 assertions. The sandbox-agent suite reported **215
pass / 0 fail**. The model catalog reported **64 pass / 0 fail**. The CLI
reported **514 pass / 0 fail**. The API contract reported **35 pass / 0 fail**.
All six affected package typechecks and focused web ESLint exited 0. Task-specific
API suites reported **69 pass / 0 fail** when run in isolated processes.

The standalone gateway reported **22 pass / 2 fail**. Both failures are
pre-existing architecture checks: `origin/main` already contains the
`@kortix/llm-catalog` dependency and the three flagged imports. The full API
command did not terminate after 14 minutes and was stopped. Its task-specific
files all pass in isolated processes.

**Real local HTTP evidence:** the API startup reported `Billing: ENABLED`. A
free account with `$100` balance received `400 plan_upgrade_required` for
`glm-5.2`; its balance remained `$100`. Both stale Auto IDs received `400
model_not_found`. The free catalog omitted all managed models and both Auto IDs.
The free model-default response returned `platformDefault: glm-5.2`,
`resolvedForCaller: null`, and `freeTier: true`. Free BYOK returned one
provider-funded candidate with no managed fallback. Free Codex reached
`provider_not_connected`, not the tier gate. A paid `per_seat` account received
`200` from `glm-5.2` with one completion choice.

**Shippable to production: YES** for B14 and the published SDK surface.
Repository merge, Deploy Dev, deployed-SHA proof, and live-dev verification
remain part of the repository lifecycle.

---

### 2026-07-24 — session `cors-transport-resilience` (B16 completion)

Added bounded transport retries to the shared SDK HTTP client. `GET` and `HEAD`
requests now use three total attempts. The retry delays are 250 ms and 500 ms.
The client still retries HTTP 502, 503, and 504 responses. It does not retry
mutations or abort errors. The host error handler runs once after exhaustion.

Extracted the API CORS configuration into `apps/api/src/middleware/cors.ts`.
The origin, method, header, credential, and preview policies remain unchanged.
Successful preflight responses now include `Access-Control-Max-Age: 600`.

**TDD evidence:** the first SDK regression run reported **18 pass / 2 fail**.
Both failures showed that `TypeError: Failed to fetch` received no SDK retry.
The first API test failed because `src/middleware/cors.ts` did not exist.
The focused GREEN runs reported **20 pass / 0 fail** for the SDK and **3 pass /
0 fail** for API CORS.

**Final SDK gates:** SDK and API typechecks exited 0. The full SDK suite reported
**1186 pass / 0 fail** across 89 files with 5204 assertions. The packed-install
smoke built, packed, installed, imported, and constructed `@kortix/sdk`.
`git diff --check` exited 0.

**API suite evidence:** the focused CORS suite passed. The full API suite reached
and passed the CORS suite. It then failed in unrelated existing tests. Examples
include missing `getTraceHeaders` and `captureException` exports, incomplete
maintenance mocks, and missing sandbox-reaper exports.

**Real local HTTP evidence:** an allowed preflight returned 204 with
`Access-Control-Allow-Origin: https://kortix.com`,
`Access-Control-Allow-Credentials: true`, and
`Access-Control-Max-Age: 600`. An unknown origin received no
`Access-Control-Allow-Origin`. `/v1/health` returned 200.

The in-app browser runtime exposed no browser. Local Chromium verification
remains unexecuted.

**Shippable to production: YES** for B16 and the published SDK surface.
Repository PR, Deploy Dev, deployed-SHA proof, and live-dev verification remain
part of the repository lifecycle.
---

### 2026-07-24 — session `native-oauth-sharepoint` (B17 claim)

Claimed the additive native OAuth2 client-credentials connection
contract. The existing Connector and Connector architecture remains unchanged.
The server will acquire, cache, refresh, revoke, and inject OAuth2 access tokens.
The first slice supports client secrets and certificate-based client assertions.
Existing static credentials and Pipedream connections remain backward compatible.

**Status:** IN PROGRESS.

---

### 2026-07-24 — session `native-oauth-sharepoint` (B17 completion)

Added OAuth2 client credentials to the existing Connector and Connector
credential routes. Static credentials remain compatible. The new contract
supports `client_secret_post`, `client_secret_basic`, and `private_key_jwt`.
Certificate assertions use `PS256` and include `x5t#S256`.

The API validates the token endpoint before storage. It encrypts the OAuth2
configuration and cached access token with the project key. Connector resolution
refreshes tokens with 60 seconds or less remaining. A PostgreSQL advisory lock
serializes concurrent refreshes for each credential row. Profile revocation
removes the credential from the next Connector resolution.

**Final SDK gates:** the SDK typecheck exited 0. The full SDK suite reported
**1187 pass / 0 fail** across 89 files. The packed-install smoke built,
packed, installed, imported, and constructed `@kortix/sdk`. The public type
snapshot adds only `ConnectionCredentialInput` and
`OAuth2ClientCredentials` under the root and `projects-client` exports.

**Cross-surface evidence:** the API contract reported **37 pass / 0 fail**.
The focused API suites reported **45 pass / 0 fail**. The isolated PostgreSQL
profile suite reported **22 pass / 0 fail**. The full web suite reported
**2089 pass / 0 fail**. Ke2e coverage reported **493/502 routes**, 9 allowlisted,
and 0 uncovered. API, SDK, and API-contract typechecks exited 0. Focused web
ESLint and `git diff --check` exited 0.

The repository-wide API suite is not green on this base. Unrelated baseline
failures include missing `getTraceHeaders`, stale sandbox-reaper exports, and
incomplete maintenance mocks. The changed OAuth2 and Connector suites pass.

**Real SharePoint evidence:** the isolated API acquired a Microsoft Graph token.
Graph returned 200 for the configured SharePoint site. Graph returned 200 for
the document-library list and returned one drive. Local profile revocation
returned 200. The next Connector call returned 404.

The browser runtime exposed zero browsers. Browser DOM and network verification
remain unexecuted. The temporary browser fixture was deleted. The isolated
database reports zero rows for its project and auth user.

**Shippable to production: YES** for B17 and the published SDK surface.
Repository merge, Deploy Dev, deployed-SHA proof, and live-dev verification
remain part of the repository lifecycle.
---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 1)

Created the web SDK-only specification and implementation plan. Added an AST
boundary scanner, an exact ratchet baseline, and ESLint import restrictions.

The RED test reported 155 forbidden production imports. The categories were 103
host runtime imports, 32 host-owned Kortix API imports, and 20 deprecated SDK
runtime imports.

The focused GREEN run reported 1 pass and 0 failures. ESLint returned one
`no-restricted-imports` error for a synthetic `@opencode-ai/sdk` import outside
the baseline. ESLint passed for the changed configuration, scanner, and test.

**Shippable to production: NOT YET.** The baseline still contains 155 violations.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 2)

Replaced frontend OpenCode compatibility imports with `@kortix/sdk` and
`@kortix/sdk/react`. Replaced host store imports with
`@kortix/sdk/internal/*`. Deleted 13 compatibility re-export files.

The boundary baseline decreased from 155 violations to 47 violations. All 20
deprecated SDK runtime imports are gone. The host runtime category decreased
from 103 imports to 15 imports. The 32 host-owned Kortix API imports remain for
Task 5.

Focused web tests reported **51 pass / 0 fail**. The boundary test passed.
ESLint checked 78 changed TypeScript files and reported 0 errors. It reported
four existing `react-hooks/exhaustive-deps` warnings.

The web typecheck reported four existing errors. None references a changed
file. Two errors are in the OG template test. Two errors are unresolved
generated docs-source imports.

**Shippable to production: NOT YET.** Tasks 3 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 3)

Added the generic OAuth2 protocol engine. It implements PKCE S256,
Authorization Code exchange, refresh-token rotation, Device Authorization,
discovery, and revocation. Token requests support `none`,
`client_secret_basic`, `client_secret_post`, `client_secret_jwt`, and
`private_key_jwt`. Provider responses are bounded. Provider errors omit
descriptions and token values. Production egress uses the shared SSRF guard.

Expanded the existing Client Credentials contract with `none` and
`client_secret_jwt`. Removed the certificate-thumbprint requirement from
generic `private_key_jwt`. The optional thumbprint remains supported.

**RED evidence:** the focused protocol test failed because
`oauth2-lifecycle.ts` did not exist.

**Verification:**

- Focused OAuth, contract, and SDK suites: **83 pass / 0 fail**.
- API typecheck: exit 0.
- SDK typecheck and example typecheck: exit 0.

**Shippable to production: NOT YET.** Tasks 4 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 4)

Added project-scoped routes for redacted application configuration, discovery,
Authorization Code start, Device Authorization start and poll, and status.
Added the public state-authenticated callback. Callback state is hashed,
profile-bound, user-bound, expiring, and consumed once. Added remote
revocation attempts with unconditional local delegated-credential deletion.

**Verification:**

- Focused OAuth, contract, and SDK suites: **83 pass / 0 fail**.
- API typecheck: exit 0.
- Local API proof: application PUT 200, redacted GET 200, status GET 200,
  Authorization Code start 200 with `S256` and state.
- Callback replay proof: first provider-error callback returned 302 to the
  allowlisted local frontend; the second callback returned 400.
- Ke2e `CONN-OAUTH2`: **1 pass / 0 fail** in 4.55 seconds.
- Ke2e coverage: **492/501 routes covered, 9 allowlisted, 0 uncovered**.

**Shippable to production: NOT YET.** Tasks 5 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 5)

Added delegated OAuth2 token resolution and refresh under the credential
database advisory lock. Refresh-token rotation updates the encrypted credential.

Added native request authentication for API keys in headers, query parameters,
and cookies; generic HMAC-SHA256; AWS Signature Version 4; and mutual TLS.
Existing bearer, HTTP Basic, custom, OAuth 1.0a, and no-auth behavior remains.
The manifest schema and SDK types expose the same authentication matrix.

**RED evidence:** four connector tests failed before implementation. They showed
missing cookie placement, raw HMAC and SigV4 credentials in headers, and absent
TLS options.

**Verification:**

- Focused connector, OAuth, manifest, contract, and SDK suites:
  **205 pass / 0 fail**.
- Added manifest conformance proof: **108 pass / 0 fail** in the final focused
  wave.
- API typecheck: exit 0.
- SDK typecheck and example typecheck: exit 0.

**Shippable to production: NOT YET.** Tasks 6 through 8 remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 3)

Enabled the complete `useSession(projectId, sessionId)` engine on the project
session page. The root `SessionChat` now consumes its messages, status, and
pagination state. Child session modals retain an isolated read-only sync engine.

Moved permission recovery into `useSession`. Disabled duplicate question and
permission recovery inside the root `SessionChat`. Replaced the frontend
`getClient().session.command()` call with the typed SDK command action.

**TDD evidence:** the first command-input test failed because
`buildSessionCommandInput` did not exist. The first runtime forwarding test
failed because `executeOpenCodeCommand` did not exist. The GREEN SDK run
reported **20 pass / 0 fail**.

The web architecture test first reported **0 pass / 2 fail**. It detected
`chatEngine: false`, a second message sync engine, duplicate recovery pollers,
and a direct runtime client call. The GREEN web run reported **53 pass / 0
fail** across 11 focused files.

The SDK typecheck exited 0. The web typecheck reported four existing errors.
None references a changed file. ESLint reported 0 errors and one existing
`react-hooks/exhaustive-deps` warning.

**Shippable to production: NOT YET.** Tasks 4 through 8 remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 4)

Moved provider normalization, provider merging, and server-backed model defaults
into `@kortix/sdk/react`. Added `useSessionModelSelection` as the
runtime-neutral project model and agent hook.

Moved optimistic compaction state behind `useSession`. Consolidated first-message
files and boot-time queued messages into one presentation-only web store.
Deleted every file under `apps/web/src/hooks/opencode`.

The boundary baseline decreased from 47 violations to 32 violations. The host
runtime category decreased from 15 imports to 0 imports. The remaining 32
violations are host-owned Kortix API imports assigned to Task 5.

**TDD evidence:** the provider merge test failed because
`mergeProviderLists` did not exist. The model-default test failed because
`use-model-defaults` did not exist. The compaction boundary test failed while
`SessionChat` imported the host compaction store.

The GREEN SDK run reported **113 pass / 0 fail**. The GREEN web run reported
**33 pass / 0 fail**. The SDK typecheck exited 0. The web typecheck retained
four unrelated existing errors. ESLint reported 0 errors and two existing hook
warnings.

**Shippable to production: NOT YET.** Tasks 5 through 8 remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 5)

Moved every frontend Kortix API transport into `@kortix/sdk`. Deleted
`apps/web/src/lib/api-client.ts` and nine host API wrapper modules. Moved the
IAM client and portable React Query modules into the SDK.

The corrected boundary inventory found 40 forbidden imports after adding
`@/lib/api-client` enforcement. The final baseline contains 0 violations.
The scanner also rejects the `backendApi` and `authenticatedFetch` identifiers.

**TDD evidence:** five focused SDK files first failed on missing exports.
The GREEN SDK run reported **48 pass / 0 fail**. The web boundary and public
marketplace run reported **5 pass / 0 fail**. The SDK typecheck exited 0.
ESLint reported 0 errors.

The public runtime and type snapshots contain additions only. They contain no
removed or renamed exports.

**Shippable to production: NOT YET.** Tasks 6 through 8 remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 6)

Moved runtime routing, runtime actions, SSE transport, preview authentication,
presentation conversion, PTY commands, and explicit host-boundary transport
into `@kortix/sdk`.

Added runtime-neutral SDK aliases without removing existing public exports.
Renamed the remaining frontend files that contained `opencode`. The web source
tree now contains no file path with that term.

Expanded the AST boundary and ESLint gates. They reject OpenCode imports,
deprecated runtime SDK subpaths, SDK internal subpaths, legacy runtime stores,
runtime proxy paths, OpenCode REST paths, and raw Kortix backend routes.
The boundary baseline contains 0 violations.

The runtime snapshot added 145 names and removed 0 names. The type snapshot
added 167 names and removed 0 names.

**Verification:**

- SDK typecheck: exit 0.
- SDK suite: **1206 pass / 0 fail / 2 skip** across 98 files.
- SDK packed-install smoke: pass.
- Web suite: **2043 pass / 0 fail** across 224 files.
- Web boundary test: **1 pass / 0 fail**.
- Changed-file ESLint: 0 errors and 22 existing warnings.
- Web typecheck: four existing errors only. Two are in the OG template test.
  Two are unresolved generated docs-source imports.
- White-label typecheck: exit 0.
- White-label fresh build: exit 0.
- White-label E2E: **44 pass / 0 fail / 3 live-upstream skips**.

**Shippable to production: NOT YET.** Task 7 local parity proof and Task 8
delivery and dev proof remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 7)

Added a real browser regression for the SDK-only session path. The test creates
a confirmed user, provisions a project and Platinum session, sends one prompt,
observes the SDK runtime request, opens Files, and deletes all created resources.

Updated the shared browser login helper for the email-first password flow.
Added the SDK boundary test and frontend ESLint to the pull-request CI job.

**Verification:**

- SDK typecheck: exit 0.
- SDK suite: **1206 pass / 0 fail / 2 skip** across 98 files.
- SDK packed-install smoke: pass.
- Web suite: **2043 pass / 0 fail** across 224 files.
- Web SDK boundary plus full source ESLint: **1 pass / 0 fail**, ESLint exit 0.
- White-label typecheck and fresh build: exit 0.
- White-label E2E: **44 pass / 0 fail / 3 live-upstream skips**.
- Managed session HTTP smoke: **25 pass / 0 fail** with a visible `PONG`.
- PTY smoke: pass, including WebSocket attach and replay.
- File transport smoke: **26 pass / 1 optional agent-read failure**.
- SDK-only Chromium session: **1 pass** in 1.0 minutes. It observed one
  `prompt_async`, visible `PONG`, no failed Kortix responses, and `kortix.yaml`.
- Tests TypeScript check and `git diff --check`: exit 0.

The generic auth spec failed because its default local user credentials were
absent. The SDK-only regression creates and deletes its own confirmed user.

**Shippable to production: NOT YET.** Task 8 delivery and dev proof remains.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 8)

Merged the SDK-only web refactor in PR #5388. The merge commit is
`aefa2a6282ed540a7296e35db2747bce2cc1d3eb`.

Deploy Dev run 30129604715 completed successfully at
`ae967fdbc6066f3a941a4553c0d21afb10639774`. Git ancestry proves that deployed
commit contains the refactor merge. The API health route reported
`0.10.15-dev.ae967fdb`. The tested Vercel deployment reported
`0.10.14-dev.ae967fdb`.

The deployed Chromium regression passed in 1.2 minutes. It rendered the session
workspace, sent one `prompt_async` request, displayed `PONG`, observed zero
failed Kortix project or runtime responses, and opened `kortix.yaml`.

The first protected-dev browser run exposed an E2E harness defect. The shared
Vercel bypass header reached the cross-origin API and failed its CORS preflight.
The login helper now converts that header into a web-origin Vercel cookie before
the browser sends API requests.

The public PTY smoke exposed a Cloudflare WebSocket response defect. PR #5392,
merged as `8688b8492c9534bb6d43a3282904f19cbd557c78`, preserves Cloudflare
`response.webSocket` upgrade responses. Dev worker version
`33ef7b35-3e6d-452f-9165-b00bafd9e9a1` carries the fix.

The final public dev PTY smoke passed against a real Platinum sandbox. It
created a PTY, opened the WebSocket, sent and observed a marker, reconnected and
observed replay, listed the running PTY, deleted it, and removed its disposable
project and session.

**Verification:**

- SDK typecheck: exit 0.
- SDK suite: **1210 pass / 0 fail**.
- SDK packed-install smoke: pass.
- Web suite: **2043 pass / 0 fail**.
- Web boundary test: **1 pass / 0 fail**.
- White-label E2E: **44 pass / 0 fail / 3 live-upstream skips**.
- Managed session HTTP smoke: **25 pass / 0 fail**.
- SDK-only local Chromium session: **1 pass**.
- SDK-only dev Chromium session: **1 pass**.
- Public dev Platinum PTY smoke: pass.
- Cloudflare API router regression: **5 pass / 0 fail**.

**Shippable to production: YES.** All eight tasks are complete. Local and
deployed dev paths pass.
---

### 2026-07-24 — session `managed-models-aster` (B18 completion)

Synchronized the managed-model playground pin with the four-model managed
catalog. The pin contains `claude-opus-4.8`, `claude-sonnet-4.6`, `glm-5.2`,
and `deepseek-v4-flash`. The pin no longer contains `qwen3.7-max` or
`deepseek-v4-pro`.

**RED evidence:** the playground stopped before API access because the pinned
IDs contained retired managed models.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0. The full SDK
suite reported **1185 pass / 2 skip / 0 fail** across 89 files. The
packed-install smoke built, packed, installed, imported, and constructed
`@kortix/sdk`.

**Shippable to production: YES** for B18 and the published SDK surface.
Repository delivery and live-dev verification remain part of the repository
lifecycle.
---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 1)

Added provider-independent OAuth2 application, Authorization Code, Device
Authorization, connection-status, and client-authentication contracts. Added
typed SDK methods for every profile-scoped lifecycle route.

**RED evidence:** the focused test command reported two missing exports and
zero passing tests before implementation.

**Verification:**

- Contract and SDK focused suites: **67 pass / 0 fail**.
- SDK typecheck and example typecheck: exit 0.

**Shippable to production: NOT YET.** Tasks 2 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 2)

Added project-scoped encrypted OAuth application storage. Added short-lived
Authorization Code and Device Authorization session storage. The database
enforces valid flow material, session status, unique state hashes, and profile
tenant ownership.

**Verification:**

- Database typecheck: exit 0.
- Migration lint: 72 files pass with eight existing destructive warnings.
- Isolated database migration: applied
  `20260725120000000_connector_oauth_lifecycle`.
- Database query returned `connection_oauth_applications` and
  `connection_oauth_sessions`.

**Shippable to production: NOT YET.** Tasks 3 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 6)

Added provider-independent web controls for Client Credentials, Authorization
Code with PKCE, and Device Authorization. Added all five token-endpoint client
authentication methods. Added typed project-profile creation for the first
delegated connection.

Added visible request-authentication controls for API keys, OAuth 1.0a,
HMAC-SHA256, AWS SigV4, mutual TLS, bearer, Basic, custom parameters, and no
authentication. Structured strategies accept validated encrypted JSON
credentials.

**RED evidence:** the focused web suite reported four failures and one missing
export before implementation.

**Verification:**

- Focused web suite: **17 pass / 0 fail**.
- Focused SDK connector suite: **26 pass / 0 fail**.
- API typecheck: exit 0.
- Changed-file ESLint: exit 0.
- Changed-file web TypeScript output: no errors.
- Live profile creation: connector list `200`; profile creation `200`.

The browser runtime reported zero available browsers. DOM and browser network
proof remains open for Task 7.

**Shippable to production: NOT YET.** Tasks 7 and 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 7)

Completed the local contract, API, connector, SDK, database, web, and live HTTP
verification.

**Verification:**

- OAuth and request-authentication API suite: **44 pass / 0 fail**.
- Connector faces and authentication discovery suite: **80 pass / 0 fail**.
- OAuth web suite: **18 pass / 0 fail**.
- Full web suite: **2064 pass / 0 fail**.
- Full SDK suite: **1214 pass / 0 fail**.
- SDK typecheck, example typecheck, and packed-install smoke: exit 0.
- API, contract, manifest, and database typechecks: exit 0.
- API contract: **41 pass / 0 fail**.
- Manifest schema: **321 pass / 0 fail**.
- Database: **118 pass / 0 fail**.
- Migration lint: **72 files pass**. Squawk reports zero issues.
- Authorization Code callback: HTTP `302`; PKCE method `S256`.
- Authorization state replay: first callback HTTP `302`; replay HTTP `400`.
- Device Authorization: start HTTP `200`; poll reaches `active`.
- Refresh-token rotation replaced both access and refresh tokens.
- Revocation: HTTP `200`; profile status reaches `revoked`.
- Local API health: HTTP `200`.

The browser runtime reports `No browser is available`. Browser discovery
returns `[]`. Chromium DOM and network proof remains blocked.

**Shippable to production: NOT YET.** Task 8 delivery and dev proof remains.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 8)

Merged the provider-independent authentication engine in PR #5403. The merge
commit is `00bc29065ac54791b71957b9d2e2ccac313b5c29`.

Deploy Dev run 30136343999 completed successfully. The workflow applied the
OAuth lifecycle migration. It deployed API image tag `dev-00bc2906` to ECS and
EKS. It also tagged the frontend image with the full merge SHA.

The live dev health route returned HTTP `200`, environment `dev`, and version
`0.10.15-dev.00bc2906`. The public OAuth callback returned HTTP `400` without
state. The protected OAuth status route returned HTTP `401` without
authentication. These responses prove that the deployed OAuth routes are
mounted on the merged API artifact.

The browser runtime returned `No browser is available`. Browser discovery
returned `[]`. Chromium DOM and network proof remains blocked by the missing
browser runtime.

**Status: COMPLETE.**

**Shippable to production: YES.** Local protocol proof, CI, repository delivery,
deployed-SHA proof, database migration, and live dev API verification pass.

---

### 2026-07-25 — session `session-history-pagination` (claim)

Claimed the user-directed session-history pagination repair. The SDK will load
complete turns across fixed-size runtime pages. The web host will preserve a
stable visible DOM anchor instead of applying total `scrollHeight` growth.
Existing exports and session synchronization contracts remain backward
compatible. Work will follow RED -> GREEN -> REFACTOR and finish with the full
SDK typecheck, test, and packed-install smoke gates, focused web tests, browser
verification, repository merge, Deploy Dev, and live-dev proof.

**Status:** IN PROGRESS.
---

### 2026-07-25 — session `gateway-billing-audit` (B19 claim)

Claimed the additive managed-model pricing and cache-write cost contract. The
project catalog will carry server-supplied managed prices. The turn estimator
will accept a distinct cache-write rate. Existing public names and required
fields remain backward compatible.

Implementation will follow RED -> GREEN -> REFACTOR. The final SDK typecheck,
full suite, and packed-install smoke gates are required.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `gateway-billing-audit` (B19 completion)

Added the server-supplied managed-model prices to the typed project catalog.
Added cache-write rates and context tiers to the public turn-cost contract.
The browser no longer uses `models.dev` as a fallback for `kortix` models.
`GatewayLogRow` now includes `cache_write_tokens`.

**RED evidence:**

- The managed GLM lookup returned another provider's price instead of Aster's
  `$1/M` input, `$0.20/M` cache-read, `$1/M` cache-write, and `$4/M` output.
- The turn estimator priced cache writes at the input rate because the public
  contract had no `cacheWritePer1M` field.
- The gateway log SDK contract had no `cache_write_tokens` field.

**Verification:**

- SDK typecheck and example typecheck: exit 0.
- Full SDK suite: **1216 pass / 0 fail** across 98 files.
- Public type-surface snapshot: additive `ModelCostTierRates`; no removals.
- Packed-install smoke: built, packed, installed, imported, and constructed
  `@kortix/sdk`.
- Web managed-pricing suite: **8 pass / 0 fail**.
- Changed-file web ESLint and Prettier checks: exit 0.

**Shippable to production: YES** for B19 and the published SDK surface.
Repository merge, Deploy Dev, and live-dev verification remain repository
delivery tasks.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 3 claim)

Claimed the OpenCode-only ACP canary after both previous SDK claims closed.
PR #5400 merged the session-history pagination change.
PR #5403 and Deploy Dev run 30136343999 completed the authentication lifecycle.

The sandbox process and bridge slices are complete.
The real OpenCode `1.18.4` smoke negotiated ACP v1, exposed its internal HTTP
server, and created ACP session `ses_0693a6e03ffeGeChw6OVEfRGaW`.

Task 3 will add server-owned `acp` and `rest` transport metadata.
The SDK source remains unchanged until Task 4 starts with a failing test.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 3 completion)

Separated the OpenCode process transport from the SDK client transport.
Every sandbox injects `KORTIX_OPENCODE_PROCESS_TRANSPORT=acp`.
The API client transport defaults to `rest` during the parity implementation.
The `/start` response reports that client transport as `runtime_transport`.
Pre-ACP servers can omit the additive field.

**Verification:**

- API contract and runtime-env tests: **22 pass / 0 fail**.
- Focused `/start` HTTP contract: **1 pass / 0 fail**.
- API contract typecheck: exit 0.
- API typecheck: exit 0.

**Status:** COMPLETE.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 4 completion)

Added the framework-free SDK ACP transport.
It sends JSON-RPC requests, notifications, and responses through the authenticated sandbox bridge.
It consumes ordered SSE events and reconnects with `Last-Event-ID`.
It exposes native `session/load`, `session/prompt`, `session/cancel`, and `session/set_config_option` methods.

Added the framework-free ACP session projection.
It converts user, assistant, thought, tool, plan, permission, question, usage, and stop updates into the existing Kortix session presentation types.
It rejects updates for a different ACP session.

**RED evidence:** the focused run reported two missing modules and zero passing tests.

**Verification:**

- Focused ACP SDK suite: **8 pass / 0 fail**.
- SDK typecheck and example typecheck: exit 0.
- Isomorphic export and public-surface gates: **69 pass / 0 fail**.
- Direct OpenCode `1.18.4` smoke: ACP v1 initialize, session creation, streamed thought and assistant chunks, and `end_turn` completion.

**Status:** COMPLETE.

**Shippable to production: NOT YET.** Tasks 5 through 8 remain incomplete.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Tasks 5–6 completion)

Extended the ACP projection for command, mode, config, session-information,
usage, permission, question, cancellation, and transport-error state.

Integrated ACP into the existing `useSession(projectId, sessionId)` hook.
The server-provided `runtime_transport` selects the SDK path.
Missing metadata and `rest` retain the existing OpenCode REST path.
The ACP path disables OpenCode REST events, session listing, message sync, and
prompt sends.

The root web composer calls `sessionState.sendParts()`.
The web application does not inspect `runtimeTransport`.
The same SDK result handles commands, cancellation, permissions, and questions.

Added the `acp_runtime` project experiment.
The existing self-describing experimental settings UI renders its catalog entry.

**RED evidence:**

- Runtime policy test: missing `createSessionRuntimePolicy` export; **0 pass / 1 fail**.
- Web routing test: missing `sessionState.sendParts`; **1 pass / 1 fail**.
- Projection and controller error fixtures: **8 pass / 2 fail**.

**Verification:**

- Focused ACP projection/controller suite: **10 pass / 0 fail**.
- Runtime policy/controller suite: **8 pass / 0 fail**.
- Web SDK routing gate: **2 pass / 0 fail**.
- SDK typecheck and examples: exit 0.
- SDK full suite: **1228 pass / 2 skip / 0 fail**.
- SDK packed-install smoke: pass.
- API experimental-feature suite: **16 pass / 0 fail**.
- API serializer suite: **17 pass / 0 fail**.
- API contract schema suite: **41 pass / 0 fail**.
- Sandbox ACP process and bridge suite: **19 pass / 0 fail**.
- White-label typecheck: exit 0.

**Status:** COMPLETE.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 7 completion)

Completed the real OpenCode ACP parity matrix in one Chromium session.
The matrix covers ordered SSE reconnects, `Last-Event-ID`, `session/load`,
transcript restoration, text streaming, permissions, questions, attachments,
busy-message serialization, cancellation, slash commands, and process restart.

The sandbox daemon resumes the canonical ACP session after OpenCode restarts.
It publishes the replayable `kortix/runtime_ready` process-generation signal.
The SDK reloads the canonical session before it accepts another prompt.

The OpenCode question compatibility bridge exposes questions as
`session/request_input`.
The browser returns only ACP JSON-RPC responses.

**RED evidence:**

- SDK restart recovery: **12 pass / 1 fail**.
- Sandbox restart signal: **13 pass / 1 fail**.
- The pre-fix Chromium matrix reconnected SSE after `/kortix/refresh/`.
  It did not send a post-restart prompt because the new process had no loaded
  ACP session.

**Verification:**

- Focused ACP SDK suite: **18 pass / 0 fail**.
- Focused sandbox ACP suite: **17 pass / 0 fail**.
- Linux sandbox daemon build: exit 0.
- Platinum image `kortix-default-0429779a8bc2`: built in 370.774 seconds.
- Full local Chromium ACP and REST rollback matrix: **1 pass / 0 fail** in
  4.3 minutes.

**Status:** COMPLETE.

**Shippable to production: NOT YET.** Task 8 delivery and dev proof remain.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 8 completion)

Merged the OpenCode-only ACP canary in PR #5415.
The merge commit is `3a45ab55b7a53cc20a3a360a7e8d65e4180a5c2a`.

Deploy Dev run 30148258802 completed successfully at
`f8968d3e1ae3066a3cdc819e6da99b363e36b744`.
Git ancestry proves that the deployed commit contains the ACP merge.
The live API health route reports `0.10.15-dev.f8968d3e`.

The active Vercel deployment is
`dpl_E9tZk2nS94mk1cAH1FmX6X464zkr`.
It is `READY` at commit
`0aa15072cf91e7be5c0d0cd2c39b8d3d703d5be2`.
Git ancestry proves that this frontend commit contains the ACP merge.

The deployed cold Chromium matrix passed without a preloaded ACP session.
It covered ordered SSE reconnects, `Last-Event-ID`, `session/load`, prompt
streaming, transcript reload, permissions, questions, attachments,
cancellation, busy-message serialization, slash commands, process restart
recovery, and REST rollback.
Playwright reported **1 pass / 0 fail** in 4.2 minutes.

The first deployed run exposed a test-harness defect.
The welcome-card close action used a 10-second timeout and suppressed its
timeout with `.catch(() => {})`.
The production button already had `aria-label="Dismiss"`.
The corrected test uses a 30-second click timeout and does not suppress a
failed click.

**Final verification:**

- SDK typecheck and example typecheck: exit 0.
- SDK full suite: **1249 pass / 0 fail** across 104 files with 5589 assertions.
- SDK packed-install smoke: pass.
- Test-harness typecheck: exit 0.
- Frontend SDK and session-engine boundaries: **3 pass / 0 fail**.
- Test formatting and `git diff --check`: exit 0.
- PR #5415 checks: **18 successful / 0 failing**.
- CodeQL: **0 new alerts**.
- Local ACP and REST Chromium matrix: **1 pass / 0 fail**.
- Deployed cold ACP and REST Chromium matrix: **1 pass / 0 fail**.

**Status: COMPLETE.**

**Shippable to production: YES.** All eight tasks are complete.
Local and deployed dev ACP and REST paths pass.

---

### 2026-07-25 — session `acp-opencode-canary` (ACP stream timeout correction)

The follow-up deployed cold Chromium run exposed an ACP transport defect.
`authenticatedFetch` applied its 30-second default timeout to `/kortix/acp/:sessionId`.
The controller lost the stream while `session/load` was pending.
The browser never sent `session/prompt`.

`isStreamingRequest` now exempts both OpenCode REST `/global/event` streams and
ACP `/kortix/acp/:sessionId` streams.
Non-streaming requests retain the 30-second timeout.

**RED evidence:**

- Focused auth transport suite: **11 pass / 1 fail**.
- The ACP URL returned `false` from `isStreamingRequest`.

**Verification:**

- Focused auth transport suite: **12 pass / 0 fail**.
- SDK typecheck and example typecheck: exit 0.
- SDK full suite: **1250 pass / 0 fail** across 104 files with 5592 assertions.
- SDK packed-install smoke: pass.
- Test-harness typecheck: exit 0.
- Frontend SDK and session-engine boundaries: **3 pass / 0 fail**.
- Full local cold Chromium ACP and REST rollback matrix: **1 pass / 0 fail** in
  2.7 minutes.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, and the deployed
cold Chromium matrix remain.
---

### 2026-07-25 — session `acp-opencode-canary` (B21 implementation)

Serialized ACP prompt preparation with OpenCode runtime restarts.
The controller interrupts stalled config-option requests when
`kortix/runtime_ready` changes the runtime generation.
It waits for canonical `session/load` replay and retries only the idempotent
model and mode config preflight.
It does not retry `session/prompt` after dispatch.
It resets the ACP projection before runtime replay.

**RED evidence:**

- Focused controller suite: **13 pass / 2 fail**.
- Runtime replay produced four messages instead of two.
- The interrupted config preflight did not complete within 50 milliseconds.

**Verification:**

- Focused ACP controller suite: **16 pass / 0 fail**.
- SDK typecheck and example typecheck: exit 0.
- SDK full suite: **1253 pass / 0 fail** across 104 files with 5603 assertions.
- SDK packed-install smoke: pass.
- Test-harness typecheck: exit 0.
- `git diff --check`: exit 0.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, and the deployed
cold Chromium ACP plus REST rollback matrix remain.
---

### 2026-07-25 — session `false-load-older` (claim)

Claimed the user-reported false `Load older messages` control on a one-turn
session. The investigation will verify the runtime pagination response before
changing the SDK contract. The implementation will follow RED -> GREEN ->
REFACTOR and preserve all exported names.

Required completion gates are the full SDK typecheck, test suite, packed-install
smoke, focused web tests, local browser proof, repository merge, Deploy Dev, and
deployed browser proof.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `acp-opencode-canary` (B21 delivery completion)

Merged the ACP restart-safe send serialization in PR #5433.
The merge commit is `aedb8c16b1c11baeb501ea9107dfcac083cb8caa`.
All 15 PR checks passed.

Deploy Dev run `30160708566` completed successfully.
The active API reports `0.10.15-dev.85ae91df`.
The active Vercel deployment is `dpl_9M5yptfdDL48vPASvYDt92kQCFtD`.
It is `READY` at commit `85ae91df47da26281dc35d098954567b132f192e`.
Git ancestry proves that both deployed artifacts contain the B21 merge.

The first post-deploy rollback attempt pressed Enter before the REST model list
loaded. Its trace contains zero `/prompt_async` occurrences.
The harness now opens the model picker and waits for `Claude Sonnet 4.6` before
it sends the REST rollback prompt.

The final deployed cold Chromium matrix passed.
It proved ACP chat, SSE reconnect, transcript reload, tool approval, question
input, attachments, queueing, cancellation, slash commands, runtime restart,
post-restart prompt delivery, and REST rollback.

**Final verification:**

- Focused ACP controller suite: **16 pass / 0 fail**.
- SDK full suite: **1253 pass / 0 fail** across 104 files.
- SDK assertions: **5603**.
- SDK typecheck and example typecheck: exit 0.
- SDK packed-install smoke: pass.
- Test-harness typecheck: exit 0.
- PR #5433 checks: **15 pass / 0 fail**.
- Deployed cold ACP and REST Chromium matrix: **1 pass / 0 fail** in 3.3 minutes.

**Status:** COMPLETE.

**Shippable to production: YES.** ACP and REST rollback pass on deployed dev.

---

### 2026-07-25 — session `voice-sdk-import-recovery` (claim)

Claimed the stale `.channels.meet` SDK test references found by PR #5450.
The implementation already exposes `.channels.voice`.
This correction changes test references only.

Required completion gates are SDK typecheck, full tests, packed-install smoke,
PR merge, and Deploy Dev.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `voice-sdk-import-recovery` (implementation)

PR #5450 supplied the RED state.
The SDK typecheck failed because the voice change removed the public
`.channels.meet` compatibility surface.

Restored `.channels.meet` as a deprecated compatibility facade.
Kept `.channels.voice` as the current voice surface.
Restored the five removed REST compatibility tests.

**Verification:**

- SDK typecheck: exit 0.
- SDK full suite: **1254 pass / 0 fail** across 104 files.
- SDK assertions: **5608**.
- SDK packed-install smoke: pass.
- `git diff --check`: exit 0.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, and deployed web
verification remain.

---

### 2026-07-25 — session `whitelabel-acp-reference` (claim)

Claimed the full white-label ACP and SDK reference-app refactor.
The SDK will add the provider-neutral `default_agent` project-config field.
The legacy `open_code_default_agent` field will remain as a deprecated alias.

The reference app will use one `createKortix` client and one `useSession`
runtime path.
Client code will not import runtime transports, legacy runtime stores, or
OpenCode packages.
Client code will not construct Kortix REST or runtime proxy requests.
Project settings will render the server-provided experimental-feature catalog.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are the SDK suite, SDK typecheck, packed-install smoke,
white-label typecheck, build, full E2E suite, deterministic boundary tests,
real ACP browser proof, REST rollback proof, PR merge, Deploy Dev, and deployed
artifact verification.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `whitelabel-acp-reference` (local completion)

Completed the SDK-only white-label ACP reference implementation.

The white-label application uses one `createKortix` client and one
`useSession` path. Application code does not import OpenCode packages,
runtime transports, legacy runtime stores, or SDK source files.

The wrapper BFF delegates HTTP forwarding to the SDK-owned
`forwardKortixRequest()` function. White-label BFF tests use
`createScopedKortix()` from `@kortix/sdk/server`. Repository Playwright specs
also import the public SDK entry point.

The boundary scanner covers application source, local tests, and repository
Playwright specs. It rejects raw Kortix transport calls, SDK source imports,
OpenCode imports, runtime proxy URLs, OpenCode REST paths, provider terms,
legacy runtime stores, and direct runtime imports.

ACP question requests remain pending without a timeout. Fresh subscribers
receive unresolved questions. The daemon accepts the first client response
and suppresses duplicate or late responses.

ACP tool projections preserve native tool names, output text, output metadata,
and reference-compatible labels. Projection resets preserve requests received
during `session/load`.

Local verification:

- SDK typecheck: exit 0.
- SDK suite: **1259 pass / 0 fail** with **5627** assertions.
- SDK packed-install smoke: pass.
- Sandbox daemon typecheck and build: exit 0.
- Sandbox daemon suite: **293 pass / 0 fail** with **704** assertions.
- White-label typecheck and build: exit 0.
- White-label suite: **56 pass / 3 skip / 0 fail** with **181** assertions.
- White-label SDK boundary: **0 violations**.
- API typecheck: exit 0.
- Repository test-harness typecheck: exit 0.
- `git diff --check`: exit 0.
- Real ACP and REST presentation plus question parity: **1 pass** in
  **11.9 minutes**.
- Real project-settings ACP-to-REST rollback: **1 pass** in **1.2 minutes**.
- Test cleanup archived **15** projects through SDK methods.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.

The final boundary review found two Playwright imports of
`packages/sdk/src/node/server`. The RED test reported **10 pass / 1 fail**.
Both specs now import `@kortix/sdk/server`. The GREEN run reports
**11 pass / 0 fail**. Playwright lists both specs with the public package
import.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** Rebase, full post-rebase gates, PR merge,
Deploy Dev, deployed SHA proof, and deployed ACP plus REST parity remain.

---

### 2026-07-25 — session `whitelabel-acp-reference` (CI repair)

PR #5458 exposed two delivery defects.

The root `@kortix/sdk` development dependency broke the reduced API Docker
workspace. The dependency now belongs to the minimal `tests/e2e` workspace.
Both Playwright specs import the public `@kortix/sdk/server` entry point.

The first package-unit run timed out while the mode suite built Next.js and
started two servers. The setup limit is now 120 seconds. Test assertions remain
unchanged.

Post-repair verification:

- SDK typecheck: exit 0.
- SDK suite: **1259 pass / 0 fail** with **5629** assertions.
- SDK packed-install smoke: pass.
- White-label suite: **57 pass / 3 skip / 0 fail** with **182** assertions.
- White-label SDK boundary: **0 violations**.
- Repository test-harness typecheck: exit 0.
- Playwright collection: **2 tests in 2 files**.
- API self-host Docker build: exit 0.
- `git diff --check`: exit 0.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed ACP plus REST parity remain.

---

### 2026-07-26 — session `use2-session-readiness` (B26 and B27 claim)

Claimed two notification regressions found during live US shadow verification.

- Warm-session configuration mismatches must remain recoverable without a
  global error notification.
- All-account project queries must let React Query retry transient failures
  without a global error notification.

Implementation will follow RED -> GREEN -> REFACTOR. Required gates are focused
SDK tests, full SDK typecheck, suite, packed-install smoke, web lint, PR merge,
Deploy Dev SHA proof, and US shadow verification.

**Status:** IN PROGRESS.

---

### 2026-07-26 — session `api-latency-refactor` (B24 and B25 claims)

Claimed two additive React SDK changes.

B24 adds an optional server-authorized initial OpenCode session pin. The pin
starts IndexedDB transcript hydration before `/start` completes. The `/start`
pin remains authoritative.

B25 starts the compact project model-picker request in parallel with project
detail. Native projects continue to wait for runtime readiness.

Implementation follows RED -> GREEN -> REFACTOR. Required gates are SDK
typecheck, the full SDK suite, packed-install smoke, focused web tests, local
browser proof, PR merge, Deploy Dev, deployed SHA proof, and deployed browser
proof.

**Status:** IN PROGRESS.

**Shippable to production: NOT YET.**

---

### 2026-07-26 — session `api-latency-refactor` (B24 and B25 local completion)

Completed the additive initial-session pin and parallel model-picker changes.

RED evidence:

- The initial-pin test failed because `resolveSessionPin()` did not exist.
- The provider plan test failed because the model-picker waited for project
  detail.
- The web session-load test failed because cached transcript content could not
  mount before the runtime switch completed.
- The provider-loading test failed because the modal waited for runtime
  provider discovery after project detail and secrets had resolved.

Post-rebase gates:

- SDK typecheck: exit 0.
- SDK suite: **1275 pass / 0 fail** with **5669** assertions across **107**
  files.
- SDK packed-install smoke: pass.
- Web suite: **2207 pass / 0 fail** with **5970** assertions across **244**
  files.
- Focused web ESLint: exit 0.
- API typecheck: exit 0.
- Focused isolated API tests: **67 pass / 0 fail**.
- Sandbox-agent typecheck: exit 0.
- Sandbox-agent suite: **298 pass / 0 fail** with **720** assertions.

Live local execution-lease proof:

- `acquire`: HTTP 200 in **33.9 ms**. The response and database stored the same
  `executionLeaseUntil`.
- `renew`: HTTP 200 in **20.8 ms**. The response and database stored the same
  `executionLeaseUntil`.
- `release`: HTTP 200 in **21.3 ms**. The database stored
  `executionLeaseUntil = null`.

Browser discovery returned no available browser. Local DOM and browser-network
verification remains open.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed browser verification remain open.

---

### 2026-07-26 — session `api-latency-refactor` (B24 and B25 delivery completion)

PR #5490 merged into `main`.
The merge commit is `4f46e3aafdd02d43bbb022a28fd17fcfb94baeb5`.
All PR checks passed.

Deploy Dev run `30204286487` completed successfully.
The run head is the full merge commit.
The API EKS and ECS rollouts used image tag `dev-4f46e3aa`.
The frontend retag used the full merge commit.
The live API health response reports `0.10.16-dev.4f46e3aa`.

Deployed API contract proof:

- An unauthenticated `POST /v1/projects/x/execution-lease` returned `401`.
- The disposable live verifier returned `200` for `acquire`, `renew`, and
  `release`.
- The verifier measured **2807.1 ms**, **598.4 ms**, and **534.0 ms**.
- Acquire and renew response timestamps matched `executionLeaseUntil` in the
  dev database.
- Release stored `executionLeaseUntil = null`.

Deployed sandbox-agent proof used Daytona snapshot
`kortix-default-631f50320491`.
Disposable session `07729779-f350-4af0-b46f-f727d91859f6` entered `busy` after
a real OpenRouter prompt.
CloudWatch recorded:

- One bootstrap-pin `turn-stream` request: `200` in **885 ms**.
- One lease `acquire` request: `200` in **793 ms**.
- One lease `release` request: `200` in **266 ms**.
- The gateway completed the model request with `200` in **2521 ms** and
  returned **808 tokens**.

CloudWatch Insights query
`dd8a17dd-bc08-4fdc-bc83-b0e8bfa21be5` covers the post-deploy window beginning
at `2026-07-26T13:44:00Z`.
It found **6** `execution-lease` requests across **3** disposable projects:
**266 ms p50**, **2005 ms p95**, **2005 ms p99**, and **603.2 ms average**.

CloudWatch Insights query
`874b0176-dc50-44ab-ab70-efdee3ac7268` covers the same window.
It found **227** `turn-stream` requests across **5** projects:
**260.9 ms p50**, **2006.6 ms p95**, **3001.9 ms p99**, and **593.0 ms
average**.
Three pre-existing sandboxes continued the legacy 20-second heartbeat.
New sandboxes use `execution-lease`; existing sandboxes retain their old daemon
until they stop or restart.

The deployed infrastructure-only session smoke completed **20 passes / 1
failure**.
The deployed busy-turn smoke completed **22 passes / 3 failures**.
Both smokes provisioned a real managed repository, built or reused the new
Daytona snapshot, started a real sandbox, reached OpenCode, and cleaned up.
The shared failures were `POST /git-token` returning `503`.
The busy-turn smoke also found no assistant text in the OpenCode message
response, although the gateway completed the model request with `200`.

Cleanup proof:

- Both disposable projects have status `archived`.
- Both disposable sessions have status `stopped` and a `deletedAt` timestamp.
- Both disposable sandboxes have status `archived` and a `stoppedAt` timestamp.
- Both disposable Supabase users were deleted with status `200`.

Browser discovery returned `[]` after troubleshooting.
Deployed DOM and browser-network verification remains open.

**Status:** MERGED AND DEPLOYED TO DEV.

**Shippable to production: NOT YET.** The deployed lease path passes.
Deployed browser verification, the `git-token` `503`, and the missing
assistant-text result remain open.

---

### 2026-07-26 — session `whitelabel-acp-stable-completion` (B23 delivery completion)

Merged B23 in PR #5477.
The merge commit is `480a44dcb9c6fce4f1f51c54dcb017750d187bdb`.
All PR checks passed: **15 pass / 0 fail** with **11** path-filtered checks.

Deploy Dev run `30184932143` completed successfully.
The API health response reports `0.10.16-dev.480a44dc`.
The API EKS rollout used image tag `dev-480a44dc`.
The frontend image tag references the full merge SHA.

Vercel deployment `dpl_FX4EmhvavKet4MvwcDyjVeqxZWdD` is ready.
GitHub maps that deployment to the full merge SHA.
The deployment owns the `dev.kortix.com` alias.

The final deployed ACP and REST presentation plus question matrix passed:

- Playwright: **1 pass / 0 fail** in **13.8 minutes**.
- ACP sent **2** ACP prompts and **0** REST prompts.
- REST sent **2** REST prompts and **0** ACP prompts.
- ACP rendered **28** completed tool cards.
- REST rendered **24** completed tool cards.
- Tool-card parity ratio: **0.857**.
- ACP created `/workspace/marko-kraemer.pptx` at **250,193 bytes**.
- REST created `/workspace/marko-kraemer.pptx` at **237,913 bytes**.
- Both transports persisted the question flow and rendered `QUESTION_BETA`.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.

**Status:** COMPLETE.

**Shippable to production: YES.** ACP and REST stable completion pass on
deployed dev.

---

### 2026-07-25 — session `whitelabel-acp-reference` (runtime freshness follow-up)

The merged reference app exposed two live-path defects.

Project provisioning used the shared 30-second request timeout. Real sandbox
provisioning exceeded that limit. `projects.provision()` now accepts request
options and defaults to 120 seconds.

ACP startup accepted a stale last-known-good daemon snapshot while rebuilding the
current snapshot. That daemon dropped unresolved ACP questions after 120 seconds.
ACP sessions now require the current content-addressed runtime snapshot. REST
sessions retain the last-known-good compatibility policy.

TDD evidence:

- Provisioning request options and default timeout: RED before `6c9db9051`,
  GREEN after `6c9db9051`.
- Runtime-freshness module: **0 pass / 1 fail** before implementation.
- Session-sandbox policy: **9 pass / 2 fail** before implementation.
- Runtime-freshness module: **3 pass / 0 fail** after implementation.
- Session-sandbox policy: **11 pass / 0 fail** after implementation.

Post-fix verification:

- SDK typecheck: exit 0.
- SDK suite: **1260 pass / 0 fail** with **5630** assertions.
- SDK packed-install smoke: pass.
- API typecheck: exit 0.
- White-label typecheck and production build: exit 0.
- White-label suite: **57 pass / 3 skip / 0 fail** with **182** assertions.
- White-label SDK boundary: **0 violations**.
- Real local ACP and REST presentation plus question parity: **1 pass** in
  **12.4 minutes**.
- The ACP question remained visible after 121 seconds and a page reload.
- Both transports submitted Beta and rendered `QUESTION_BETA`.
- ACP used `session/prompt` and sent zero `/prompt_async` requests.
- REST used `/prompt_async` and sent zero `/kortix/acp/` requests.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.
- `git diff --check`: exit 0.

**Status:** FOLLOW-UP IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** Follow-up PR merge, Deploy Dev, deployed
SHA proof, and deployed ACP plus REST parity remain.
---

### 2026-07-26 — session `whitelabel-acp-reference` (deployed parity completion)

The first deployed parity run exposed a fixture funding defect.
The test changed only `credit_accounts.balance`.
Billing reads `balance_precise` and `non_expiring_credits_precise`.
Both precise fields retained the default `$1.00` balance.

The corrected fixture seeds `$100.00` into the rounded and precise wallet
fields. The test rejects `Out of credits`.

The deployed screenshot comparison also exposed a REST synchronization defect.
The REST prompt reached `/prompt_async`, but the UI became idle before the first
SSE status event. The SDK did not start its 10-second reconciliation fallback.
The transcript therefore contained only the user message at the screenshot
point.

`useSession()` now marks an accepted REST prompt busy before the first SSE event.
The session synchronization controller polls the transcript and runtime status
until the runtime reports idle. Failed sends and explicit cancellation clear the
optimistic busy state.

The parity specification now requires:

- one rendered assistant message per transport;
- one rendered tool card per transport;
- no `Out of credits` transcript;
- ACP question persistence after 121 seconds and reload;
- `QUESTION_BETA` after both question replies;
- zero REST prompt calls from ACP;
- zero ACP prompt calls from REST.

TDD evidence:

- Deployed screenshot RED: REST had no assistant message or tool card.
- Focused unit RED: missing `beginRestPromptObservation` export.
- Focused unit GREEN: **20 pass / 0 fail** with **43** assertions.

Final verification:

- SDK typecheck and example typecheck: exit 0.
- SDK suite: **1261 pass / 0 fail** with **5632** assertions.
- SDK packed-install smoke: pass.
- White-label typecheck and dev-API production build: exit 0.
- White-label suite: **57 pass / 3 skip / 0 fail** with **182** assertions.
- White-label SDK boundary: **0 violations**.
- Test-harness typecheck: exit 0.
- Strong deployed ACP and REST presentation plus question parity:
  **1 pass / 0 fail** in **14.1 minutes**.
- ACP sent **2** ACP prompts and **0** REST prompts.
- REST sent **2** REST prompts and **0** ACP prompts.
- ACP rendered **29** real tool cards.
- REST rendered **32** real tool cards.
- Both screenshots contain completed presentation tool sequences.
- Both transports submitted Beta and rendered `QUESTION_BETA`.
- The stale project `81050937-bc7f-4b05-aafb-914acc019fe4` was archived
  through `@kortix/sdk`.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.
- `git diff --check`: exit 0.

**Status:** DEPLOYED PARITY COMPLETE.

**Shippable to production: NOT YET.** The synchronization correction still
requires PR merge, Deploy Dev, deployed SHA proof, and one post-deploy smoke.

---

### 2026-07-26 — session `whitelabel-acp-stable-completion` (B23 claim)

Claimed the intermittent ACP false-completion gap exposed by the deployed
white-label parity screenshots.

The SDK will keep prompt completion monotonic across the JSON-RPC result and
late ACP tool, text, or reasoning updates. The parity gate will require stable
completion and a complete presentation artifact on both transports.

Implementation will follow RED -> GREEN -> REFACTOR. Required gates are the
focused SDK test, full SDK typecheck, suite, packed-install smoke, white-label
typecheck, build, suite, SDK boundary, test-harness typecheck, local ACP and REST
parity, PR merge, Deploy Dev, deployed SHA proof, and deployed parity.

**Status:** IN PROGRESS.

---

### 2026-07-26 — session `agent-sandbox-environments` (claim)

Claimed the user-directed per-agent sandbox environment contract. The additive
SDK field will expose `agents.<name>.sandbox` from `kortix.yaml`. Session
creation will resolve an explicit session override first, then the selected
agent environment, then the project default, then the platform default.

The central session path will apply this contract to manual sessions, triggers,
schedules, and channels. Replacement runtimes will retain the resolved sandbox
template. Existing public names and required fields remain unchanged.

Implementation will follow RED -> GREEN -> REFACTOR. Required SDK gates are the
full typecheck, test suite, and packed-install smoke.

**Status:** IMPLEMENTED — `7174dddc4`.

---

### 2026-07-26 — session `agent-sandbox-environments` (completion)

Added `agents.<name>.sandbox` as an optional SDK and manifest field. The server
now resolves session templates in this order:

1. Explicit session `sandbox_slug`.
2. Selected agent `sandbox`.
3. Project `sandbox.default`.
4. Platform `default`.

The central session-create path applies the result to manual sessions,
triggers, schedules, and channels. The server persists the resolved slug in
`project_sessions.metadata.sandbox_slug`. Runtime-open, unmaterialized-runtime
replacement, and restart allocation paths reuse this persisted value. Custom
templates cannot boot through a pinned project-default external template ID.

The dashboard agent editor now exposes the field as **Environment**. The new
session composer now sends `sandbox_slug` only for an explicit user override.
Manifest validation checks slug syntax. The agent-config API checks the slug
against manifest-defined and dashboard-managed templates before committing it.

TDD evidence:

- Manifest RED: `agents.researcher.sandbox` was not part of the v2 schema.
- API parser RED: the parsed `AgentSpec` had no `sandbox` value.
- Precedence RED: the new `session-sandbox-metadata` module did not exist.
- Provider RED: a custom image still selected the pinned default template ID.
- SDK RED: `AgentConfigBlock` rejected `{ sandbox: "ml" }`.
- Web RED: the agent editor had no environment control and the composer sent
  the project default as an explicit override.
- GREEN: manifest **324 pass / 0 fail**.
- GREEN: focused API **66 pass / 0 fail**.
- GREEN: focused web **17 pass / 0 fail**.
- GREEN: starter **45 pass / 0 fail**.

SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit 0.
- `pnpm --filter @kortix/sdk test`: **1262 pass / 0 fail**, **5633**
  assertions.
- `pnpm --filter @kortix/sdk run smoke:install`: packed install and Node ESM
  import passed.

Additional gates:

- `pnpm --filter @kortix/manifest-schema typecheck`: exit 0.
- `pnpm --filter kortix-api typecheck`: exit 0.
- Focused web ESLint: exit 0.
- `pnpm --filter @kortix/starter typecheck`: exit 0.
- `git diff --check`: exit 0.

Real local proof used disposable project
`d6a155db-3ab5-44b2-aa26-0ffb7df42042`:

- Agent-config GET returned `block.sandbox = "ml"`.
- Manual session `e4ef1acd-44cb-4ad8-934a-169b95b7d4ca` persisted `ml`.
- Scheduled session `bddc4c18-de6b-485f-bb5b-32aaadcc2f85` persisted `ml`.
- Explicit override session `c046cc69-68b7-4ef1-8d05-ecd41dce1dde`
  persisted `default`.
- Both inherited sessions reached `active` on Platinum.
- Both inherited sessions used content hash
  `3e41f3954ec150c409e145f73c22de3c335f534713ea39981b562805bbc781bf`.
- Restarting the two unmaterialized rows allocated runtimes with the persisted
  `ml` environment.
- Established runtime identity remains immutable. Provider-confirmed loss
  returns `409 SESSION_RUNTIME_IDENTITY_UNAVAILABLE`; it does not create a
  replacement with a different external ID.
- Cleanup archived all three session rows, removed all three provider
  sandboxes, deleted the template, purged the managed repository, archived the
  project, and deleted the Supabase user.

Browser discovery returned `[]`. The Environment selector interaction, outgoing
PUT payload, and saved visible value remain unverified in a real browser.

**Shippable to production: YES.** The implementation, SDK package, API path,
provider allocation, generated schemas, starter artifact, and source-level web
contract pass. Browser interaction remains a deployment verification item.

---

### 2026-07-26 — session `warm-project-session` (B22 claim)

Claimed the additive SDK surface for server-owned warm project sessions.

The API will enforce one available empty warm session per project and user.
The project index will prefetch its runtime and claim it before navigation.
The existing daemon refresh operation will synchronize a reused warm workspace
to the latest base branch without restarting OpenCode.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are SDK typecheck, full SDK tests, packed-install smoke, API tests,
ke2e coverage, local API proof, browser proof, PR merge, Deploy Dev, deployed SHA
proof, and deployed browser proof.

**Status:** COMPLETE — `13167d7cf`.

---

### 2026-07-26 — session `whitelabel-acp-stable-completion` (B23 local completion)

Completed the monotonic ACP and REST prompt-settlement implementation in
`7a546585c`.

ACP `send()` now resolves after the prompt result and a 500-millisecond quiet
period. Late assistant, tool, question, and permission updates restart or block
that settlement. Prompt queue serialization waits for full settlement.

REST prompt observation now belongs to `SessionSyncController`. Premature idle
events do not clear the public busy state. Late busy events cancel the
500-millisecond settlement timer. Status reconciliation and SSE events use the
same controller.

TDD evidence:

- ACP RED: `send()` resolved before delayed tool updates reached the transcript.
- REST RED: `beginPromptObservation()` did not exist.
- Focused REST GREEN: **40 pass / 0 fail** with **113** assertions.
- Preview RED: expected status `200`; received `502`.
- Preview GREEN: **7 pass / 0 fail** with **36** assertions.

Post-rebase gates:

- SDK typecheck: exit 0.
- SDK suite: **1268 pass / 0 fail** with **5662** assertions across **105**
  files.
- SDK packed-install smoke: pass.
- White-label typecheck: exit 0.
- White-label suite: **57 pass / 3 skip / 0 fail** with **182** assertions.
- White-label SDK boundary: **0 violations**.
- White-label dev-API production build: exit 0.
- Test-harness typecheck: exit 0.
- `git diff --check`: exit 0.

Post-rebase live ACP and REST presentation plus question parity:

- Playwright: **1 pass / 0 fail** in **13.5 minutes**.
- ACP sent **2** ACP prompts and **0** REST prompts.
- REST sent **2** REST prompts and **0** ACP prompts.
- ACP rendered **34** completed tool cards.
- REST rendered **28** completed tool cards.
- Tool-card parity ratio: **0.824**.
- ACP created `/workspace/marko-kraemer.pptx` at **231,898 bytes**.
- REST created `/workspace/marko_kraemer.pptx` at **228,064 bytes**.
- Both transports persisted the question flow and rendered `QUESTION_BETA`.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed ACP plus REST parity remain.

---

### 2026-07-26 — session `use2-session-readiness` (B26 and B27 completion)

Completed both US shadow readiness fixes in PR #5529.

- `claimWarmProjectSession()` keeps the recoverable configuration `409` out of
  the global error sink.
- The IAM custom-policy read retries one transient database failure.
- Database error logging extracts the nested PostgreSQL cause from a wrapped
  `DrizzleQueryError`.
- The US shadow deployment requires managed models.

Verification:

- Merge commit: `5c0ae97ec7676f3cd439f7f19db154b53602feda`.
- Deploy Dev run `30222230764`: success for the exact merge commit.
- SDK typecheck: exit 0.
- SDK suite: **1280 pass / 0 fail** with **5707** assertions.
- SDK packed-install smoke: pass.
- API typecheck: exit 0.
- Focused API tests: **40 pass / 0 fail** with **82** assertions.
- US API: `0.10.16-dev.5c0ae97e`.
- US ECS API: task definition revision `11`, desired `2`, running `2`,
  pending `0`, rollout `COMPLETED`.
- US frontend: Vercel deployment
  `dpl_DSe54pvhXpCgUyG7wVWnb7VdNm9M`.
- Deployed real runtime flow: exact `PONG` and Files view loaded.
- Deployed warm mismatch flow: typed `409`, normal session creation, exact
  `PONG`, no global mismatch error, **27.4 seconds**.

Production routing and production data were unchanged.

**Status:** COMPLETE.

**Shippable to production: YES.**

---

### 2026-07-27 — session `acp-message-turns` (B29 implementation)

Preserved ACP upstream `messageId` values in the projected transcript.

- User and assistant chunks now retain their upstream message IDs.
- Text and reasoning chunks now update their owning assistant message.
- A new upstream assistant message completes the previous assistant message.
- Late tool updates now find the assistant message that owns the matching
  `callID`.
- ACP events without `messageId` still use generated IDs.

TDD and local verification:

- Implementation commit: `60b06c6e41f82d786f24095d366876483af85b68`.
- Focused projection and controller suite: **27 pass / 0 fail** with **75**
  assertions.
- SDK typecheck: exit 0.
- SDK suite: **1299 pass / 0 fail** with **5756** assertions.
- SDK packed-install smoke: pass.
- `git diff --check`: exit 0.
- Supplied transcript replay produced **1** user message and **18** separate
  assistant messages.
- The replay preserved upstream assistant IDs and tool-call ownership.
- Local Chromium ACP flow: **1 pass / 0 fail** in **58.3 seconds**.
- The browser flow covered prompt streaming, hard reload, permission response,
  question response, and the absence of REST `/prompt_async`.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed ACP transcript verification remain.

---

### 2026-07-27 — session `session-message-revert` (B30 local completion)

Implemented message-based session rewind and restore in `eab4eef0f`.

The implementation keeps one canonical OpenCode session. It does not create a
fork. Native REST uses `session.revert` and `session.unrevert`. ACP uses the
Kortix `session/revert` and `session/unrevert` extensions. The daemon forwards
both ACP extensions to native OpenCode history routes.

ACP transcript replay preserves native OpenCode message IDs. The controller
resolves an optimistic `acp-user-*` ID to its canonical `msg_*` ID before
rewind. REST transcript synchronization keeps removed messages hidden until
cleanup completes. The next accepted prompt commits the replacement path.

`useSession` now exposes `rewindMessageId`, `rewindPending`, `rewindError`,
`rewind(messageId)`, and `restoreRewind()`. The web session UI adds Edit,
confirmation, replacement composer prefill, staged-rewind status, and Restore.

TDD evidence:

- RED: the core rewind projection helper did not exist.
- RED: the ACP client had no revert or unrevert extension methods.
- RED: ACP transcript replay generated local IDs instead of native `msg_*` IDs.
- RED: the ACP controller had no reversible rewind state.
- RED: `useSession` had no provider-agnostic rewind contract.
- RED: the web message action still contained `TODO(session-rewind)`.
- GREEN focused SDK, daemon, and web suite: **145 pass / 0 fail**.
- GREEN ACP controller after optimistic-ID resolution: **20 pass / 0 fail**.

SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit 0.
- `pnpm --filter @kortix/sdk test`: **1309 pass / 0 fail**, **5779**
  assertions across **111** files.
- `pnpm --filter @kortix/sdk run smoke:install`: packed install and Node ESM
  import passed.

Daemon and web gates:

- `pnpm --filter @kortix/sandbox-agent-server typecheck`: exit 0.
- `pnpm --filter @kortix/sandbox-agent-server test`: **306 pass / 0 fail**,
  **739** assertions across **33** files.
- Web source contract: **5 pass / 0 fail**, **11** assertions.
- Touched web ESLint: exit 0.
- Web `tsc --noEmit`: zero errors in the three touched session files. Two
  existing errors remain in `template-url.test.ts`.
- `git diff --check`: exit 0.

Local browser proof:

- Playwright ACP runtime canary: **1 pass / 0 fail**. The test ran for **1.6
  minutes**. Total runtime was **6.8 minutes** including snapshot provisioning.
- The canary verified Edit, destructive confirmation, `session/revert`,
  transcript truncation, replacement prefill, Restore, `session/unrevert`,
  replacement send, and old-path deletion.

Live local REST and ACP proof used one disposable canonical OpenCode session:

- ACP session: `ses_05b51aa3affeB0XyuUkhYt8L6n`.
- ACP rewind message: `msg_fa4ae82cc001LquUy2MNmLt5T5`.
- ACP restore: `true`.
- ACP replacement: `true`.
- ACP file result: `ACP_REWIND_REPLACEMENT`.
- REST session: `ses_05b51aa3affeB0XyuUkhYt8L6n`.
- REST rewind message: `msg_fa4aed6ad001VvRt8OASgvwlmU`.
- REST restore: `true`.
- REST replacement: `true`.
- REST file result: `REST_REWIND_REPLACEMENT`.
- Smoke result: `PASS`.

**Status:** LOCAL IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed REST, ACP, and web verification remain.

---

### 2026-07-27 — session `acp-idle-query-override` (B31 claim)

Claimed the ACP page override and stale-tool settlement defect.

`?acp` will override the server-selected runtime transport for one session page.
It will not mutate `experimental.acp_runtime`.
The SDK will keep genuine active tools busy.
The SDK will settle stale running tools after a newer assistant message and the
final prompt result.
Queued prompts will dispatch after settlement.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are focused SDK and web tests, full SDK typecheck, full SDK suite,
packed-install smoke, local Chromium ACP proof, PR merge, Deploy Dev, deployed SHA
proof, and deployed ACP-only network proof.

**Status:** IN PROGRESS.

---

### 2026-07-27 — session `acp-idle-query-override` (B31 local completion)

Implemented page-scoped ACP transport selection and stale-tool settlement in
`d3544ae14`.

`UseSessionOptions.runtimeTransport` is an additive per-hook override.
The session page passes `acp` only when the URL contains `?acp`.
The page does not mutate `experimental.acp_runtime`.
The SDK policy keeps one AI transport mounted.
The ACP policy disables OpenCode REST events, session listing, message sync, and
`promptAsync`.

A newer assistant message now closes unresolved tools from the previous assistant
message.
The 500-millisecond quiet period still blocks early idle while the current
assistant message contains a genuine active tool.
Queued prompts dispatch after stale tools settle.
Transcript reload starts idle when an older assistant message contains a stale
running tool.

TDD evidence:

- RED focused SDK: **36 pass / 4 fail**.
- RED web routing contract: **4 pass / 1 fail**.
- GREEN focused SDK: **40 pass / 0 fail**.
- GREEN web routing contract: **5 pass / 0 fail**.

Required gates:

- `pnpm --filter @kortix/sdk typecheck`: exit 0.
- `pnpm --filter @kortix/sdk test`: **1312 pass / 2 skip / 0 fail** with
  **5785** assertions across **111** files.
- `pnpm --filter @kortix/sdk run smoke:install`: packed install and Node ESM
  import passed.
- Touched web ESLint: exit 0.
- Web `tsc --noEmit`: no errors reference the touched files. Existing unrelated
  repository errors keep the full command at exit 1.
- `git diff --check`: exit 0.

The ACP browser canary now opens a server-selected REST session with `?acp`,
asserts ACP-only AI traffic, then removes `?acp` and asserts REST rollback.
The in-app browser runtime returned no available browsers.
The local Chromium canary remains unexecuted.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed UI verification remain.

---

### 2026-07-28 — session `acp-session-name-sync` (B32 claim)

Claimed the Kortix session-name synchronization defect for ACP-backed sessions.

The investigation will trace the authoritative server-side title mirror,
ACP runtime session metadata, project-session reads, SDK query invalidation,
and sidebar rendering.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are focused API, SDK, and web tests, API and SDK typechecks,
the full SDK suite, packed-install smoke, local browser proof, PR merge,
Deploy Dev, deployed SHA proof, and deployed session-name synchronization.

**Status:** IN PROGRESS.

---

### 2026-07-28 — session `acp-multi-harness` local completion

Implemented project-gated ACP transport and OpenCode, Claude Code, Codex, and Pi
harness support.

The existing `acp_runtime` experiment is the single rollout gate.
The visible experiment name is `ACP & Multi-Harness`.
Project manifests use `kortix_version: 3` runtime profiles and logical agents.
Project-session ACP identity is immutable.
ACP envelopes persist in PostgreSQL with database ordinals as SSE cursors.
Upstream deduplication is scoped by runtime instance.
Triggers and automations deliver ACP prompts through the durable session
lifecycle queue.

A cold Daytona snapshot took `379,773 ms`.
The previous detached initial-prompt delivery stopped after `300,000 ms`.
The durable queue fix now survives this cold-build window.

Local verification:

- Daemon suite: exit `0`.
- Daemon typecheck: exit `0`.
- API ACP tests: **28 pass / 0 fail** with **77** assertions.
- API typecheck: exit `0`.
- SDK typecheck: exit `0`.
- SDK suite: **1347 pass / 0 fail** with **5855** assertions across **113**
  files.
- SDK packed-install smoke: pass.
- Manifest, shared, API-contract, CLI schema, and web helper gates: exit `0`.
- Route coverage: **507/517** routes, **10** allowlisted, **0** uncovered.
- `COV-10`: **1/1** passed against `http://localhost:19108/v1`.
- Real Daytona smoke: **4/4** harnesses passed.
- Smoke cleanup: OpenCode, Claude Code, Codex, and Pi sessions are `stopped`
  with `deletedAt`.
- Touched web ESLint: exit `0`.
- `git diff --check`: exit `0`.

The connected-provider row no longer renders the model-dependent provider-key
verification action.
The backend verification route remains available for existing SDK consumers.

The in-app browser runtime returned no available browsers.
Rendered agent selection and provider-row verification remain unexecuted.

**SDK shippable to production: YES.**

**Feature delivery status: NOT YET.**
PR merge, Deploy Dev, deployed SHA proof, and deployed protocol verification
remain.

---

### 2026-07-28 — session `acp-multi-harness` deployed completion

Completed repository delivery and deployed protocol verification.

PR #5749 merged as `239cda8a2c7b8e3862cae5d968224c1baf1d0a02`.
Its 25 executed checks passed.
The superseding Deploy Dev run `30402685106` deployed API and frontend commit
`8e86e27d045b8349eaf7dc9cfba47086e93cfaf8`.
Git confirmed that the feature merge is an ancestor of that deployed commit.

The first deployed smoke found two environment and restart conditions:

- The dev platform OpenAI key returned `401 invalid_api_key`.
- A Daytona stop/start changed its preview ingress credential.
  Another API replica could retain the old credential for five minutes.

The smoke runner now accepts a disposable project model override and an optional
temporary OpenAI key.
The local encrypted OpenAI key returned HTTP `200` from `GET /v1/models`.
PR #5759 added one ACP ingress refresh-and-retry after `401` or `403`.
It also retries prompt env synchronization after the same authentication
rejection.
PR #5759 merged as `35d4063c954176338e809abc4329e43410786122`.
Its 15 executed checks passed.
Deploy Dev run `30406252134` completed successfully for that exact SHA.
`GET https://dev-api.kortix.com/v1/health` reported:

- `environment`: `dev`
- `version`: `0.11.1-dev.35d4063c`
- `commit`: `35d4063c954176338e809abc4329e43410786122`

Deployed Daytona protocol smoke against
`https://dev-api.kortix.com/v1` reported:

- OpenCode: pass.
- Claude Code: pass.
- Codex: pass.
- Pi: pass.
- Final result: **4/4 harnesses passed**.

Each harness verified its headless prompt, follow-up prompt, transcript reload,
immutable harness identity, in-place restart, post-restart prompt, and persisted
ACP identity.

The disposable fixture project was
`196ff19b-dfa1-4aae-98eb-9fa5138446b6`.
Cleanup verification found:

- Project status: `archived`.
- OpenCode, Claude Code, Codex, and Pi session status: `stopped`.
- Four session sandbox rows: `archived`.
- Matching sandbox rows: `0`.

The connected-provider row no longer exposes the model-dependent verification
action.
The SDK verification route remains compatible.
The in-app browser runtime exposed no browser.
Rendered provider-row verification remains unexecuted.

**Status:** COMPLETE.

**Shippable to production: YES.** Local suites, CI, merge, deployed SHA,
deployed four-harness protocol behavior, restart recovery, and fixture cleanup
all pass.

---

### 2026-07-28 — session `acp-multi-harness-system-docs` claim

Claimed the multi-harness documentation and agent-discovery follow-up.

The SDK change is documentation-only. It will replace the stale statement that
ACP uses only OpenCode. It will document the server-selected OpenCode, Claude
Code, Codex, or Pi harness without changing the public SDK surface.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** IN PROGRESS.

---

### 2026-07-28 — session `acp-multi-harness-system-docs` local completion

Completed the SDK documentation update for the server-selected OpenCode,
Claude Code, Codex, or Pi harness.

No SDK export or runtime implementation changed.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1356 pass`, `0 fail`,
  `5929 expect() calls`, `116 files`.
- `pnpm --filter @kortix/sdk run smoke:install`: packed tarball imported and
  constructed successfully.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-01 — session `e2b-capacity-fast-fail` (claim)

Claimed the additive provider-neutral session-start capacity failure contract.
The API will stop retrying deterministic provider capacity errors.
The SDK will expose the terminal failure without removing or renaming any public field.
The web will preserve the pending prompt and show Retry, Copy Prompt, and Delete actions.

Work follows RED -> GREEN -> REFACTOR.
The full SDK typecheck, test, and packed-install smoke gates are required.

**Status:** IN PROGRESS.

---

### 2026-07-29 — session `acp-runtime-adapters` multi-harness starter claim

Claimed the additive `acp-multi-harness` starter input.

The public `CreateProjectRepoInput` and `ProvisionProjectInput` unions must
accept the new starter identifier. Existing identifiers remain unchanged.

The required `tdd` skill is unavailable in this session. The work still uses
RED, GREEN, and REFACTOR.

Required SDK gates are typecheck, the full test suite, and packed-install
smoke.

Local SDK verification:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1355 pass`, `2 skip`, `0 fail`, and
  `5925` assertions across `116` files.
- `pnpm --filter @kortix/sdk run smoke:install`: packed tarball import and
  construction passed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

**Repository delivery shippable to production: NOT YET.** Main integration,
PR merge, Deploy Dev, deployed SHA proof, and deployed four-harness verification
remain.

---

### 2026-07-29 — session `acp-multi-harness-system-docs` deployed completion

Completed repository delivery and deployed verification for the multi-harness
documentation and agent-discovery follow-up.

Delivery evidence:

- PR #5768 merged as
  `3b3992fbbae6d71ab3097dfac722fdafc54b02ba`.
- All required PR checks passed.
- Deploy Dev run `30411098518` completed with `success`.
- The run built and published the CLI, API image, and frontend image.
- `GET https://dev-api.kortix.com/v1/health` returned version
  `0.11.1-dev.3b3992fb` and the exact merge commit.
- The `dev-latest` Git tag resolved to the exact merge commit.
- The shipped macOS arm64 CLI reported
  `Kortix CLI v0.11.1-dev.3b3992fb`.

Deployed agent-discovery verification:

- `kortix system-skills --host kortix-internal-dev --json` returned 10 system
  skills.
- `kortix system-skills get kortix-system --full --json` returned 19 reference
  files.
- The deployed `references/kortix/runtime-harnesses.md` file contained OpenCode,
  Claude Code, Codex, Pi, the real-model rule, and the four-harness smoke command.

Deployed protocol verification used one disposable Platinum project:

- OpenCode: pass.
- Claude Code: pass.
- Codex: pass with a temporary direct project `OPENAI_API_KEY`.
- Pi: pass with the same temporary direct project credential.

Each harness verified its headless prompt, follow-up prompt, transcript reload,
immutable harness identity, in-place restart, post-restart prompt, and persisted
ACP identity.

The first Codex attempt proved the dev managed OpenAI credential is invalid.
The Codex harness reached
`https://dev-api.kortix.com/v1/router/openai/responses`, which returned
`401 invalid_api_key`. The exact Codex harness passed after the disposable
project received a direct OpenAI credential. No generic provider preflight was
used as acceptance evidence.

Cleanup verification:

- Project status: `archived`.
- Five session rows: `stopped`.
- Five sandbox rows: `archived`.
- Five Platinum sandbox IDs returned `404`.
- The managed GitHub repository returned `404`.
- The Supabase test user count was `0`.
- The test PAT and all five connector tokens were revoked.
- The temporary `OPENAI_API_KEY` project secret was deleted.

**Status:** COMPLETE.

**Shippable to production: YES.** Local gates, CI, merge, Deploy Dev, deployed
SHA, shipped CLI discovery, deployed four-harness behavior, and fixture cleanup
all pass. The dev managed OpenAI credential remains an environment issue.

---

### 2026-07-29 — session `acp-multi-harness-selector` SDK snapshot claim

Claimed the additive `BillingState` public type-surface snapshot repair.

`origin/main` exports `BillingState` from the root and `./projects-client`
entry points. The committed snapshot omits both names.

The existing public type-surface test is the RED test.
The required `tdd` skill is unavailable in this session.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** IN PROGRESS.

---

### 2026-07-29 — session `acp-multi-harness-selector` SDK snapshot completion

Added the additive `BillingState` name to the root and `./projects-client`
public type-surface snapshots.

TDD evidence:

- RED: `pnpm --filter @kortix/sdk exec bun test
  src/public-type-surface.test.ts` reported `0 pass`, `1 fail`, and only two
  additive `BillingState` entries.
- GREEN: the same focused command reported `1 pass`, `0 fail`, and `2`
  assertions.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1356 pass`, `0 fail`, `5929` assertions,
  `116` files.
- `pnpm --filter @kortix/sdk run smoke:install`: packed tarball imported and
  constructed successfully.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-07-29 — session `acp-runtime-adapters` final local verification

The final branch retains the additive `acp-multi-harness` starter input.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1357 pass`, `0 fail`, `5931`
  assertions, and `116` files.
- `pnpm --filter @kortix/sdk run smoke:install`: the packed tarball imported
  and constructed successfully.

**SDK package shippable to production: YES.**

**Repository delivery shippable to production: NOT YET.** PR merge, Deploy Dev,
deployed SHA proof, and deployed four-harness verification remain.

---

### 2026-07-29 — session `generic-acp-session-identity` SDK claim

Claimed the preassigned OpenCode session identity compatibility task.

Scope:

- Treat the `/start` response as the authoritative runtime identity.
- Keep `initialOpenCodeSessionId` as a backward-compatible cache seed.
- Prevent SDK caches from crossing Kortix `(projectId, sessionId)` boundaries.
- Prove two sandboxes restored from one snapshot receive distinct OpenCode IDs.

The required `tdd` skill is unavailable in this session.
The implementation used the same RED, GREEN, and REFACTOR sequence directly.

TDD evidence:

- IndexedDB scope RED: the focused test failed because
  `idb-sync-cache-key` did not exist.
- IndexedDB scope GREEN: `3 pass`, `0 fail`.
- Transcript ownership RED: the focused test failed because
  `resolveSessionCacheOwnerScope` did not exist.
- Transcript ownership GREEN: `4 pass`, `0 fail`.
- Runtime switch gate RED: the focused source contract found no sandbox-switch
  gates in `useSession`.
- Runtime switch gate GREEN: the focused source contract passed.
- Runtime-action gate RED: the focused test failed because
  `isSessionRuntimeActionReady` did not exist.
- Runtime-action gate GREEN: the focused test passed.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1381 pass`, `0 fail`, `5970`
  assertions.
- `pnpm --filter @kortix/sdk run smoke:install`: the packed tarball installed,
  imported, and constructed successfully.
- The public export snapshot did not change.

Related repository gates:

- Starter typecheck: exit `0`.
- Starter tests: `51 pass`, `0 fail`.
- CLI typecheck: exit `0`.
- CLI tests: `553 pass`, `0 fail`.
- API typecheck: exit `0`.
- API focused tests: gateway base URL `6 pass`; starter create-repo `12 pass`;
  provision `10 pass`; scaffold identity `1 pass` with `182` assertions;
  project-session contract `45 pass` with `363` assertions.
- Web focused tests: `27 pass`, `0 fail`.
- Web focused ESLint: exit `0`.

Live local acceptance:

- Evidence:
  `tests/performance/session-start/results/2026-07-29/opencode-fork-isolation-local-platinum.json`.
- Provider: Platinum.
- Result: `PASS 2/2`.
- Create-to-ready: `21.460 s` and `23.736 s`.
- `/start` returned distinct OpenCode roots:
  `ses_050ddca47ffe4r8L0yDak7Fiar` and
  `ses_050ddd663ffe159AjQGlKxefsg`.
- `createKortix().session().ensureReady()` matched each `/start` root.
- Restart preserved each root.
- Each transcript contained only its own three assistant markers.
- Fixture cleanup left zero projects and zero users.

Rebased local acceptance on `origin/main` `d627167f`:

- Evidence:
  `tests/performance/session-start/results/2026-07-29/opencode-fork-isolation-local-platinum-rebased.json`.
- The smoke converted the canonical version 3 starter into a disposable
  version 2 OpenCode REST fixture through a temporary project-scoped PAT.
- Result: `PASS 2/2` on Platinum.
- Create-to-ready: `21.758 s` and `23.266 s`.
- `/start` returned distinct OpenCode roots:
  `ses_050be4bb6ffepNq9BLE8kdybL9` and
  `ses_050be472cffeLbJ7ciXGs8smOL`.
- The public SDK matched both authoritative `/start` roots.
- Restart preserved both roots.
- Each assistant transcript contained only its own three markers.
- Fixture cleanup left zero projects and zero users.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

**Repository delivery shippable to production: NOT YET.** PR merge, Deploy Dev,
deployed SHA proof, and deployed isolation verification remain.

---

### 2026-07-29 — session `sdk-inherited-session-defaults` follow-up claim

Claimed the live inherited OpenCode session default compatibility follow-up.

Live dev evidence on merge `7a7bb4f16`:

- Three distinct Platinum sandboxes inherited
  `ses_050fadf1dffeb2XyPZiu0qloal`.
- SDK routing kept each user marker in its own sandbox transcript.
- The first SDK prompt used the stale snapshot model
  `opencode/big-pickle` and produced no assistant message.
- A direct prompt with the persisted project-session model
  `kortix/glm-5.2` unblocked each session.
- Both sessions then passed follow-up, restart, and post-restart SDK sends.

Scope:

- Resolve the persisted project-session model and agent before a default SDK
  `send`.
- Keep explicit per-call and handle-level SDK overrides authoritative.
- Accept an equal inherited OpenCode ID when sandbox and transcript ownership
  remain isolated.
- Make the disposable live smoke tolerate project manifest convergence without
  hiding product failures.

The required `tdd` skill is unavailable in this session.
The implementation will use the same RED, GREEN, and REFACTOR sequence
directly.

The current CLI command router already used the SDK-backed runtime modules. The
revert left two orphaned host-local transport files and three orphaned tests.
Removing those files restores the enforced SDK boundary without changing the
current command surface.

```
RED    pnpm --filter @kortix/cli lint:sdk-boundary
       → 18 violations
GREEN  pnpm --filter @kortix/cli lint:sdk-boundary
       → 0 violations
       pnpm --filter @kortix/cli test
       → 636 pass, 0 fail, 2,068 assertions
       exact packages-and-apps CI command
       → exit 0
       pnpm --filter @kortix/sdk typecheck
       → exit 0
       pnpm --filter @kortix/sdk test
       → 1,412 pass, 2 skip, 0 fail, 6,128 assertions
       pnpm --filter @kortix/sdk smoke:install
       → packed tarball imports and constructs; exit 0
```

The separate API test bootstrap repair also passes:

```
bun test --isolate --env-file=scripts/test.env \
  src/__tests__/e2e-project-session-contract.test.ts
→ 52 pass, 0 fail, 367 assertions

pnpm --filter kortix-api test
→ 5,028 pass, 57 skip, 0 fail, 20,369 assertions
```

No SDK source, export, public type, snapshot, dependency, or version changed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-07-30 — session `opencode-rest-rollback` completion

Removed the ACP SDK client, projection, controller, runtime transport selector,
React runtime hook, public types, and package exports. `useSession` now owns one
OpenCode REST lifecycle. The current session cache, transcript hydration,
default-model resolution, reconnect, and session-switch behavior remain.

Public-surface decision:

- ACP exports are removed intentionally.
- The user requested complete ACP removal.
- The public value and type snapshots record the removal.
- No compatibility alias remains.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1318 pass`, `0 fail`, `5781`
  assertions across `113` files.
- `pnpm --filter @kortix/sdk run smoke:install`: the packed tarball installed,
  imported, and constructed successfully.
- Public value and type surface snapshots pass.
- The framework-free import-graph checks pass.

Related REST rollback gates:

- Manifest schema: typecheck passed; V2 suite passed.
- Starter: typecheck passed; `48 pass`, `0 fail`.
- API contract: typecheck passed; `45 pass`, `0 fail`.
- Shared runtime versions: typecheck passed; `269 pass`, `0 fail`.
- Sandbox agent server: typecheck passed; `267 pass`, `0 fail`.
- CLI: typecheck passed; `556 pass`, `0 fail`.
- Web: `2424 pass`, `0 fail`; affected-file ESLint passed.
- White-label demo: `335 pass`, `3 skip`, `0 fail`; production build passed.
- Test-harness typecheck: exit `0`.
- Authenticated local curl: `25 pass`, `0 fail`; V2 validation returned
  `valid:true`; V3 returned `valid:false`; all five former ACP session routes
  returned `404`; a real OpenCode REST prompt returned `PONG`.
- Local Chromium OpenCode REST session chat: `2 pass`, `0 fail`. The browser
  used `/prompt_async` and `/global/event`, rendered `PONG`, sent no ACP
  requests, and completed Files navigation plus warm-session fallback.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

**Repository delivery shippable to production: NOT YET.** The branch merge,
direct `main` push, Deploy Dev SHA proof, and deployed REST verification remain.

---

### 2026-07-29 — session `sdk-inherited-session-defaults` follow-up completion

Completed the inherited OpenCode session compatibility fix in `a900fc605`.

The SDK now reads the persisted project-session model and agent before the
first default OpenCode REST `send()` on a handle. Per-call choices override
handle choices. Handle choices override persisted defaults. `changeModel()`
invalidates the cached persisted defaults. A failed defaults read clears the
cache so the next `send()` retries it.

The live smoke now treats the sandbox as the isolation boundary. It accepts an
equal snapshot-inherited `opencode_session_id` only when the Kortix sessions,
sandboxes, and transcripts remain isolated. The session-create helper retries
only the exact `409 ACP_RUNTIME_REQUIRED` manifest-convergence response.

TDD and focused evidence:

- RED: the inherited-session prompt omitted the persisted model and agent.
- GREEN: the prompt used `kortix/glm-5.2` and agent `kortix`.
- RED: `changeModel()` left the old persisted model cached.
- GREEN: the next prompt used the changed model.
- Focused SDK client suite: `71 pass`, `0 fail`, `258` assertions.
- Tests package typecheck: exit `0`.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1385 pass`, `0 fail`, `5978`
  assertions across `121` files.
- `pnpm --filter @kortix/sdk run smoke:install`: the packed tarball installed,
  imported, and constructed successfully.

Live dev Platinum acceptance:

- Evidence:
  `tests/performance/session-start/results/2026-07-29/opencode-inherited-pin-dev-platinum.json`.
- Result: `PASS 2/2`.
- Create-to-ready: `26.022 s` and `35.169 s`.
- Two distinct Kortix sessions and Platinum sandboxes inherited
  `ses_050fadf1dffeb2XyPZiu0qloal`.
- `createKortix().session().ensureReady()` matched the authoritative `/start`
  pin for both sandboxes.
- Both sessions passed first response, follow-up response, restart, and
  post-restart response using only SDK `send()`.
- Each transcript contained only its own three assistant markers.
- Fixture cleanup removed the project, sessions, account, and user.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

Repository delivery evidence:

- PR `#5848` merged as
  `d6979ad99241ebd8baeb00391dc186ce007b63e1`.
- All PR checks completed successfully.
- Deploy Dev run `30487926127` completed successfully for the merge SHA.
- `https://dev-api.kortix.com/v1/health` reported version
  `0.11.1-dev.d6979ad9` and commit
  `d6979ad99241ebd8baeb00391dc186ce007b63e1`.

**Repository delivery shippable to production: YES.**

---

### 2026-07-30 — session `opencode-rest-rollback` claim

Claimed the user-directed removal of ACP, multi-harness runtime support, and
`kortix.yaml` version 3.

The SDK session runtime will use OpenCode REST only. The rollback will restore
the release-branch OpenCode REST client behavior without reverting unrelated
client work. Existing published ACP names require an explicit compatibility
decision during the public-surface audit.

The required `tdd` skill is unavailable in this session. The implementation
will use RED, GREEN, and REFACTOR directly.

Required gates are the focused SDK RED/GREEN tests, SDK typecheck, full SDK
suite, packed-install smoke, API and sandbox-server tests, manifest version 2
tests, real local curl verification, real local browser session-chat
verification, branch merge, direct `main` push, Deploy Dev, deployed SHA proof,
and deployed OpenCode REST verification.

**Status:** IN PROGRESS.

**SDK package shippable to production: NOT YET.**

---

### 2026-07-31 — session `centralized-audit-log` claim

Claimed the additive centralized audit-log contract.

The SDK will expose account audit events with optional project, session, actor
type, source, outcome, request, and correlation fields. Existing audit event
fields and functions remain compatible.

The account audit list and export inputs will accept project and session
filters. The web host will consume this typed SDK contract.

The required `tdd` skill is unavailable in this session. The work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

RED evidence:

- The focused SDK test failed because `New agent` stopped the refresh loop.
- The focused API tests failed because serializers and title generation treated
  `New agent` as a real title.

GREEN evidence:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1390 pass`, `0 fail`, and
  `5971 expect() calls` across `117` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.
- API unit suite: `5074 pass`, `62 skip`, `0 fail`, and
  `20505 expect() calls` across `500` files.
- Focused real-PostgreSQL integration:
  `11 pass`, `0 fail`, and `27 expect() calls`.

No public field, type, export, or signature changed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

**Repository code shippable to production: YES.**

---

### 2026-07-30 — session `opencode-rest-title-preview-reliability` claim

Claimed the OpenCode REST session-title reconciliation regression reported on
PR #5901.

Scope:

- Reconcile a persisted server title when an existing session with messages is
  opened after the original post-send refresh window ended.
- Keep the bounded post-send refresh and the server-owned `metadata.name`
  contract.
- Fix the related API preview lookup separately without adding SDK transport
  behavior.

The required `tdd` skill is unavailable in this session. The work used the same
RED, GREEN, and REFACTOR sequence directly.

RED:

- `bun test src/react/session-title-sync.test.ts`: failed because
  `reconcileHydratedSessionTitle` was not exported.

GREEN:

- `bun test src/react/session-title-sync.test.ts`: `2 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1347 pass`, `0 fail`, `116 files`.
- `pnpm --filter @kortix/sdk run smoke:install`: packed tarballs installed,
  imported, and constructed successfully.

Live browser proof loaded a titleless cached session with one hydrated user
message. The sidebar changed from `New session` to `User Says Yo` without
navigation. The browser observed four list reads and two detail reads.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-07-30 — session `opencode-rest-rollback` post-merge verification

Re-ran the rollback gates after merging current `origin/main` into the worktree.
The earlier completion entry records pre-merge counts and is retained as history.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1340 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk run smoke:install`: the packed tarball installed,
  imported, and constructed successfully.

Final repository gates:

- Manifest schema: `341 pass`, `0 fail`.
- Database: `160 pass`, `3 skip`, `0 fail`.
- API typecheck: exit `0`.
- API: `4770 pass`, `57 skip`, `0 fail`.
- Sandbox agent server: `267 pass`, `0 fail`.
- Shared runtime versions: `269 pass`, `0 fail`.
- CLI: `559 pass`, `0 fail`.
- Starter: `48 pass`, `0 fail`.
- Web: `2563 pass`, `0 fail`.
- White-label demo: typecheck and production build passed; `281 pass`,
  `3 skip`, `0 fail`.
- Test-harness typecheck: exit `0`.
- Migration lint: `109` files; Squawk reported `42` files and `0` issues.
- Ke2e route coverage: `506/516` covered, `10` allowlisted, `0` uncovered.
- Authenticated local curl: `25 pass`, `0 fail`.
- Local REST contract smoke: `14 pass`, `0 fail`.
- Local Chromium: `2 pass`, `0 fail`. The session rendered `PONG`, used one
  `/prompt_async` request and `/global/event`, sent no `/kortix/acp/` request,
  opened the current-main Files side panel, and passed warm-session fallback.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

**Repository delivery shippable to production: NOT YET.** The direct `main`
push, Deploy Dev SHA proof, and deployed REST verification remain.

---

### 2026-07-30 — session `opencode-rest-rollback` final worktree verification

Verified the final rollback tree against `origin/main`
`b2477b5c2f4849fdf2c8786d29ebd5ff3629630f`.

Current SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1345 pass`, `0 fail`, `5894`
  assertions across `115` files.
- `pnpm --filter @kortix/sdk run smoke:install`: the packed tarball installed,
  imported, and constructed successfully.

Current repository evidence:

- API: `4844 pass`, `57 skip`, `0 fail`.
- CLI typecheck: exit `0`.
- CLI SDK boundary: `0` violations.
- CLI: `608 pass`, `0 fail`.
- Sandbox agent server typecheck: exit `0`.
- Sandbox agent server: `271 pass`, `0 fail`.
- Starter: `70 pass`, `0 fail`.
- Migration lint: `109` files passed.
- Squawk: `42` files, `0` issues.
- Ke2e route coverage: `506/516` covered, `10` allowlisted, `0` uncovered.
- Removal audit: no active ACP, multi-harness, runtime-harness, or manifest V3
  reference remains outside the forward-only drop migration and regression
  history.
- Authenticated local curl: the runtime reported `runtime_transport: rest`,
  OpenCode `1.17.11` returned healthy, `prompt_async` returned `204`, and the
  assistant returned `OPENCODE_REST_OK`.
- Authenticated local Chromium: `1 pass`, `0 fail`. The chat rendered
  `UI_REST_OK_1785423144172`, sent one request to
  `/v1/p/:externalId/8000/session/:id/prompt_async`, sent no
  `/kortix/acp/` request, and received no failed Kortix response.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

**Repository delivery shippable to production: NOT YET.** The user explicitly
withheld authorization to merge or push `main`. Delivery stops at the verified
worktree merge commit.
---

### Session — bugbash: the model picker's entitlement rule disagreed with the server

**Claimed and finished:** `hasUsableModel` + `isVisible` in
`src/react/use-model-store.ts`, and the `PUT .../sessions/:id/model` response
type in `src/core/rest/projects-client/sessions.ts`. Nothing on the Now chain.

**The bug.** A user picked a model and nothing happened: the picker trigger kept
reading "No model" and the composer kept showing "No model connected — connect
one to start chatting". Reproduced on the live local stack against a free-tier
account (`tier_key: 'free'`, 2 monthly credits) where the API happily served the
managed lineup and accepted the pick (`PUT .../model` → `200`,
`applied_live: true`).

Cause: the client re-derived plan entitlement instead of reading the server's
answer. `hasUsableModel` gated managed models on a locally computed `freeTier`
(from `/billing/account-state`'s `tier_key`), and `isVisible` did the same. The
server's rule is not that: `/model-picker` applies entitlement only when
`KORTIX_BILLING_INTERNAL_ENABLED` is on, and it stamps the resolved answer on
every model as `enabled`. With internal billing off — self-host, and this local
stack, where `GET /v1/billing/config` returns `{"billing_disabled":true}` — free
tier IS entitled to every managed model, so the two disagreed by construction and
the client threw away a selection the server had accepted
(`resolveAvailableSelectedModel` → `isSelectableModel` → `hasUsableModel`).

Fix: both functions now return the server's `enabled` flag whenever a model
carries one, and only fall back to the `connectedProviderIds`/`freeTier`
derivation for catalogs that carry no server answer. Not a loosened gate — on a
cloud free tier `/model-picker` omits managed models from the payload entirely
(`gatewayModelCatalog(projectId, { freeManagedOnly: true })` serves
`byokAndCodex` only), and `resolveCandidates` still throws
`plan_upgrade_required` at request time.

Also: `setProjectSessionModel` now returns `SessionModelChangeResult` carrying
`push_failed?: true` — a live push that was REQUIRED and FAILED (row written,
running harness still on the old model). `applied_live: false` alone could not
express it: that is also the benign answer for a session with no live sandbox.

**Evidence.** RED then GREEN, both pasted in the session: reverting the two
`enabled` reads fails 9 tests across `use-model-store.test.ts` and
`model-flatten.test.ts`; restoring them passes 26. In a real browser on
`/projects/<id>` the trigger reads `"No model"` with 1 "No model connected" node
before the fix and `"GLM 5.2"` with 0 such nodes after.
`pnpm --filter @kortix/sdk typecheck` clean, `test` 1428 pass / 0 fail.
`public-type-surface.snapshot.json` regenerated — additive, one new type.

**Discovered, NOT fixed (appended to Backlog below):** on a composer with no
`sessionId` and no loaded agent (project home), `setModel` in
`use-opencode-local.ts` has no slot to persist an explicit pick — it writes only
`visibility` and `recent`, both of which lose to `serverDefaultKey` in the read
chain. So on that surface the trigger still does not move when a model is picked,
for a completely different reason than the entitlement bug above. Reported to the
user rather than fixed, to keep this change reviewable.

**SDK package shippable to production: YES.**

---

### Session — bugbash: an unresolvable model was treated as a dead runtime

**Claimed and finished:** the new `src/core/acp/model-fallback.ts`, the model
preflight in `src/core/acp/session-controller.ts`, `modelNotice` on
`AcpSessionControllerSnapshot` / `useAcpSessionRuntime` / `useSession`, and catalog
reconciliation in `src/react/use-model-store.ts`. Nothing on the Now chain.

**Defect A — a `-32602` "model not found" killed the whole session surface.**
`session/set_config_option` with `optionId: 'model'` answers
`-32602 {"message":"Invalid params: model not found: <id>"}` when the id is not in
the harness's own option list. `executeSend` rethrew it, `executeSend`'s catch
patched `error` onto the snapshot, `useSession` republished it as `runtimeError`,
and the session page rendered a full-page **"OpenCode failed to load"** card with a
Restart button — over a session whose sandbox and stream were both healthy.
`session/prompt` was never sent, so the user's message was undeliverable, and the
client abandoned the connection and reconnect-looped `initialize` + `session/load`.

Fix: `applyModelOption` recovers instead of throwing. The replacement comes only
from what the harness advertises (`configOptions[id='model'].options`), preferring
the session's active model, then the server default, then the first advertised
option — no model id is hardcoded anywhere in the path. Every candidate must share
the requested id's **routing namespace**, so a managed `kortix/*` pick is never
rewritten to a BYOK `anthropic/*` id: that would move the user off the Kortix
gateway and its credits metering. With no safe replacement the harness keeps its
own selection, the prompt still goes out, and the user is told which model is
running. A rejected id is recorded in `rejectedModels` and never attempted again,
which is what stops the loop. Non-model `-32602`s and every other error still
throw.

**Defect B — a stale persisted pick outlived every server-side fix.**
`localStorage['opencode-model-store-v1']` kept `recent`, `user` visibility pins and
the per-session/per-agent/global selection slots forever. The read chain SKIPPED an
invalid id (`isModelValid`) but never removed one, so `recent[0]` stayed the first
thing every newly opened session tried. `reconcilePersistedModels` now drops every
selection the served catalog does not offer, split two ways: absent from the
catalog → dropped everywhere; served with `enabled: false` → dropped from `recent`
and every selection slot and from a stale `show` pin, but a `hide` pin is kept
(user intent, and it must survive re-enablement). It returns `null` for an EMPTY
catalog so a cold start cannot wipe every preference, and it runs only from
`useOpenCodeLocal`, the one surface that passes the whole served catalog.

**Evidence.** RED first, both defects: `bun test src/core/acp/session-controller.test.ts`
failed 8 of 8 new tests with `AcpRpcError: Invalid params: model not found:
kortix/anthropic/claude-sonnet-5` thrown out of `executeSend`;
`reconcilePersistedModels` did not exist. GREEN after: `bun test src` → **1465
pass, 0 fail, 122 files**. `typecheck` clean. `smoke:install` packed, installed and
imported the tarball. Both public-surface snapshots regenerated — **additive only,
11 new names, zero removals or renames**.

Live, on the local stack (`web :14100`, `api :14108`, project
`d85c8cfa-256b-4215-b3d0-57fe6b13a2e4`, harness `opencode`, real Platinum sandbox).
The harness rejection was injected by rewriting the wire `value` of
`session/set_config_option` in the page, so the harness returned a REAL `-32602`.

- Pre-fix (`ba9c4d99-…`): `main` innerText = `OpenCode failed to load / Invalid
  params: model not found: kortix/anthropic/claude-sonnet-5-bugbash-missing /
  Restart session`, `document.querySelector('textarea')` → **null**. Envelopes:
  `set_config_option(model)` → `ERROR` → `initialize`, `initialize`,
  `session/load`, `session/load`. **No `session/prompt` at all.**
- Post-fix (`d662351f-…`): no failure heading, no Restart button, composer present
  and enabled, user message rendered, and one inline
  `[data-session-model-notice="model-not-found"]` node. Envelopes:
  `set_config_option(model)` → `ERROR`, ONE fallback `set_config_option(model)` →
  `ERROR`, `set_config_option(mode)` → OK, **`session/prompt`**, `session/update`,
  result. No further `set_config_option` on any later send.

**Not verified live:** the copy guard for `harnessModel === requestedModel` landed
after the last live run (unit-tested only) — the API process on :14108 exited
mid-verification, from work outside this change, and this session does not restart
the stack.

**SDK package shippable to production: YES.**

### 2026-07-30 — session `bugbash-acp-rest-honesty`

Two independent defects, both proven live. No plan task claimed — a bug fix, not a
`Now` chain step.

**SDK change (1 file + its test):** `useOpenCodeAgents` gains an optional
`enabled?: boolean`. Additive only — no rename, no removal, `version` untouched
(`0.3.0`). The sandbox fallback (`client.app.agents()` → in-box `GET /agent`)
resolves its runtime from AMBIENT state, so a project-less caller reads whatever
sandbox is still connected — global, not session-scoped, and served by nothing at
all on an ACP runtime. `enabled: false` lets such a caller opt out instead.
`apps/web`'s command palette was that caller (`command-palette.tsx:397` called the
hook with no `projectId` while its five siblings all pass one); it now passes
`{ projectId, enabled: !!projectId }`.

Outside the SDK: the sandbox daemon's proxy catch-all answered
`503 {"error":"opencode not ready","opencode":"starting"}` under managed ACP, where
`opencode.start()` is never called and `markReady()` is therefore unreachable — a
permanent state advertised as a boot phase. Now `404 {"error":"opencode rest is not
served for this runtime","runtime":"acp","harness":<id>}`, which every retry path in
the stack treats as terminal (`messages.ts:98` returns null for a non-408/429 4xx,
already locked by `messages.test.ts:340`).

**Verified**

```
pnpm --filter @kortix/sdk typecheck                      → exit 0
pnpm --filter @kortix/sdk test                           → 1481 pass, 0 fail, 122 files
bun test src/react/use-opencode-sessions/agents.test.ts  → 9 pass, 0 fail (RED first: 2 fail)
apps/kortix-sandbox-agent-server: bun test src/__tests__ → 293 pass, 0 fail
apps/kortix-sandbox-agent-server: bun tsc --noEmit       → exit 0
apps/web: bun test src/features/workspace/command-palette.test.ts → 3 pass, 0 fail
```

**Not verified:** no deployed dev run — this session does not own the stack. The
palette's no-project branch is asserted at the source level plus by the hook's own
`enabled` unit tests, not by a live browser network trace.

**SDK package shippable to production: YES.**

---

### Session — bugbash: a manifest the server could not read was reported as "v1, upgrade now"

**Claimed and finished:** `ProjectManifestVerdict`, `ManifestUnknownReason`,
`ManifestMigrationOffer`, `manifestMigrationOffer()`, and the
`ProjectConfigSummary.manifest_version` field in
`src/core/rest/projects-client/projects.ts`, plus the type re-exports in
`src/index.ts`. Nothing on the Now chain.

**The bug.** Every project in the local stack showed a sidebar banner reading
**"Upgrade to v2 — This project still runs the v1 kortix.toml"**, including
freshly provisioned v3 projects. The predicate lived in `apps/web`
(`customize/migrate-to-v2/manifest-version.ts:22-26`): it regex-sniffed
`kortix_version` out of `config.manifest_raw` and returned `1` for a falsy or
non-matching string. Four distinct "unknown" cases therefore rendered as
"legacy, needs migrating" — no manifest text, unparseable text, text with no
`kortix_version`, and a config blanked by IAM. It also clamped every version
`>= 2` to `2`, so v3 was indistinguishable from v2 and the copy advertised a
destination (v2) that was not the platform's latest.

The manifest is self-describing: `kortix_version` is `required` with a `const`
in each of `kortix.v1/v2/v3.schema.json`. Nothing needed inferring. The API now
reads it (`apps/api/src/projects/lib/manifest-verdict.ts`) and returns
`config.manifest_version` — `version`, `latest_version`, `migration_offered`,
`target_version`, `unknown_reason`, `path`. Unknown stays unknown: `version`
is `null`, `migration_offered` is `false`, and the surfaces render nothing.

The SDK's part is the type and `manifestMigrationOffer()`, which fails closed on
every ambiguous input — absent config, an API too old to send the field, a null
version, or `migration_offered: true` with no `target_version`. That last guard
matters because the target version is what the button label interpolates, so an
offer without one must not render at all rather than render "Upgrade to vnull".

**Verified**

```
bun run typecheck                                        → exit 0
bun test src/core/rest/projects-client/projects.test.ts  → 14 pass, 0 fail (RED first: SyntaxError, export missing)
bun test src/core/rest/projects-client/                  → 248 pass, 0 fail
bun test src/package-exports.test.ts src/index.isomorphic.test.ts → 69 pass, 0 fail
bun run smoke:install                                    → install smoke test passed
bun test (full)                                          → 1506 pass, 15 fail
```

The 15 failures are pre-existing and not ours: restoring the baseline
`projects.test.ts` and re-running the full suite reproduces the same 15
(`use-opencode-sessions/**`, `core/session/**`, `core/stream/**` — a concurrent
session's in-flight work, fenced off from this change). Baseline is 1501 pass /
15 fail; the +5 is exactly the five tests added here. No test of ours fails in
the full run.

**Not verified:** no deployed dev run — this session does not own the release
path. A genuine v1 `kortix.toml` project was not exercised live because no local
project has one; the v1 → target 2 rule is covered by unit tests on the server
resolver plus a live response-rewrite that proved the client renders exactly the
verdict it is given.

**SDK package shippable to production: YES.**

### 2026-07-30 — session `bugbash-acp-rest-capability`

Managed ACP serves NO OpenCode REST API (its daemon skips `opencode.start()` —
`apps/kortix-sandbox-agent-server/src/main.ts:262-272`), yet every OpenCode REST
hook in this package fired anyway because they all gated on "sandbox healthy +
url pinned". Live capture on session `fcfd1f38-…`, sandbox
`sbx_01KYR7C97JFC6TP04AJHXFH8KT`: `/8000/kortix/health` → 200
(`runtimeReady:true`, `acp_ready:true`) while `/8000/project/current`,
`/8000/global/config`, `/8000/command`, `/8000/session`, `/8000/agent`,
`/8000/skill` → `503 {"error":"opencode not ready","opencode":"starting"}`. No
plan task claimed — a bug fix.

**The capability, threaded end to end (additive only, `version` untouched at `0.3.0`):**

- `core/session/runtime-transport.ts` — `SessionRuntimePolicy` gains
  `servesOpenCodeRest`; `createSessionRuntimePolicy` gains an optional third
  argument `{ acpServerId }`. `false` exactly when transport is `acp` AND an
  `acp_server_id` exists — the same managed-ACP predicate as
  `readManagedAcpSessionIdentity` (`apps/api/src/projects/runtime-inspection.ts:24`)
  and `usesManagedAcpRuntime` (the daemon's `proxy.ts`). A LEGACY ACP session (no
  `acp_server_id`) still runs the compatibility server, so it keeps REST.
- `core/session/current-runtime.ts` — `CurrentRuntimeState.servesOpenCodeRest`
  (defaults `true`), a 4th optional `setCurrentRuntime` argument, and the
  non-React reader `runtimeServesOpenCodeRest()`. This module is internal (absent
  from both public-surface snapshots), so the new required field is not a
  published-type change.
- `react/use-opencode-sessions/keys.ts` — NEW `useOpenCodeRestReady()`.
  **`useOpenCodeRuntimeReady` is deliberately unchanged.** Collapsing the two is
  a real regression, found by driving the real UI: `apps/web`'s
  `session-chat.tsx:3562` feeds `useRuntimeReady()` into
  `sessionComposerReadiness`, so widening it left the composer permanently
  disabled ("Waking this session up…") on every managed ACP session. The split is
  locked by `use-opencode-sessions/rest-gate-invariant.test.ts`, which was
  verified to go RED when `commands.ts` is put back on the wide gate.
- Nine REST modules now gate on `useOpenCodeRestReady`: `agents`, `commands`,
  `mcp`, `projects`, `providers`, `sessions`, `tools`, `use-opencode-config`,
  `runtime-actions`. That kills the `/8000/session?limit=10000` storm at the
  source — no request instead of a terminal status to interpret.
- `react/runtime-actions.ts` — `getRuntimeProjectInfo`/`getRuntimePathInfo`/
  `getRuntimeConfig` reject locally via `requireOpenCodeRest()`. They are now
  `async` on purpose: a sync throw from a `Promise<T>`-typed function escapes
  `.then/.catch`.
- `core/acp/available-commands.ts` — NEW. `acpAvailableCommandsToCommands` maps
  ACP `available_commands_update` payloads onto the published `Command` shape;
  `resolveSessionCommands` picks REST-vs-ACP. `template` is always `''` (never a
  non-string) because `apps/web`'s `detectCommandFromText` calls `.trim()` on it.
- `react/use-session.ts` — passes `acpServerId` into the policy, binds
  `servesOpenCodeRest` in the SAME `setCurrentRuntime` write as the url (two
  writes leave a gap in which every REST hook fires once), and returns the new
  `runtimeCommands`. `commands` (project-declared) is unchanged.
- `react/use-visible-agents.ts` — both option types gain `enabled?: boolean`
  (already forwarded at runtime; only the type blocked it).

Both public-surface snapshots were regenerated. The diff is entirely ADDITIVE and
also carries two CONCURRENT sessions' names, not just this one's: mine are
`acpAvailableCommandsToCommands`, `resolveSessionCommands`,
`useOpenCodeRestReady`; theirs are `manifestMigrationOffer`,
`ManifestMigrationOffer`, `ManifestUnknownReason`, `ProjectManifestVerdict`,
`persistProjectSessionAcpIdentity`, `ProjectSessionAcpIdentity`.

**Verified**

```
pnpm --filter @kortix/sdk typecheck   → exit 0
pnpm --filter @kortix/sdk test        → 1535 pass, 0 fail, 129 files (from 1481/122)
pnpm --filter @kortix/sdk smoke:install → ✔ install smoke test passed
RED first: runtime-transport/current-runtime/available-commands/keys-rest-capability
           /commands-transport → 11 pass, 9 fail, 2 errors
           keys-rest-capability after the gate split → 3 pass, 4 fail
```

Live, on the reported managed-ACP session (web :14100 / api :14108):
45 fetch/xhr requests, ALL 200. Exactly ONE sandbox path in the whole page —
`/8000/kortix/health`. `/8000/session`, `/8000/command`, `/8000/project/current`,
`/8000/global/config`, `/8000/agent`, `/8000/skill`: **0 hits each, 0 × 503**.
Agent selector populated (`opencode, claude, codex, memory-reflector, pi`) from
`/projects/:id/detail`. Slash palette populated from the ACP stream:
`/customize-opencode`, `/init guided AGENTS.md setup`,
`/review review changes [commit|branch|pr]…`. Composer enabled.

**Not verified:** no new sandbox could be provisioned during this session — the
Platinum provider left two `provisioning` rows with no `external_id` for 60
consecutive `/start` polls — so the fix is proven on a sandbox baked BEFORE it,
which is the stronger case (the client sends nothing regardless of what the box
answers). The pre-first-message composer (`composer-chat-input.tsx:90`) still has
no command source before a session exists; it degrades to an empty palette, same
as today.

**SDK package shippable to production: YES.**

---

## CLI routed onto the SDK — `persistProjectSessionAcpIdentity` made public

**Scope in this package: ONE line of source.** `apps/cli` was rewritten to consume
only `@kortix/sdk` (it previously hand-rolled an OpenCode REST client and never
imported the SDK at all). Everything the CLI needed already existed on the public
surface except one function.

**Change:** `src/core/rest/projects-client/index.ts` now re-exports
`./session-acp-identity`, making `persistProjectSessionAcpIdentity` +
`ProjectSessionAcpIdentity` public. The module and its test already existed; only
the barrel omitted it, so the sole consumer was
`src/react/use-acp-session-runtime.ts` reaching in by deep path. A non-React host
that creates an ACP session must claim the harness-native id the controller mints
(`persistAcpSessionId`) or the next invocation starts a second conversation on the
same box — there was no public way to do that.

Additive only: no rename, no removal, no signature change. Not a new subpath, so
the three-synchronized-edits rule does not apply. `package.json` untouched —
`version` still `0.3.0`.

`src/public-surface.snapshot.json` regenerated with `UPDATE_SURFACE_SNAPSHOT=1`.
The diff is 7 insertions, 0 deletions. Two are mine
(`persistProjectSessionAcpIdentity`, once for `.` and once for
`./projects-client`). The other five —`acpAvailableCommandsToCommands`,
`manifestMigrationOffer`, `resolveSessionCommands`, `useOpenCodeRestReady` —
belong to concurrent sessions whose exports were already in the working tree
un-snapshotted; regenerating recorded them too. Nothing was removed.

Also added `src/core/runtime/pty.public.test.ts`: two cases locking that
`getKortixPtyWebSocketUrl` resolves outside a browser (wss for https, ws for a
local http base). The CLI's `sessions shell` now drives the SDK PTY client from
Bun, and the snapshot only proves the export exists, not that it runs without a
`window`. No source change was needed — `kortixPty` was already public via
`core/runtime/client`.

```
bun test src/core/rest/projects-client/session-acp-identity.test.ts → 2 pass, 0 fail
bun test src/core/runtime/pty.public.test.ts                        → 2 pass, 0 fail
bun test src/public-surface.test.ts src/package-exports.test.ts \
         src/index.isomorphic.test.ts                              → 70 pass, 0 fail
bun test (full)                                                    → 1522 pass, 15 fail
bun run typecheck                                                  → 6 errors, ALL in src/core/acp/projection.ts
bun run smoke:install                                              → FAILS, blocked by the same file
```

**The 15 test failures and both gate failures are NOT from this change.** They sit
in a concurrent session's in-flight refactor of `src/core/acp/projection.ts`
(+255/-59, adding `replaying`/`anchorMessageId` to the `replay` type without yet
updating every construction site) plus the already-known
`use-opencode-sessions/**` + `core/session/server-store/**` set that PROGRESS.md
records as the 15-failure baseline. My one-line barrel export cannot produce a
`TS2554 Expected 2 arguments` in `projection.ts`. `typecheck` and `smoke:install`
will go green for this change as soon as that refactor compiles; they cannot be
re-run to green from here without editing a fenced file.

**SDK package shippable to production: NOT YET — blocked on the concurrent
`core/acp/projection.ts` refactor compiling.** This change on its own is
shippable: additive, tested, snapshot reviewed, `version` untouched.

---

### Session — ACP transcript order + token meter (worktree `bugbash`, NOT committed)

Claimed nothing in **Now**; this is Backlog `B38`/`B39` plus `B40`–`B42` appended as
found. Files: `src/core/acp/projection.ts` (+ its test), and outside this package
`apps/api/src/shared/compact-transcript.ts` and
`apps/web/src/features/session/composer/token-progress.tsx` (+ their tests).
**`version` untouched** (`packages/sdk/package.json` unmodified, still `0.3.0`).
Both files already carried a concurrent agent's uncommitted replay-dedup work
(`longestSegment`, `opensSegment`, `clearSegments`, `pendingText`, monotonic tool
status — none present at HEAD); this work sits on top of it and `git diff HEAD`
for those two files is NOT this session's delta alone.

```
RED  bun test src/core/acp/projection.test.ts        → 34 pass, 7 fail
     (then, after the first fix attempt)             → 41 pass, 1 fail
RED  apps/api … compact-transcript.test.ts           → 14 pass, 4 fail; then 18 pass, 1 fail
RED  apps/web … token-progress.test.ts               → SyntaxError: no export getLastAssistantTokenBreakdown

pnpm --filter @kortix/sdk typecheck        → clean
pnpm --filter @kortix/sdk test            → 1550 pass, 0 fail, 130 files (from 1535/129)
pnpm --filter @kortix/sdk smoke:install   → ✔ install smoke test passed
apps/api  bun test --isolate compact-transcript + public-session-share-view → 37 pass, 0 fail
apps/web  bun test token-progress.test.ts → 12 pass, 0 fail; eslint clean; tsc: 0 errors in my files
biome: 3 errors, all pre-existing `noExplicitAny` (identical set at HEAD)
```

Real-data evidence, my delta isolated (the concurrent agent's work kept, only my
three mechanisms disabled in a copy):

- Ordering, dev `6a7b3c29-…` attaching at its `session/load` (ordinal 509):
  before `a,u,a,u,a,u,a,u,u` (last answer at the head); after
  `u,a,u,a,u,a,u,a,u` with the unanswered trailing prompt last. Folding the same
  log twice is byte-identical.
- Ordering, all 241 ACP sessions in the local DB: **0 changed**. The fix only
  fires when a replay introduces a message the projection never saw, which no
  full-log fold in this DB does — every session's live phase saw its own prompts.
- Reference log `10533f77-…` (2,088 envelopes, 11 replays): still **12 messages /
  21 tool calls** in BOTH folds, byte-identical on a second fold.
- Meter, all 138 sessions with a real `totalTokens`: 128 unchanged, 9 corrected
  (over-reported, e.g. 10913→10904 truth 10904; 19563→19675 truth 19675), 1
  corrected from 0 (34207). 7 still read 0 — see `B40`.
- Back-to-back-replay concatenation (`"The build is green.The build is green."`)
  **closed** in the API fold: it never reset `activeMessageId` on an attach, so a
  second replay continued the first's segment instead of opening a new one. The
  SDK fold already reset it.

**Not verified:** no browser run — chrome-devtools MCP is not in this agent's
tool set. Proven at the fold/state level and against the live API
(`GET /v1/projects/514f25cd-…/sessions/fcfd1f38-…/transcript` → 200, 22 messages,
faithful `u,a,u,a,u,a,u,a,u,a×9,u,u,u,u`); that call cannot distinguish this
change from HEAD, because the ordering fix is a no-op on every session in this DB.

**SDK package shippable to production: YES.**

---

### 2026-07-30 — session `ci-runtime-gates` CLI SDK-boundary restoration claim

Claimed the regression created when the runtime-default revert restored the
host-local CLI transport after the earlier SDK-only rewrite.

Scope:

- Restore the CLI to the published `@kortix/sdk` surface.
- Keep OpenCode REST as the default runtime.
- Preserve existing CLI commands and output contracts.
- Repair the current session API contract failures separately from SDK code.

The required `tdd` skill is unavailable in this session. The work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** IN PROGRESS.

**SDK package shippable to production: NOT YET.** (pre-existing —
orphaned tail of the 2026-07-30 `ci-runtime-gates` CLI SDK-boundary
restoration claim entry; that session ended mid-work with no completion
entry. Left as-is; not this session's to resolve.)

---

### 2026-07-31 — session `sdk-project-emoji-icon` (B43 claim)

Claimed the additive `icon` field on the SDK's typed project contract:
`KortixProject`, `ProvisionProjectInput`, `CreateProjectRepoInput`
(`packages/sdk/src/core/rest/projects-client/projects.ts`) and
`LinkRepositoryInput` (`packages/sdk/src/core/rest/projects-client/github.ts`).
This mirrors the API-side `icon: z.string().nullable()` contract that Tasks 1–3
of `docs/superpowers/plans/2026-07-31-project-emoji-icons.md` already shipped
(`packages/api-contract/src/index.ts:120`). The SDK does not import that
package — this is an independent, additive type declaration. Task brief:
`.superpowers/sdd/2026-07-31-project-emoji-icons/task-4-brief.md`.

**Status:** IN PROGRESS.

---

### 2026-07-31 — session `sdk-project-emoji-icon` (B43 completion)

Added `icon?: string | null` to `KortixProject`, and `icon?: string` to
`ProvisionProjectInput`, `CreateProjectRepoInput`
(`packages/sdk/src/core/rest/projects-client/projects.ts`), and
`LinkRepositoryInput` (`packages/sdk/src/core/rest/projects-client/github.ts`).
All four are additive optional members on already-exported interfaces — no new
export, no rename, `version` untouched. Implementation `8f8db0d4f1`.

RED proven via `typecheck`, not `bun test`: TypeScript excess-property checks
are compile-time only, so the wire-serialization tests passed at runtime even
before the fields existed. Before the implementation, `pnpm --filter @kortix/sdk
typecheck` reported 7 `TS2353`/`TS2339` errors, all `'icon' does not exist on
type '…'`, across the four interfaces touched. After adding the fields,
`typecheck` exited 0.

Appended to the existing `projects.test.ts` (its `beforeEach`/`fetch`-mock
convention, no new file): two type-pin tests (`CreateProjectRepoInput`,
`LinkRepositoryInput` each accept `icon`) and the two wire-contract tests from
the task brief verbatim — `provisionProject` sends `icon` in the real POST
body, and a real 200 response body's `icon` survives parsing onto
`KortixProject`.

**Final SDK gates:**

```
pnpm --filter @kortix/sdk typecheck        → exit 0
pnpm --filter @kortix/sdk test             → 1354 pass, 0 fail, 2 skip, 116 files
pnpm --filter @kortix/sdk run smoke:install → ✔ install smoke test passed
bun test src/index.isomorphic.test.ts      → 67 pass, 0 fail (tripwire)
bun test src/public-surface.test.ts src/package-exports.test.ts → 3 pass, 0 fail (snapshot unchanged)
npx biome check <3 touched files>          → 2 pre-existing findings in github.ts
                                              (import order + 4 formatter
                                              suggestions), both confirmed via
                                              `git diff -U0 HEAD -- github.ts`
                                              and a biome run against the
                                              pre-change blob — untouched by
                                              this change's one-line diff
                                              (interface field only)
```

**Cross-surface note:** `apps/web` was not touched — Tasks 7/8 of this plan
consume `project.icon` there. `packages/api-contract` was not imported or
modified, per the task brief's constraint.

**SDK package shippable to production: YES.**

---

### 2026-07-31 — session `sdk-project-emoji-icon` (B43 fix round 1)

Review findings, both accepted:

1. **`PROGRESS.md` tail read as one contradictory entry.** My B43 completion
   entry (ending `YES`) was immediately followed, with no separator, by the
   orphaned `NOT YET` line that was already the file's last line at
   `d8b07337ff` — the incomplete tail of the `ci-runtime-gates` claim entry
   above. Added a `---` separator plus an attribution note on the stale line
   (see below); did not edit or delete the stale line itself.
2. **`LinkRepositoryInput` type-pin test had no runtime teeth and lived in the
   wrong file.** `projects.test.ts` type-pinned a type declared in `github.ts`
   via a fresh cross-file `import type` — it could only fail if the field
   declaration itself were reverted, never from a regression in
   `linkRepository`'s body construction. Moved to `github.test.ts` as a real
   wire test (`sends the icon in the request body when linking a repository`),
   mocking `fetch` and asserting the real `JSON.parse(init.body)`, matching the
   existing pattern at `sends the GitHub user proof when saving an
   installation`. Dropped the cross-file type-pin and its import from
   `projects.test.ts`. Kept the `CreateProjectRepoInput` type-pin as-is — it
   lives in the same file already exercised at the wire level by the
   `provisionProject` test.
3. **Added, per the reviewer's request:** a test proving `icon` survives the
   `backendApi`/`unwrap` parsing path (`getProjectDetail`) — the path
   `getProject`, `createProject`, and `updateProject` also share.
   `provisionProjectWithToken` (already covered) bypasses `backendApi` with its
   own explicit-token `fetch`, so it does not exercise this path.

```
pnpm --filter @kortix/sdk exec bun test src/core/rest/projects-client/projects.test.ts \
  src/core/rest/projects-client/github.test.ts
  → 18 pass, 0 fail (projects.test.ts: 12 pass; github.test.ts: 6 pass)

pnpm --filter @kortix/sdk typecheck    → exit 0
pnpm --filter @kortix/sdk test         → 1357 pass, 0 fail, 116 files
pnpm --filter @kortix/sdk run smoke:install → ✔ install smoke test passed

npx biome check <4 touched files>      → projects.ts, projects.test.ts,
                                          github.test.ts clean; github.ts
                                          carries the same 2 pre-existing
                                          findings as HEAD (confirmed via
                                          git diff -U0 and a biome run
                                          against the unmodified blob) —
                                          none introduced by this round
```

Full-suite delta from the prior evidence (1354 pass / 2 skip / 0 fail / 116
files): net +1 test (−1 cross-file type-pin, +1 backendApi/unwrap test in
`projects.test.ts`, +1 wire test in `github.test.ts`) and 0 skips instead of 2
on a re-run — reproduced twice at 1357/0/0-skip; the 2-skip count from the
prior round was not reproduced and is not attributable to this change (no
skip-related code touched).

**SDK package shippable to production: YES.**

---

### 2026-07-31 — session `centralized-audit-log` completion

Completed the additive centralized audit-log contract.

Scope:

- Added typed project, session, actor type, source, outcome, request, trace, and
  correlation fields to audit events.
- Added the matching account audit list and export filters.
- Derived request-event sources from authenticated server context. A caller
  cannot override forensic attribution with a client header.
- Kept all existing exports compatible. The package version remains `0.3.0`.
- Kept request bodies, query values, prompts, credentials, and secrets out of
  the centralized event envelope.

RED:

- The new SDK audit contract tests failed before the event fields and list
  filters existed.
- The connector privacy test failed while an access token remained in the result
  summary. The redaction fix changed the value to `[redacted]`.

GREEN:

```
pnpm --filter @kortix/sdk typecheck
→ exit 0

pnpm --filter @kortix/sdk test
→ 1355 pass, 2 skip, 0 fail, 5908 assertions, 117 files

pnpm --filter @kortix/sdk run smoke:install
→ OK: @kortix/sdk imports and constructs from a packed tarball
→ ✔ install smoke test passed

pnpm --filter @kortix/db lint
→ 115 migration files passed; Squawk reported 0 issues

pnpm --filter @kortix/db typecheck
→ exit 0

pnpm --filter @kortix/db test
→ 160 pass, 3 skip, 0 fail

pnpm --filter kortix-api test
→ 4873 pass, 57 skip, 0 fail, 19954 assertions, 480 files

bun test apps/web/src/components/iam/audit-display-helpers.test.ts
→ 39 pass, 0 fail

cd tests && bun bin/ke2e.ts run --id AUD-FILTER --workers 1
→ 1/1 passed, 0 failed
```

The local database migration status reported `No migrations to run! Up to date`.
The local account audit page filtered one project and one session. The session
query returned three linked events. The expanded request row showed one request
ID, trace ID, correlation ID, project ID, session ID, HTTP `201`, and `790 ms`.
The Agents quick filter returned only agent events. The Failures quick filter
returned only failed events.

The live local API filter returned one correlated CLI event for the exact
project, human actor type, CLI source, and successful outcome. A linked human
session event and agent action carried the same project and session identifiers.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-07-31 — session `sdk-project-edit-icon` (B44 claim)

Claimed `icon?: string | null` on `ProjectInput`
(`packages/sdk/src/core/rest/projects-client/projects.ts`) — the body type for
`updateProject`, and therefore the only SDK path to `PATCH
/v1/projects/:projectId`.

B43 covered the CREATE inputs and the response type. It did not cover the
UPDATE input, so a project's emoji was write-once from the SDK's point of view:
a host could send one at create time and never change or remove it.

`string | null`, not `string`. The API handler (`apps/api/src/projects/routes/r5.ts`,
landed in `c76c6f962`) reads three states off the request body — key absent
leaves the stored icon untouched, an explicit `null` clears it, a valid emoji
sets it — so the type has to be able to express the clear.

Additive optional member on an already-exported interface: no new export, no
rename, no `version` edit, public-surface snapshot unchanged.

**Status:** IN PROGRESS.

---
### 2026-07-31 — session `sdk-project-edit-icon` (B44 completion)

Added `icon?: string | null` to `ProjectInput`
(`packages/sdk/src/core/rest/projects-client/projects.ts`) and documented the
tri-state on `updateProject`. Additive optional member on an already-exported
interface: no new export, no rename, `version` untouched, public-surface
snapshot unchanged.

**RED first.** `bun test` cannot see this contract — the SDK JSON-stringifies
whatever it is handed, so the six new runtime tests were green before the
implementation. The gate that owns a type contract is `tsc`, and it was red:

```
pnpm --filter @kortix/sdk typecheck
src/core/rest/projects-client/projects.test.ts(285,38): error TS2353: Object literal may only specify known properties, and 'icon' does not exist in type 'Partial<ProjectInput>'.
src/core/rest/projects-client/projects.test.ts(298,38): error TS2353: ... (x4)
Exit status 2
```

The runtime tests read the body the mocked `fetch` was actually handed — the
raw string, re-parsed — rather than the object passed in, because the failure
mode this guards is a serializer that drops nullish members. Nine mutations,
nine killed:

| # | Mutation | Result |
|---|---|---|
| M1 | strip nullish members before sending | 17 pass / 1 fail |
| M2 | POST instead of PATCH | 17 / 1 |
| M3 | send an empty body | 14 / 4 |
| M4 | coerce a null icon to `''` | 17 / 1 |
| M5 | always send `icon: null` | 17 / 1 |
| M6 | drop `projectId` from the route | 17 / 1 |
| M7 | narrow `ProjectInput.icon` to `string` | typecheck exit 1, 2 TS errors |
| M8 | remove `ProjectInput.icon` entirely | typecheck exit 1, 4 TS errors |
| M9 | narrow `KortixProject.icon` to `string` | typecheck exit 1, 1 TS error |

M9 covers a gap this session FOUND rather than introduced: B43 added
`KortixProject.icon?: string | null` with no compile-time pin on the
nullability, and narrowing it to `string` left every runtime assertion green
(`expect(x).toBeNull()` accepts any type). The clear is only useful if the
caller can see that it happened, so the response half is now pinned with
`const projectIconAcceptsNull: KortixProject['icon'] = null;` — a test-only
addition, no source change to B43's declaration.

**Gates**

```
pnpm --filter @kortix/sdk typecheck
→ exit 0

pnpm --filter @kortix/sdk test
→ 1365 pass, 0 fail, 5893 expect() calls, 116 files  (baseline before this change: 1359 / 0 / 116)

pnpm --filter @kortix/sdk run smoke:install
→ OK: @kortix/sdk imports and constructs from a packed tarball
→ ✔ install smoke test passed
```

The server side of this contract landed in `c76c6f962`
(`apps/api/src/projects/routes/r5.ts`): 21 tests, 8 mutations killed.

**Status:** COMPLETE.

**SDK package shippable to production: YES.** Verified: typecheck, the full
suite, and the packed-install smoke, all pasted above; the tri-state is proven
against the real API handler by that handler's own suite. Unverified: nothing
here was exercised through the published CDN/IIFE bundle — this change adds no
runtime code, only an optional interface member, so the bundle's behaviour is
byte-identical.

---
### 2026-08-01 — session `sdk-project-glyph-icon` (B45 claim)

Claimed the additive `icon_glyph?: ProjectGlyph | null` field across the SDK's
typed project contract: `KortixProject`, `ProjectInput`
(`packages/sdk/src/core/rest/projects-client/projects.ts`),
`ProvisionProjectInput`, `CreateProjectRepoInput` (same file), and
`LinkRepositoryInput` (`packages/sdk/src/core/rest/projects-client/github.ts`).

This is Task 6 of `docs/superpowers/plans/2026-08-01-project-glyph-icons.md` —
the SDK-types twin of B43/B44, extended to the second glyph-icon shape
(`{name, color}`) landed server-side by Tasks 1–5. `ProjectGlyph` is declared
independently in the SDK — deliberately NOT imported from `@kortix/shared`,
which exports a same-named type with literal-union `name`/`color` fields for
the server-side catalogue. The SDK's dependencies stay exactly
`@kortix/llm-catalog`, `@opencode-ai/sdk`, and `zustand`; adding a workspace
dependency on `@kortix/shared` for a two-field interface would cost every
downstream consumer for nothing. The two types are structurally compatible, so
nothing needs converting at the boundary. Task brief:
`.superpowers/sdd/2026-08-01-project-glyph-icons/task-6-brief.md`.

**Status:** IN PROGRESS.

---
### 2026-08-01 — session `sdk-project-glyph-icon` (B45 completion)

Added `ProjectGlyph` (`{ name: string; color: string }`) and
`icon_glyph?: ProjectGlyph | null` to `KortixProject` and `ProjectInput`, and
`icon_glyph?: ProjectGlyph` (non-null — create bodies have no clear-the-glyph
case) to `ProvisionProjectInput` and `CreateProjectRepoInput`
(`packages/sdk/src/core/rest/projects-client/projects.ts`), and the same
`icon_glyph?: ProjectGlyph` to `LinkRepositoryInput`
(`packages/sdk/src/core/rest/projects-client/github.ts`). All additive:
one new exported interface, five new optional members on already-exported
interfaces — no rename, no removal, `version` untouched.

**Deliberately a SECOND `ProjectGlyph`.** `@kortix/shared` exports a
same-named type with literal-union `name`/`color` fields for the server-side
catalogue. The SDK does not import `@kortix/shared` — its dependencies stay
exactly `@kortix/llm-catalog`, `@opencode-ai/sdk`, `zustand` — so this
declares an independent, structurally-compatible `string`/`string` version.
A literal union here would make every catalogue addition a breaking change
for pinned consumers; the catalogue is a server-side concern that can grow
without a package release.

**Test conventions used.** The brief's snippet named `clientReturning` and
`recordingClient` helpers that do not exist in this file. The real
conventions (`projects.test.ts`/`github.test.ts`, both already used by
B43/B44): `configureKortix` + a mocked `globalThis.fetch`, and the
`captureUpdate(input: Partial<ProjectInput>)` helper B44 added for reading the
literal wire body `updateProject` sent. Reused as-is, no new helpers invented.
One correction to the brief's test snippet: `const omitted: ProjectInput = {}`
does not typecheck — `ProjectInput.repo_url` is required — so the omitted/null
pin test uses `Partial<ProjectInput>`, matching `updateProject`'s actual
parameter type.

Added 9 tests: `projects.test.ts` — a `CreateProjectRepoInput` type-pin, a
read round-trip (`getProject`), a provision wire-body check, the
omitted-vs-null type pin, three `captureUpdate`-based wire tests (explicit
null on the wire, a glyph sent verbatim, a name-only update sends no
`icon_glyph` key), and a compile-time response-nullability pin
(`KortixProject['icon_glyph'] = null`) paired with its round-trip test, mirroring
the `projectIconAcceptsNull` pin B44 added after finding that gap in `icon`.
`github.test.ts` — one wire test for `LinkRepositoryInput.icon_glyph`.

**RED, proven via typecheck, not `bun test`** — same shape as B43/B44: JSON
object literals with an extra `icon_glyph` key are valid JS regardless of the
TS interface, so the new tests already passed at runtime before the fields
existed. Before the implementation:

```
pnpm --filter @kortix/sdk typecheck
src/core/rest/projects-client/github.test.ts(110,5): error TS2353: 'icon_glyph' does not exist in type 'LinkRepositoryInput'.
src/core/rest/projects-client/projects.test.ts(49,5): error TS2353: 'icon_glyph' does not exist in type 'CreateProjectRepoInput'.
src/core/rest/projects-client/projects.test.ts(52,22): error TS2339: Property 'icon_glyph' does not exist on type 'CreateProjectRepoInput'.
... (12 TS2353/TS2339 errors total, all "icon_glyph does not exist")
Exit status 2

bun test src/core/rest/projects-client/
276 pass, 0 fail  (runtime — vacuously green, confirms the gap is type-only)
```

After implementation, `typecheck` exited 0.

**Guardrail hit: the type-level public-surface snapshot.** `ProjectGlyph` is
a brand-new exported interface (unlike B43/B44's plain field additions), so
`src/public-type-surface.test.ts` — the TS-checker-based snapshot that sees
`export interface`/`export type` bindings the runtime snapshot cannot — went
red with a pure addition (`+ ProjectGlyph` on `.` and `./projects-client`,
nothing removed or renamed). Regenerated deliberately:
`UPDATE_TYPE_SURFACE_SNAPSHOT=1 bun test src/public-type-surface.test.ts`.
The runtime `public-surface.snapshot.json` is unchanged — `ProjectGlyph` is a
pure interface, invisible at runtime, so it never reaches that snapshot. No
new subpath was added, so `package.json` `exports`/`publishConfig.exports`
and `SUBPATH_TIERS` needed no edits — `ProjectGlyph` reaches the root and
`./projects-client` entry points through the existing `export * from
'./projects'` wildcards, the same path every sibling type in this file uses.

**Mutation table** (brief's table, both mutations confirmed applied by `grep`
before reading a result, then reverted by `Edit` — never `git checkout`):

| # | Mutation | Applied confirmed via | Result |
|---|---|---|---|
| M1 | Drop `\| null` from `ProjectInput.icon_glyph` | `grep -n "icon_glyph?:" projects.ts` showed line 240 as `ProjectGlyph` (no `\| null`) | **Killed — TYPECHECK**, not `bun test`. 3 × `TS2322: Type 'null' is not assignable to type 'ProjectGlyph \| undefined'` at the omitted/null pin, the `captureUpdate({icon_glyph:null})` wire test, and the null-response round-trip test. `bun test src/core/rest/projects-client/projects.test.ts` stayed **26 pass / 0 fail** — JS assigns `null` into any field regardless of the TS type, so only `tsc` catches this. |
| M2 | Remove `icon_glyph` from `ProvisionProjectInput` | `grep -n "icon_glyph?:" projects.ts` showed only 3 matches (line 224 `ProvisionProjectInput` gone) | **Killed — TYPECHECK**, not `bun test`. `TS2353: Object literal may only specify known properties, and 'icon_glyph' does not exist in type 'ProvisionProjectInput'` at the provision wire test's call site. `bun test` stayed **26 pass / 0 fail** — `provisionProject` forwards `...input` verbatim regardless of its declared type, so the field still reaches the wire; only `tsc` catches the type-contract violation. |

Both mutations are real kills, not survivors — but both are caught **only** by
`typecheck`, never by the runtime test named in the brief's own table. This
mirrors B44's M7/M8/M9 finding: for a pure additive-optional-field change,
`bun test`'s JSON round-trip cannot distinguish "field exists on the type"
from "field exists on the object", because JS erases the type before the test
ever runs. `typecheck` is the gate that actually owns this contract; it is not
optional here.

**Final SDK gates:**

```
pnpm --filter @kortix/sdk typecheck        → exit 0
pnpm --filter @kortix/sdk test             → 1374 pass, 0 fail, 5910 expect() calls, 116 files
                                              (baseline before this change: 1365 pass / 0 fail / 116 files)
pnpm --filter @kortix/sdk run smoke:install → ✔ install smoke test passed
bun test src/index.isomorphic.test.ts      → tripwire green (included in the 1374/116 total above)
bun test src/public-surface.test.ts src/package-exports.test.ts → 2 pass, 0 fail (runtime snapshot unchanged)
bun test src/public-type-surface.test.ts   → 1 pass, 0 fail (type snapshot regenerated, additive-only diff)
npx biome check <4 touched files>          → 2 NEW findings both fixed inline (an import-order
                                              nit, a >100-char test line); remaining findings
                                              (github.ts import order + 4 formatter suggestions,
                                              projects.test.ts 2 × noNonNullAssertion) confirmed
                                              pre-existing via `git diff HEAD~1` — none on a line
                                              this change touched
```

**Cross-surface note:** `apps/web` was not touched — later tasks of this plan
consume `project.icon_glyph` there. `packages/api-contract` and
`@kortix/shared` were not imported or modified, per the task brief's
constraint (decision 2: a second, independent `ProjectGlyph`).

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

- **Verified:** typecheck (exit 0), the full suite (1374/0/116, baseline
  1365/0/116), the packed-install smoke test, both public-surface snapshots
  (runtime unchanged, type-level regenerated additive-only), the isomorphic
  tripwire, and both brief mutations killed (via typecheck).
- **Unverified:** nothing here was exercised through the published CDN/IIFE
  bundle or a real browser — this change adds no runtime code, only type
  declarations, so the bundle's runtime behaviour is byte-identical to before.
  `apps/web` consumption of `icon_glyph` (later tasks) is out of this task's
  scope and unverified here.
- **Risk:** none identified. This is a pure additive type change with no
  runtime code path; the only way it could regress a consumer is if a future
  edit narrows `icon_glyph` or removes it, both of which the type-surface
  snapshot and `typecheck` will catch.

Implementation commit: `3ce3e5f1f`.

---
### 2026-08-01 — session `model-enablement` (re-land server-side model enablement, display-only)

Un-reverted `6c168ee2a` (#5932) minus the gateway-enforcement half. SDK changes:

- Restored `model-enablement.ts` REST client + `useModelEnablement` hook +
  `ProjectLlmCatalogResponse.{modelOverrides,usingDefaults,defaultModel}` and
  the barrel exports; surface snapshots regenerated.
- New export `isOfferedModel(models, key)` (`react/model-flatten.ts`) — THE
  predicate for "may this key be offered?": in-catalog AND server `enabled !==
  false`. Test-first (RED: missing export → GREEN).
- `useOpenCodeLocal`: `isModelValid` now delegates to `isOfferedModel` instead
  of `useModelStore.isVisible`; dropped the project-secrets query +
  `connectedProviderIds`/`freeTier` store plumbing (the server already resolves
  entitlement/connection into `enabled`); `local.model.visible` now returns the
  server answer; removed the localStorage `setVisibility(model, true)` write on
  pick. `UseOpenCodeLocalOptions.freeTier` kept but `@deprecated`/inert.
- `useModelStore` keeps its full export surface (npm contract). Its visibility
  half (`isVisible`, `setVisibility`, `resetVisibility`, `isLatest`,
  `computeLatestSet`, `hasUsableModel`, `isDefaultVisible`, `userPrefs`) now has
  ZERO repo consumers — backlog: deprecate + delete in the next breaking cycle.

Second fix found by live UI verification: the session picker renders from the
gateway provider list (`['project-providers', :id, 'gateway']`, staleTime
Infinity + localStorage seed) — a SECOND cache of the `/model-picker` payload —
so a toggle wrote through `['project-model-picker']` and the open composer
never updated. New export `applyEnablementToProviderList(providers, overrides)`
(`react/provider-selection.ts`, test-first) restamps `enabled` on that shape;
`useModelEnablement` now optimistically updates + invalidates BOTH keys
(rollback on error covers both). Verified live in Chromium: toggle off →
picker hides the model (7 options), toggle on → reappears (8) with no reload.

Gates: `typecheck` exit 0 · `bun test --isolate src` → **1367 pass, 2 skip,
0 fail** · `smoke:install` OK.

**SDK package shippable to production: YES.**

---
### 2026-08-01 — session `e2b-capacity-fast-fail` (completion)

Added the provider-neutral `SessionStartFailure` contract.
Added the durable `PendingSessionPrompt` create and warm-claim contract.
Added `replayStartStash.onSuccess` for the runtime ACK callback.
The web uses the callback to clear the durable prompt after delivery.

The type-surface snapshot adds four entries.
The root and `./projects-client` surfaces each add two types.
No public field, type, or export was removed or renamed.

SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1389 pass`, `0 fail`,
  and `5969 expect() calls` across `117` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

**Repository delivery shippable to production: NOT YET.**
The PR, merge, Deploy Dev, and Essentia verification remain.

---
### 2026-08-02 — session `cost-explorer-sdk-clients` (claim)

Claiming Task 8 of the `2026-08-01-cost-explorer-ux` plan (spec/plan live under
`.superpowers/sdd/2026-08-01-cost-explorer-ux/`, not under `docs/superpowers/` —
this plan predates and is unrelated to the OpenCode ACP canary NOW table above,
so this is logged here rather than inserted into that table).

Scope: `packages/sdk/src/core/rest/projects-client/session-costs.ts` (+ test) and
its barrel `index.ts` — add `listCostByProject`, `getCostSummary`,
`costExportUrl`, and extend `ListSessionCostsOptions` with `from`/`to`/`sort`/
`ownerId`. Wraps `GET /v1/usage/cost-by-project`, `GET /v1/usage/cost-summary`,
and the extended `GET /v1/usage/session-costs` (Tasks 4–7, already merged to this
branch). Purely additive — no existing export renamed or removed.

Measured baseline before any change:

```
pnpm --filter @kortix/sdk test
→ 1357 pass, 2 skip, 0 fail, 5873 expect() calls, across 116 files [16.84s]
```

(Neither of the two baseline numbers this file cites elsewhere — 1069, 1046 —
matches what actually runs today. Recording the real measured number per the
task brief's instruction not to trust either stale figure.)

**Status:** IN PROGRESS.

---
### 2026-08-02 — session `cost-explorer-sdk-clients` (completion)

Implemented Task 8. TDD throughout, RED watched before any implementation code.

**Added** to `packages/sdk/src/core/rest/projects-client/session-costs.ts`
(barrel `index.ts` already does `export * from './session-costs'` — no barrel
edit needed, name collision-checked against the whole `projects-client/` dir
and the rest of `src/`, none found):

- `interface CostWindowOptions { from?; to? }`
- `type SessionCostSort = 'total_desc' | 'total_asc' | 'recent'`
- `type ProjectCostSort = SessionCostSort | 'name_asc'`
- `ListSessionCostsOptions` gains `from?`, `to?`, `sort?: SessionCostSort`,
  `ownerId?` (all optional — widening, not narrowing)
- `interface ProjectCostRow`, `interface ProjectCostPage`,
  `interface ListCostByProjectOptions`
- `listCostByProject(options?): Promise<ProjectCostPage>` →
  `GET /usage/cost-by-project`
- `interface CostSummaryTotals`, `CostSeriesPoint`, `CostModelRow`,
  `CostSummary`, `GetCostSummaryOptions`
- `getCostSummary(options?): Promise<CostSummary>` → `GET /usage/cost-summary`
- `interface CostExportOptions`, `costExportUrl(kind, options?): string` — pure
  URL builder (never calls `fetch`; the CSV routes require a Bearer token with
  no query-token fallback, so the caller attaches auth itself, same pattern as
  `fetchProjectArchive` in `./files.ts`)

**Type shapes verified against the real API**, not the plan:
`apps/api/src/shared/cost-rollups.ts` (`ProjectCostRow`/`ProjectCostPage`/
`CostSummaryTotals`/`CostSeriesPoint`/`CostModelRow`/`CostSummary`) and
`apps/api/src/router/routes/usage.ts` (query param names, route paths,
`SESSION_COST_SORTS`/`PROJECT_COST_SORTS`). Confirmed by grep that no response
anywhere in the API carries an `unassigned` field — `ProjectCostPage` does not
have one, matching the brief's warning, and `CostSummary` doesn't either
(unattributable compute/LLM spend is folded into the account-wide totals, not
surfaced as a synthetic field).

RED — `bun test src/core/rest/projects-client/session-costs.test.ts` failed
with `SyntaxError: Export named 'costExportUrl' not found in module`, before
any implementation code existed, for the expected reason.

GREEN:

```
pnpm --filter @kortix/sdk typecheck
→ exit 0 (tsc --noEmit + tsc --noEmit -p examples/tsconfig.json)

pnpm --filter @kortix/sdk test
→ 1370 pass, 0 fail, 5908 expect() calls, across 116 files [16.58s]
   (post-change run; two SSE-related tests are environment-conditionally
   skipped in some runs and not in others — pre-existing, unrelated to this
   change, and total test count (1370) is stable across both)

pnpm --filter @kortix/sdk run smoke:install
→ OK: @kortix/sdk imports and constructs from a packed tarball
→ ✔ install smoke test passed
```

Baseline was 1357 pass / 1359 total; post-change is 1370 total (+11, exactly
the 11 new `test()` calls added), 0 regressions.

**Mutation checks** (each applied to the restored, working implementation,
then reverted — file diffed byte-identical to pre-mutation afterward):

1. Dropped `appendWindow(query, options)` from `listCostByProject` → the exact
   URL assertion in `listCostByProject targets the rollup route with account,
   window, sort and paging` failed (`from=…&to=…` missing from the URL). 13
   pass / 1 fail.
2. Renamed `owner_id` → `owner` in `listSessionCosts` → the exact URL assertion
   in `listSessionCosts forwards window, sort and owner as query params` failed
   (`owner=user-9` instead of `owner_id=user-9`). 13 pass / 1 fail.

Both mutations were caught by exactly one test each, as intended — the tests
assert the literal URL string, not merely that a request happened.

**Absent-optional coverage:** `listSessionCosts({ accountId })`,
`listCostByProject()`, `getCostSummary()`, and `costExportUrl(kind)` (no
options) each assert the exact resulting URL carries no stray `from=`, `to=`,
`sort=`, or `owner_id=` param.

**Public-surface snapshot diff** (`public-surface.snapshot.json` +
`public-type-surface.snapshot.json`, re-recorded with
`UPDATE_SURFACE_SNAPSHOT=1` / `UPDATE_TYPE_SURFACE_SNAPSHOT=1` after visually
confirming every line): 6 new value exports
(`costExportUrl`/`getCostSummary`/`listCostByProject`, each listed once for `.`
and once for `./projects-client`) and 30 new type-level exports (12 new
type/interface names × the same two subpaths, plus the 6 value names repeated
at the type level). **Every line in both diffs is a `+` addition. Zero
removals, zero renames.** The type-surface test's own drift report labelled
every one of the 30 entries `← added — additive, fine`.

**Status:** DONE.

**SDK package shippable to production: YES**, for this change. Verified:
typecheck, full test suite (0 regressions, 11 new passing tests), packed-install
smoke test, and 2/2 mutation checks caught. Unverified/out of scope for Task 8:
end-to-end wiring against a running API (web consumption is Task 10+), and
`costExportUrl`'s download flow was not exercised against a live server (it is
a pure string builder with no network call — the auth-attachment + Blob-download
flow is a web-task concern per the brief's `costExportUrl` scope).

---
### 2026-08-02 — session `cost-explorer-sdk-clients` (fix round 1/5)

Review: Spec ✅ / Approved, one Important finding, one Minor folded in, one
DRY cleanup requested. All three addressed. Commit `f78f79da7`.

**Important — the `fetchProjectArchive` precedent claim was backwards.** The
prior completion entry said `costExportUrl` mirrors `fetchProjectArchive` "in
leaving the caller responsible for attaching the token." Re-reading
`./files.ts:78-99` shows the opposite: `fetchProjectArchive` calls
`getSupabaseAccessTokenWithRetry()` itself, attaches the `Authorization`
header itself, fetches itself, and returns a `Blob`. As shipped,
`costExportUrl` was a bare URL string with no auth story — a consumer
treating it like a plain link (`<a href>`, `window.open`) gets a silent
`401`, and the architecture rule ("hosts never raw-fetch the Kortix API")
would force Task 16 to hand-roll authenticated fetch-to-Blob logic in
`apps/web` instead.

Fix: added `fetchCostExportCsv(kind, options): Promise<CostExportResult>`
(`{ blob: Blob; rowCap: number | null }`), built the way
`fetchProjectArchive` actually is — resolves the token via
`getSupabaseAccessTokenWithRetry()`, attaches
`Authorization: Bearer <token>`, fetches, throws with the response body on a
non-OK response. It delegates to `costExportUrl` for the URL itself (kind is
narrowed to a literal in each branch first, since an overloaded function
can't be called with a non-narrowed union argument), so the two functions
cannot diverge. `costExportUrl` is unchanged in behavior and stays exported —
removing it would break a name this task already published.

Deviated from the literal `Promise<Blob>` suggested in the review: also
surfaces the `x-kortix-row-cap` response header (parsed to `number | null`)
because Task 16 needs it to warn when the 10,000-row CSV cap truncates a
finance export, and that header isn't present anywhere in either route's JSON
response schema — a caller genuinely cannot get it any other way. Judged
`{ blob, rowCap }` as not "awkward" (a small named result type is a standard
ergonomic pattern), so implemented it rather than leaving the header
unreachable.

**Minor (folded in) — `CostExportOptions.sort` accepted `name_asc` for both
kinds.** Split into `ProjectCostExportOptions` (`sort?: ProjectCostSort`) and
`SessionCostExportOptions` (`sort?: SessionCostSort`, no `projectId`/
`ownerId`), with a discriminated overload on both `costExportUrl` and
`fetchCostExportCsv`. `costExportUrl('sessions', { sort: 'name_asc' })` and
`costExportUrl('projects', { projectId: … })` are now compile errors instead
of a runtime 400 / silently-ignored field. `CostExportOptions` stays exported
as `export type CostExportOptions = ProjectCostExportOptions |
SessionCostExportOptions` — same name, no removal, now precise instead of a
flat bag. Proved by 5 `@ts-expect-error` assertions in a dedicated test,
checked by `tsc --noEmit` (bun strips types and does not evaluate the
directive; an *unused* `@ts-expect-error` is itself a typecheck error, so the
test only stays green if every line genuinely fails to compile — confirmed by
a clean `pnpm typecheck` with all 5 directives present).

**Minor 1 — duplicated `suffix` ternary.** Extracted
`function suffix(query: URLSearchParams): string` and applied it at all four
call sites in the file (`listSessionCosts`, `getSessionCostRecord`,
`listCostByProject`, `getCostSummary`) — including the pre-existing
`getSessionCostRecord` occurrence the review didn't explicitly name, for full
consistency within the same file. Left `costExportUrl`'s own query assembly
duplicated with `fetchCostExportCsv`'s call into it, per "not to fix."

**RED** (before the fetcher/overloads existed):
```
bun test src/core/rest/projects-client/session-costs.test.ts
→ SyntaxError: Export named 'fetchCostExportCsv' not found in module '.../session-costs.ts'
→ 0 pass, 1 fail, 1 error
```

**GREEN:**
```
pnpm --filter @kortix/sdk typecheck
→ exit 0

pnpm --filter @kortix/sdk test
→ 1374 pass, 0 fail, 5926 expect() calls, across 116 files [16.62s]

pnpm --filter @kortix/sdk run smoke:install
→ OK: @kortix/sdk imports and constructs from a packed tarball
→ ✔ install smoke test passed

bun test src/index.isomorphic.test.ts
→ 67 pass, 0 fail, 2947 expect() calls
```

Test count: 1370 (prior completion) → **1374** (+4: the `@ts-expect-error`
type-safety test, plus 3 `fetchCostExportCsv` behavior tests).

**Mutation check (required by this fix round) — removed the `Authorization`
header from `fetchCostExportCsv`:**
```
bun test src/core/rest/projects-client/session-costs.test.ts
→ (fail) fetchCostExportCsv requests the export URL with a Bearer token and
  parses the row cap — expected {"Authorization": "Bearer tok"}, got {}
→ 17 pass, 1 fail
```
Caught. Reverted; file diffed byte-identical to the pre-mutation copy
afterward.

**Public-surface snapshot diff** — re-recorded, reviewed line by line before
accepting: 4 new type-level names (`CostExportResult`,
`ProjectCostExportOptions`, `SessionCostExportOptions`, `fetchCostExportCsv`,
each × 2 subpaths). `CostExportOptions` itself has **zero** diff lines —
its shape changed (interface → type alias) but the exported *name* didn't,
so the name-only snapshot shows no change for it. Every line in both diffs is
a `+`. Zero removals, zero renames.

**Status:** DONE.

**SDK package shippable to production: YES.** All three gates green
post-fix, mutation check on the new fetcher caught the missing-auth-header
case, snapshot diff confirmed additive-only. Unverified/out of scope: live-API
integration (Task 10+/16 territory) and the actual browser download trigger
(save-as / anchor-click flow) around the `Blob` `fetchCostExportCsv` returns —
that UI wiring belongs to the web task consuming this client.

---

### 2026-08-02 — session `capabilities-task-5` (small fix, bundled with an `apps/web` task)

Not a Now-chain task — a single self-contained bug fix carried in while building the
skill/command detail modal for the capabilities-pages plan (`suna-capabilities`
worktree, `apps/web/src/features/workspace/capabilities/skills/entity-modal.tsx`).

`readProjectFile` (`core/rest/projects-client/files.ts`) called `backendApi.get`
with no options, so `showErrors` defaulted to `true` and a `project.file.read`
403 fired the global toast — even though every existing caller
(`config-entity-view.tsx`, the git-ref file explorer, and now the new entity
modal) already renders its own inline error state. `listProjectFiles` in the
same file already carried the fix for the identical gate
(`{ showErrors: false }`, "a member deep-linking to the files page legitimately
403s"); `readProjectFile` just didn't have it yet. Same one-line fix, same
justification, applied to the sibling function.

Test-first: added a 403-never-hits-`onError` test to `files.test.ts` mirroring
`listProjectFiles`'s existing one. RED (received 1 call, expected 0) before the
fix, GREEN after. No signature change, no new export — behavior-only.

Gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1389 pass`, `2 skip`, `0 fail`, `5968
  expect() calls` across `117` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.

**SDK package shippable to production: YES.**

---

### 2026-08-03 — session `session-title-source-of-truth` claim

No **Now** task claimed. This is a narrow cross-host session-title bug fix.

Scope:

- Treat Veyris's historical `New agent` name as a Kortix placeholder.
- Keep the SDK title-refresh loop active until Kortix replaces that placeholder.
- Preserve all published names and signatures.

The required `tdd` skill is unavailable in this session. The work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** IN PROGRESS.

**SDK package shippable to production: NOT YET.**

---

### 2026-08-03 — session `secret-delivery-control-plane` claim

No **Now** task claimed. This is the first public secret-delivery control-plane
slice defined in `docs/SECRET_DELIVERY_CONTROL_PLANE.md`.

Scope:

- Expose stored secret delivery metadata through the project secrets API.
- Add an admin-only route for delivery-strategy changes.
- Expose the additive contract through `@kortix/sdk`.
- Record central audit events for secret administration without secret values.
- Keep `broker` and `egress` unavailable until their adapters exist.

The required `tdd` skill is unavailable in this session. The work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** IN PROGRESS.

**SDK package shippable to production: NOT YET.**

---

### 2026-08-03 — session `secret-delivery-control-plane` completion

Added delivery strategy, consumer, status, rotation, and egress-policy metadata
to the project secret contract. Added `setProjectSecretStrategy()` and
`kortix.project(id).secrets.setStrategy()` without removing or renaming a
published export.

The type-surface snapshot adds eight entries. The runtime-surface snapshot adds
two entries. All changes are additive.

SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1391 pass`, `0 fail`, and `5975 expect()`
  calls across `117` files.
- `pnpm --filter @kortix/sdk smoke:install`: exit `0`.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**
### 2026-08-03 — send reliability: `hydrate` deleted un-acked optimistic messages

Bug work, not part of the **Now** chain. Tracked in Linear as JAY-285 (project
*Assistant Turn UX*); no Linear identifiers appear in code, branches, or commits.

**The defect.** `hydrate`'s supersede rule was EXISTENTIAL:

```ts
const incomingHasUserMessage = incoming.some(
  (m) => m.role === "user" && !optimisticIds.has(m.id),
);
// …later: if (incomingHasUserMessage && m.role === "user") → drop it
```

Read plainly: *"if this page holds any real user message at all, every optimistic
user message is a duplicate."* In an ongoing conversation that is always true —
the page is full of earlier turns — so a message sent one second ago, which the
server had provably never received, was deleted along with its text.

The window was wide open by construction: the rehydrate that calls `hydrate` runs
only for sessions whose status is `busy`
(`react/use-opencode-events/index.ts:214`), and `beginOptimisticSend` is what sets
`busy`. **Sending armed the thing that deleted the send.** With an upload in front
of the prompt, that window is the whole upload — which is how it was reported: a
large attachment, and no user bubble at all until the upload finished.

**The fix.** Correlation is now identity-based, in two passes:

1. **Part id** — hosts generate the text part id up front and send it WITH the
   prompt so the echo updates the same part. That makes it an identity match, not
   a guess.
2. **Ordinal fallback** — only for an echo whose parts the server has not
   persisted yet, and only among messages already marked `dispatched`. A message
   that has not been POSTed cannot be a duplicate of anything the server holds, so
   it is never eligible. This is what stops another tab's message from consuming
   this tab's in-flight bubble.

Candidate echoes are additionally restricted to real user messages **not already
in the store** — history cannot supersede the present. That single condition is
what fixes the reported bug; the rest makes the supersede path honest.

The parts bridge now follows the established pairing (`supersededBy`) instead of
grafting onto "whichever real user message came first", which could attach one
message's text to another's bubble with two sends in flight.

**Public surface:** one additive action, `markOptimisticDispatched(messageID)` on
the sync store. No renames, no removals. Called from `sendAndRecover`,
`replayStartStash`, and `useSession.sendParts` (which resolves the message via
part ids, since hosts own their own message ids).

**Gates**

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1396 pass`, `0 fail`, `5985 expect() calls`
  across `117` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0` — *"OK: @kortix/sdk
  imports and constructs from a packed tarball"*.
- `apps/web` consumer check: `bun test src/features/session src/components/markdown`
  → `1087 pass`, `0 fail` across `99` files.

**Tests added** — 6 in `browser/stores/sync-store.test.ts`, RED before the fix:
un-acked message survives a hydrate of prior turns; several in flight survive
independently; another session untouched; a genuinely echoed message IS
superseded (double-bubble guard); a dispatched message pairs with a parts-lagging
echo and bridges its text; a PENDING message is never consumed by an unrelated
new user message.

**Status:** code COMPLETE, not committed (the user commits).

**SDK package shippable to production: YES.**

**Bug fix verified end to end: NOT YET.** The store logic is proven by unit tests,
but the reported failure is a race between a store write and a slow upload. It has
not been exercised against a live sandbox with a real multi-MB attachment, and
that is the only proof that matters for the user-visible symptom.

### 2026-08-03 — upload: timeouts are not transient, and the deadline follows the body

Bug work, not part of the **Now** chain. Linear JAY-286 (*Assistant Turn UX*).
Continues the send-reliability thread from the entry above.

**The defect.** `Upload failed: signal timed out` on a real attachment, after a
wait roughly three times longer than it needed to be.

`uploadWithRetry` (`core/files/client.ts`) discriminated correctly on STATUS
(`isTransient`: 408/429/502/503/504) but not on a thrown request — that path
retried everything, including `AbortSignal.timeout()`. So a body too large for
the flat 30s deadline blew that same deadline on all three attempts. Re-sending
an identical body against an identical budget cannot succeed; the retries bought
only a longer wait for the same answer.

The 30s itself came from `withDefaultTimeout` (`platform/auth-core.ts:78`), the
platform-wide default applied to every request. That is a hang detector for a
JSON call. Against a 30 MB attachment it is a throughput limit, and the
attachment loses — a 200 KB screenshot and a 30 MB zip were on the same budget.

**The fix.**

1. `isUnretryableThrow` — `TimeoutError` (the deadline) and `AbortError` (a
   deliberate cancel) break the retry loop instead of feeding it. The status
   path is unchanged; it was already right.
2. `uploadTimeoutMsForBytes(bytes)` — the deadline scales with the body,
   clamped to `[30s, 15min]` over a deliberately pessimistic ~256 KB/s floor.
   Erring long costs a late error message; erring short costs an upload that
   would have succeeded.
3. `authenticatedFetch` gains an optional `timeoutMs` so a caller can say so.
   A caller-supplied `init.signal` still composes; first to fire wins.

**Public surface:** two additive names — `uploadTimeoutMsForBytes` (from
`./files`) and the `timeoutMs` option on `authenticatedFetch`. Both snapshots
regenerated deliberately; the diff adds one name and removes none. The export is
justified by JAY-287, which needs the deadline to render a sensible upload
affordance — flagged for review rather than assumed.

**Gates**

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1403 pass`, `0 fail`, `5997 expect() calls`
  across `117` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.
- `apps/web`: `bun test src/features/session src/components/markdown src/features/files`
  → `1116 pass`, `0 fail` across `105` files.

**Tests added** — 7 in `core/files/client.test.ts`, RED before the fix: a timed-out
upload fails after ONE attempt not three; an aborted upload is not retried; a
transient network throw IS still retried; a transient STATUS is still retried;
a large upload's deadline exceeds the flat 30s; the deadline is bounded at both
ends and monotonic between; an unknown-size body still gets a usable deadline.
The suite's own wall clock fell 5.25s → 2.06s once the retry sleeps stopped
firing, which is the fix visible in the clock.

**Deliberately NOT done in this task:** upload progress events. They need
`XMLHttpRequest` or a streamed request body (plain `fetch` + `FormData` emits
none), and they have no consumer until JAY-287 gives them somewhere to render.
Left on the ticket rather than folded in — see *Found work mid-task*.

**Status:** code COMPLETE, not committed (the user commits).

**SDK package shippable to production: YES.**

**Bug fix verified end to end: NOT YET.** Retry/deadline behaviour is proven by
unit tests against a mocked `globalThis.fetch`. No upload has been run against a
live sandbox at a real size, and the Platinum edge 128 KiB inbound body ceiling
has not been checked on this path — if it applies, chunking is still required and
the real fix lives in the external platinum repo.

### 2026-08-03 — the same bug on the SSE path, and session-scoped optimistic ids

Linear JAY-290 (*Assistant Turn UX*), plus a **gap in JAY-285 found while doing
it**. Third entry in the send-reliability thread.

**Found: `hydrate` was not the only place with the existential rule.** The
`message.updated` SSE handler removed EVERY optimistic user message in the
session the moment ANY real one arrived:

```ts
const optIds = msgs.filter((m) => m.role === "user" && optimisticIds.has(m.id))
```

With one send in flight that is correct, and is the whole point of the branch —
it swaps the bubble in a single `set()` so the user never sees it blink. With
two in flight it took the innocent one with it: confirm the plain message and
the one still uploading its attachment vanished too. Same defect, different
path, and JAY-285's acceptance was not actually met while it stood.

Now: ONE confirmation retires ONE message. Correlation is part-id first, as in
`hydrate`. The fallback is deliberately generous — with exactly one optimistic
message in flight there is nothing to be ambiguous about, so it is retired
regardless of `dispatched`. Requiring the flag unconditionally would leave a
host that hand-rolls a send with a permanent double bubble, which is worse and
more visible than the bug being fixed. Only with two or more does `dispatched`
break the tie. At `message.updated` time the confirmed message usually has no
parts in the store yet (those arrive separately), so this fallback — not the
part-id match — is the live path here.

**JAY-290: optimistic tracking is session-keyed.** `optimisticIds` and
`dispatchedOptimisticIds` were process-wide `Set<string>` shared by every
session in the tab, and `clearSession` never released their entries, so ids
accumulated for the lifetime of the tab. Both are now
`Map<sessionID, Set<messageID>>`, released by `clearSession`.

Note on the test: `hasOptimisticMessages` cannot observe the leak — it is gated
on the message list, which WAS cleared — so the first three tests written for
this passed trivially. **A test that has never failed is not a test**, so they
were replaced with one that exercises the real consequence: `hydrate` skips
parts for any id it believes is optimistic, and a leaked id made it skip a real
server message forever. That one goes red on the old code.

**Public surface:** `markOptimisticDispatched` gained a `sessionID` first
argument. Added earlier the same day and never released, so this is a
correction, not a break.

**Gates**

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1407 pass`, `0 fail` across `117` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.
- `apps/web`: `1116 pass`, `0 fail` across `105` files.

**Tests added** — 4: confirming one message does not delete another still
uploading; the single-send swap is still atomic (no double bubble); a cleared
session's ids do not make `hydrate` skip a real message elsewhere; clearing one
session leaves another's optimistic message alone.

**Status:** code COMPLETE, not committed (the user commits).

**SDK package shippable to production: YES.**

**Send reliability verified end to end: NOT YET.** Three code paths are now
correct under unit test. None has been exercised against a live sandbox.

### 2026-08-03 — send queue: one prompt at a time, in order

Linear JAY-287 (*Assistant Turn UX*). Fourth entry in the send-reliability
thread. Product decision from the user: **queue, do not reject.**

**Finding that shaped the design.** The runtime already has native queueing.
The opencode client exposes two `prompt` methods:

- `session.promptAsync` → `/session/{id}/prompt_async` — what Kortix calls
  today. No `delivery` field.
- `session.prompt` (v2) → `/api/session/{id}/prompt` — *"Durably admit one
  session input and schedule agent-loop execution"* — with
  `delivery?: 'steer' | 'queue'`, plus `session.next.prompted` /
  `session.next.prompt.admitted` events carrying `admittedSeq`/`promotedSeq`.

So the server can already do this durably, and we are on the older endpoint that
cannot express it. Moving to the v2 protocol is the better long-term answer but
is a protocol migration touching the send path AND the event stream
(`session.next.*` is a different event family) — deliberately deferred, tracked
in Linear, and called out in the module doc so the next reader does not
rediscover it.

**Unresolved, and it needs a live sandbox.** Whether `/prompt_async` already
orders prompts that arrive mid-run is NOT determinable from this repo — the
opencode server runs inside the sandbox; only its client is vendored. The queue
is therefore designed to be correct either way: ordering is guaranteed HERE, not
assumed of the server.

**Built:** `core/session/send-queue.ts` — framework-free, timer-free, no polling.
`isBusy` is injected; draining is driven by the caller reporting the session went
idle. FIFO per session, one dispatch in flight at a time, a failed send reports
`failed` and the queue moves on rather than wedging, and an idle-instant submit
still queues behind anything already waiting (ordering beats latency).

**On TDD:** these tests passed on first run, which by rule 1 means they had
proven nothing. Verified them by mutation instead — removing the line-jump guard
failed 1 test, letting `drain` ignore `isBusy` failed 2. Both restored. Recorded
because "wrote the module then the tests" is a deviation from RED-first and
should not be silently normalised.

**Public surface:** unchanged. `send-queue.ts` is not exported from any barrel
yet — it stays internal until something consumes it, so no snapshot moved.

**Gates**

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1419 pass`, `0 fail` across `118` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.

**Status:** queue core COMPLETE. **NOT yet wired** — the SDK send path and the
`apps/web` bubble still need to consume it, and the `SendPhase` per-message state
still needs somewhere to live. Nothing user-visible changes until that lands.

**SDK package shippable to production: YES** (additive, inert, nothing imports it).

**JAY-287 shippable: NO — half built by design.**

### 2026-08-03 — self-review found the fixed bug reintroduced via the SSE fallback

Autonomous review pass over the day's own diff. No new feature work; one real
defect found and closed.

**What was wrong.** The `message.updated` fallback added earlier the same day
read: *"with exactly ONE optimistic message in flight there is nothing to be
ambiguous about, so retire it"* — regardless of `dispatched`.

That has a hole. A SECOND TAB on the same session produces a `message.updated`
for a message that is not ours, while the one message we do have in flight may
still be uploading. The single-in-flight rule handed the other tab's
confirmation our un-sent message and deleted it — **exactly the bug this whole
change set exists to fix, through a side door.** `hydrate` already protected
this case (there is a test); the SSE path did not, and it fires first in
practice.

**Why the generosity was wrong.** The argument for it was that a host calling
`beginOptimisticSend` and then POSTing by hand, never marking dispatch, would
keep its bubble forever. That is checkable rather than hypothetical:
`optimisticAdd` has exactly ONE caller, and every send path through this SDK
(`sendAndRecover`, `replayStartStash`, `useSession.sendParts`) marks dispatch.
Losing a message the user typed is worse than a double bubble on a host that
does not exist. The fallback now requires `dispatched`, matching `hydrate`.

The stale fixture went with it: the single-send test never dispatched, which a
server confirmation cannot happen without. Same correction as the parts-lagging
`hydrate` fixture earlier — noted rather than quietly adjusted.

**Also reviewed, no change needed:** the `role !== "user"` branch in `hydrate`'s
optimistic loop is defensive-only (`optimisticAdd`'s single caller always builds
a user message), so the `deferredOptimistic` ordering concern it raises cannot
occur in practice. `claimable` and `unmatchedOptimisticUsers` are both in
chronological order, so the ordinal pairing is sound.

**Gates**

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1420 pass`, `0 fail` across `118` files.
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.
- `apps/web`: `1189 pass`, `0 fail` across `118` files.

**Tests added** — 1, RED first: a PENDING upload is not consumed by another
tab's confirmation.

**Status:** review pass COMPLETE. JAY-287 still half built (queue core exists,
nothing calls it) — unchanged this tick, by choice: wiring the live send path
unattended risks a wrong drain signal stranding messages, which is worse than
the bug being fixed.

---

### 2026-08-03 — session `connector-policy-approvals` claim

No **Now** task claimed. This is a narrow additive approval-link contract fix.

Scope:

- Add the optional `review_complete` response field to `ApprovalLinkDetails`.
- Preserve every published name and signature.
- Replace the web host's local intersection cast with the SDK field.

The required `tdd` skill is unavailable in this session. The work will use the
same RED, GREEN, and REFACTOR sequence directly.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** IN PROGRESS.

**SDK package shippable to production: NOT YET.**

---

### 2026-08-03 — session `connector-policy-approvals` completion

Added the optional `review_complete` field to `ApprovalLinkDetails`. Existing
consumers that construct this public interface remain source-compatible. The web
approval page now reads the SDK field directly without a host-local type cast.

RED:

- `pnpm --filter @kortix/sdk typecheck`: failed with `TS2353` and `TS2339`
  because `ApprovalLinkDetails` did not expose `review_complete`.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1410 pass`, `2 skip`, `0 fail`, and
  `6026 expect()` calls across `117` files.
- `pnpm --filter @kortix/sdk smoke:install`: exit `0`; packed tarball imported
  and `createKortix` constructed successfully.

No public export name changed. The public-surface snapshots stayed unchanged.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-05 — session `preview-port-probe` (host-driven, additive)

`apps/web`'s Easy-mode `AppPreview` declared a preview app dead after 5s of
iframe silence. Nothing probed the port, so a cold dev-server compile (30-60s
per the root `CLAUDE.md`) was indistinguishable from a dead one. The host needed
a real verdict; per the "hosts never raw-`fetch` the sandbox proxy" rule, the
probe belongs here.

Added `src/core/session/preview-probe.ts`, exported through
`src/core/session/index.ts` (already re-exported by the root barrel and
`./session`):

- `PreviewPortProbe` — `'reachable' | 'unreachable' | 'unknown'`.
- `classifyPreviewProbeStatus(status)` — pure. `502/503/504` is the proxy
  itself saying nothing is listening; `401/403` is our own preview-auth gate
  and therefore says nothing about the port; anything else in the HTTP range
  means a server answered.
- `probePreviewPort(url, { signal, timeoutMs })` — a credentialed `HEAD` that
  never throws; every failure mode collapses to `'unknown'`.
- `PREVIEW_PROBE_TIMEOUT_MS = 10_000`.

Deliberately NOT `authenticatedFetch`: the preview proxy authenticates a browser
with the `__preview_session` cookie, and an `Authorization` header would turn
every probe into a CORS preflight.

RED:

- `bun test src/core/session/preview-probe.test.ts`: `0 pass`, `1 fail` —
  `Cannot find module './preview-probe'`.

GREEN:

- `bun test src/core/session/preview-probe.test.ts`: `21 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1516 pass`, `1 fail`, `1517` tests across
  `122` files. The one failure is `fetchCostExportCsv requests the export URL
  with a Bearer token` in `core/rest/projects-client/session-costs.test.ts` —
  PRE-EXISTING and unrelated (a process-wide `mock.module` auth-token leak from
  a sibling suite). Verified on a clean tree at the same commit: `1495 pass`,
  `1 fail`, same test.
- `pnpm --filter @kortix/sdk smoke:install`: exit `0`.

Public surface: PURELY ADDITIVE — 4 names on `.` and `./session`
(`PREVIEW_PROBE_TIMEOUT_MS`, `PreviewPortProbe`, `classifyPreviewProbeStatus`,
`probePreviewPort`). Both snapshots re-recorded; zero removals, zero renames.
`version` untouched.

Not verified: the probe has never been run against a live sandbox proxy (this
workstream is barred from booting the stack). If the cross-origin `HEAD` is
refused in production it resolves `'unknown'`, which by design can never fail a
preview — the host falls back to its own bounded wait.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-05 — session `preview-port-probe` review round

Review of the host change found that `PREVIEW_PROBE_TIMEOUT_MS = 10_000` was
badly chosen. A caller decides a port is dead from repeated misses inside a
window of its own; `apps/web`'s window is also 10s, so ONE probe that stalled to
its ceiling consumed the caller's entire sampling budget and the loop ended
after a single sample.

Lowered to `3_000` and re-justified in the source: the proxy's "nothing is
listening" answer needs no upstream connection and returns in well under a
second, so a short ceiling never delays a real verdict — it only stops a socket
being held behind an app that accepted the connection and then stalled, which is
itself already weak evidence the port is up. Three seconds leaves room for
several samples inside any window worth having.

- `bun test src/core/session/preview-probe.test.ts`: `21 pass`, `0 fail`.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1516 pass`, `1 fail` — the same
  pre-existing `fetchCostExportCsv` failure documented in the entry above.
- `pnpm --filter @kortix/sdk smoke:install`: exit `0`.

No export name changed, so both public-surface snapshots are byte-identical to
the previous entry's. `version` untouched.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

### 2026-08-06 — session `perf-memory` review fix wave

Three fixes to the session-retention work already on the `perf-memory` branch,
after a whole-branch review. All three are eviction correctness, not new
capability. No public export name changed; `SyncState` gains one method,
`shouldHydrateFromCache` gains one optional input field — both additive.

**1. Orphan part buckets survived every drop.** `parts` is keyed by messageID,
and both sweeps (`dropSessionData`, `clearSession`) walked `messages[sessionID]`
to find buckets. The `message.part.delta` handler deliberately stores a part
WITHOUT creating its assistant message when the session holds no user message
yet, so those buckets are unreachable from that walk and outlived the drop — the
leak class this work exists to close, still open on the page-refresh path that
creates it. `deleteOrphanPartBuckets` sweeps them by `Part.sessionID`.

**2. `sessionStatus` no longer dropped on eviction.** It is the only slice read
for sessions that are on purpose not resident (a spawn-tool banner reads
`sessionStatus[child]`), and dropping it reclaimed nothing — the `session.status`
frames and the connect-time status poll re-add an entry for every session on the
runtime regardless. This changed an expectation an existing test encoded
deliberately, so that test changed with it, in its own commit, with the reasoning
in the message.

**3. An evicted session that is still streaming now repaints from disk.** Its
SSE frames put `messages[id]` back within seconds, holding only the post-eviction
tail, and `shouldHydrateFromCache` read the key's presence as "the store is the
authority" — so returning to it showed the fragment, not the transcript. Before
this branch that transcript was simply resident, so it was a regression in what
the user sees. Fixed by marking evicted sessions (`wasTranscriptEvicted`) rather
than by dropping events for unmounted sessions: `useOpenCodeMessages` (the
spawn-tool preview of a child) has no reconcile and is fed by SSE alone, so
dropping frames would trade recoverable staleness for an unrecoverable gap.
`pruneDetachedSessions` re-checks the marked ids so refilled data is swept again
on the next mount instead of living forever outside the detach window.

RED, then GREEN, for each — every new assertion was watched failing against the
unfixed code first, and each fix was then mutation-checked (11 mutations, each
killing a specific test; see the commit messages).

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1533 pass`, `0 fail`, `6287 expect()` calls
  across `121` files (baseline for this branch was `1520` / `121`).
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0`.

**Not covered by a test:** the two-line wiring in `use-session-sync.ts` that
passes `wasTranscriptEvicted` into `shouldHydrateFromCache`. The SDK test runner
has no DOM, so that effect cannot be driven; both halves of the decision it
composes are tested directly.

**Status:** COMPLETE.

---

### 2026-08-07 — session `workspace-switcher` Task 18: `provisionProjectStream`

No SDK **Now** task claimed (`Now` tracks the unrelated OpenCode ACP canary
plan). Task 18 of `.superpowers/sdd/2026-08-06-workspace-switcher/` — expose
`POST /projects/provision-stream` (built server-side in an earlier task of the
same plan) through the SDK, so `apps/web`'s create-project flow can show phase
progress instead of a single opaque wait.

Added:

- `provisionProjectStream(input, onEvent, options?)` in
  `core/rest/projects-client/projects.ts` — POSTs to `/projects/provision-stream`,
  parses the data-only SSE body **line by line** (not `frame.startsWith('data: ')`
  on the whole frame), calls `onEvent` per phase/done/error frame, and resolves
  with the project on `done`. Rejects on a terminal `error` frame, on a pre-stream
  non-2xx response (the route's "Owner or admin role required" 403 denial, which
  arrives as plain JSON before any stream opens), and on a stream that closes
  with no terminal frame at all — the last case matters because resolving with
  `undefined` would route a caller to `/projects/undefined`.
- `ProvisionPhase` and `ProvisionStreamEvent` — the phase union is pinned by a
  compile-time exhaustiveness test against the literal 4-member list, so a
  rename on either side of the two independent declarations (this one and
  `PROVISION_PHASES` in `apps/api/src/projects/provision-core.ts`) fails loudly
  instead of the UI silently stopping mid-progress.
- `ApiClientOptions.fetch` — an explicit `fetch` injection point (narrower than
  `typeof fetch`, no `preconnect`, so a plain stub function satisfies it) and
  `backendApi.postStream`, a new POST variant that returns the raw `Response`
  instead of consuming its body, so a caller can read `response.body`
  incrementally. Chosen over `globalThis.fetch = mock(...)` (the rest of this
  file's convention) because the task required a real injection seam, not just
  a way to make this one test pass.
- `default_branch?: string` on `ProvisionProjectInput` (carried-Minor cleanup):
  `apps/web` was sending it and the server was reading it
  (`apps/api/src/projects/routes/r1.ts:546`) with no field to type it, forcing
  a `payload as unknown as ProvisionProjectInput` double-cast at the web call
  site. Additive only — no existing field touched.

Doc comment states the streaming target matrix and says plainly that **React
Native is not supported** (RN's `fetch` has no `response.body`; Hermes has no
`TextDecoderStream`) — matches this file's existing streaming guidance.

RED (watched fail, for the right reason):

```
SyntaxError: Export named 'provisionProjectStream' not found in module
'.../packages/sdk/src/core/rest/projects-client/projects.ts'.
```

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1579 pass`, `2 skip`, `0 fail`,
  `6381 expect()` calls across `122` files (baseline going in was `1569`/`122`
  — the 10-test delta is exactly the tests this task added).
- `pnpm --filter @kortix/sdk run smoke:install`: exit `0` — tarball packed,
  installed into a throwaway project, imported successfully.

Public surface changed additively only, verified by reading the diff before
re-recording: `provisionProjectStream`, `ProvisionPhase`, `ProvisionStreamEvent`
added to both the root and `projects-client` entries in both
`public-surface.snapshot.json` (runtime) and `public-type-surface.snapshot.json`
(type-level). Nothing removed, nothing renamed. `default_branch` is a new field
on an existing interface, so it does not appear in either name-list snapshot.
`package.json`'s `version` was not touched.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

---

## Session `trial-entitlements` — admin trial + entitlement-override hooks (2026-08-07)

Additive only. `src/react/use-admin-accounts.ts` gains five mutation hooks over
the new admin routes (`apps/api/src/admin/index.ts`), matching the existing
`useAdminSetTier` / `useAdminGrantCredits` shape:

- `useAdminGrantTrial` — `POST /admin/api/accounts/{id}/trial`. Maps camelCase
  variables to the snake_case body the route validates (`tier_key`, `seats`,
  `duration_days`, optional `credit_grant` / `note`).
- `useAdminRevokeTrial` — `DELETE …/trial` (the route answers `400` when no
  trial is active; the hook rethrows the message).
- `useAdminSetManagedModels` — tri-state `{override: boolean|null}`.
- `useAdminSetEnterpriseDemo`, `useAdminSetEnterpriseEntitled` — `{enabled}`.

All five invalidate `['admin','accounts']` + `['admin','accounts',accountId]`.
`AdminAccount` gains the fields the list route now returns: `billingModel`,
`seatCount`, `trial` (new `AdminAccountTrial` / `AdminTrialStatus`),
`managedModelsOverride`, `demoEnterprise`, `enterpriseEntitled`.

RED first: `src/react/use-admin-accounts.test.ts` (13 tests) was watched failing
with `useAdminGrantTrial is not a function` — `0 pass, 13 fail` — before any
implementation, then green.

Both surface snapshots were re-recorded. The diff is **14 insertions, 0
deletions** — 5 runtime names + 4 type names + the same 5 in the type snapshot.
No rename, no removal, so no consumer breaks.

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1603 pass`, `2 skip`, `0 fail`, `6486
  expect()` across `126` files (was `1590`/`126` before this change).
- `pnpm --filter @kortix/sdk run smoke:install`: `✔ install smoke test passed`.

Also verified end to end against the live local stack: the admin panel's new
Entitlements tab drove `POST …/trial` → `200` with body
`{"tier_key":"team","seats":5,"duration_days":90,"credit_grant":25,"note":…}`,
and `DELETE …/trial` → trial `status: revoked`, both read back from
`GET /admin/api/accounts`.

**Judgment call for review:** the six new `AdminAccount` fields are **required**,
not optional. The route always populates them (`?? null` / `?? false`), and the
type is admin-only, but a consumer that constructs an `AdminAccount` literal
would now fail to compile. Flagging rather than burying it.

**Status:** COMPLETE (uncommitted — left in the working tree on branch
`trial-entitlements` at the requester's instruction, so no claim commit was
made; this entry is the handoff record).

**SDK package shippable to production: YES.**
||||||| f398f755c2

### 2026-08-07 — session `connectors-grid`: `listPipedreamApps` forwards the catalogue total

Additive, host-driven. `apps/web`'s connectors catalogue was rebuilt to paginate
by scroll, and its foot states "Showing 192 of 2,713 connectors". Discover
already publishes `total` on every page; Pipedream did not, so the Easy Connect
source — the one **most** projects get, since `connectors_api_discover` defaults
false — could only ever quote what it had already fetched. A page that says
"192" under a catalogue of 2,713 reads as a catalogue of 192.

Pipedream's `/apps` response carries `page_info.total_count` and the API was
discarding it. Change is one optional field, end to end:

- `apps/api/src/connectors/pipedream.ts` — `listApps` returns
  `total: data.page_info?.total_count`; `listApps` and `browsePipedreamApps`
  signatures widened. The route is a passthrough (`c.json(result)`), so nothing
  there changed.
- `packages/sdk/.../projects-client/connectors.ts` — `total?: number` on
  `listPipedreamApps`'s response type.

**Optional, not required.** An API build older than this one omits the field;
callers fall back to their loaded count rather than quoting a total they cannot
back up. Per the safe/breaking table, an added optional field is additive.

It is an upper bound, not an exact figure, and the code says so: Pipedream counts
before `isPipedreamOAuthApp` filters utility apps out of each page. Still far
closer to the truth than the loaded count.

RED, then GREEN. Two tests added to `connectors.test.ts` (`surfaces the catalogue
total the API reports`, `tolerates an API build that reports no total`). Both were
watched failing first — the failure is a **typecheck** failure, not a runtime one,
because the SDK function is a pass-through and `bun test` never sees the type:

```
src/core/rest/projects-client/connectors.test.ts(523,17): error TS2339: Property 'total' does not exist on type '{ apps: PipedreamApp[]; nextCursor?: string | undefined; hasMore: boolean; }'.
src/core/rest/projects-client/connectors.test.ts(531,17): error TS2339: Property 'total' does not exist on type '{ apps: PipedreamApp[]; nextCursor?: string | undefined; hasMore: boolean; }'.
```

GREEN:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1584 pass`, `2 skip`, `3 fail`,
  `6451 expect()` across `124` files. **The 3 failures are pre-existing and
  unrelated** — `fetchCostExportCsv …`, `catalog uses the project-scoped route …`,
  `attachment upload sends raw bytes …`. Verified by `git stash` → same 3 failures,
  `1582 pass`. This change moved the count `1582 → 1584` and the failures not at
  all. Not fixed here: they are outside this task, and burying them under an
  unrelated change is worse than reporting them.
- `pnpm --filter @kortix/sdk run smoke:install`: **FAILS**, pre-existing.
  `src/index.ts(136,11): error TS18046: 'error' is of type 'unknown'` inside the
  throwaway smoke project, with `WARN Local package.json exists, but node_modules
  missing`. Identical failure on a stashed tree, so it is the harness in this
  worktree, not the tarball.

**Not covered by a test:** that the live Pipedream `/apps` response actually
carries `page_info.total_count` for this deployment's project. The field is read
optionally and every consumer falls back, so the failure mode is the old
behaviour rather than a break.

**Status:** COMPLETE.

**SDK package shippable to production: YES** — for this change. The 3 red tests
and the red `smoke:install` predate it and are unrelated; they are someone's open
work, and this change neither causes nor clears them.

### 2026-08-07 — session `apps-experimental-gate` claim

Scope:

- Add the additive `apps` experimental feature key to the public project contract.
- Keep the existing Apps SDK surface unchanged.
- Gate API, CLI, and web discovery and execution on the selected project's effective flag.

The required `tdd` skill is unavailable in this session. The work uses the same
RED, GREEN, and REFACTOR sequence directly.

**Status:** IN PROGRESS.

**SDK package shippable to production: NOT YET.**

### 2026-08-07 — session `no-timeout-toasts` completion

Kept both request-safety deadlines. Added the stable API wire code
`request_deadline`. The SDK normalizes typed and legacy API deadline responses,
returns typed client `TIMEOUT` errors, and does not invoke the host global error
handler for either class. The web host rejects these deadlines before telemetry
or toast processing. The shared toast helper also rejects exact Kortix deadline
messages when a direct caller has discarded the typed code. Unrelated `503`
failures and third-party timeout messages remain visible.

Verification after rebasing onto `origin/main`:

- SDK typecheck: exit `0`.
- SDK suite: `1714 pass`, `0 fail`, `6808 expect()` calls, `135` files.
- SDK packed-install smoke: exit `0`.
- API focused suite: `16 pass`, `0 fail`; API typecheck: exit `0`.
- Web focused suite: `12 pass`, `0 fail`; complete suite: `4814 pass`, `0 fail`;
  focused ESLint: exit `0`.
- Authenticated local HTTP request with a 1 ms server deadline: HTTP `503`,
  `Retry-After: 10`, and JSON `code: 'request_deadline'`.

No SDK export or version changed.

**Status:** COMPLETE in commit `9c5d9dc11d`.

**SDK package shippable to production: YES.**

---

## Session `admin-projects` — `useAdminProjects` fleet-list hook (2026-08-07)

No **Now** task claimed. Additive host-driven work: the admin console gains a
`/admin/projects` page (every project across every account, most-active first)
backed by the new `GET /v1/admin/api/projects` route in
`apps/api/src/admin/index.ts`. Per the root rule that hosts are thin, the data
layer landed here, not in `apps/web`.

New file `src/react/use-admin-projects.ts`, exported from `src/react/index.ts`:

- `useAdminProjects(filters)` — query hook over `GET /admin/api/projects`,
  shaped exactly like `useAdminAccounts`: unset filters are omitted from the
  query string, `staleTime` 15s, `placeholderData: (prev) => prev`.
- Types: `AdminProject`, `AdminProjectsResponse`, `AdminProjectsFilters`,
  `AdminProjectsSortBy` (`activity` | `created` | `sessions`),
  `AdminProjectsSortDir`.
- Query key is `['admin','projects', search, accountId, status.join(','),
  sortBy, sortDir, page, limit]` — every input, so two filter sets can never
  share one cache entry.

No subpath was added, so the three-synchronized-edits rule does not apply: the
hook rides the existing `./react` entry. The package `version` is untouched.

The required `tdd` skill was unavailable in this session. The RED → GREEN →
REFACTOR sequence was followed directly.

RED:

- `bun test src/react/use-admin-projects.test.ts` before implementation:
  `0 pass, 1 fail` — `Cannot find module './use-admin-projects'`.

GREEN:

- `bun test src/react/use-admin-projects.test.ts`: `8 pass`, `0 fail`,
  `23 expect()` calls.
- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1737 pass`, `0 fail`, `6854 expect()` calls
  across `137` files (was `1729`/`136` before this change).
- `pnpm --filter @kortix/sdk run smoke:install`: `✔ install smoke test passed`.

Both surface snapshots were re-recorded. The diff is **7 insertions, 0
deletions** — `useAdminProjects` in the runtime snapshot, plus the same name and
the 5 type names in the type snapshot. No rename, no removal, so no consumer
breaks.

Verified end to end against the live local worktree stack (web `:23700`, API
`:23708`): a Chromium run drove `/admin/projects` and asserted `32` conditions —
the default request (`sortBy=activity&sortDir=desc&page=1&limit=50`, no empty
`search`/`status` params), search/sort/status each firing a new request with the
right params and resetting to page 1, and the rendered rows (activity order with
never-run last, `2/3` active-of-total session counts, `1h ago` relative
activity, and the account cell's `/admin/accounts?search=<ownerEmail>` href).
`33` direct HTTP assertions against the route passed alongside it.

**Status:** COMPLETE (uncommitted — left in the working tree on branch
`admin-tier-labels` at the requester's instruction, so no claim commit was made;
this entry is the handoff record).

**SDK package shippable to production: YES.**

---

## 2026-08-11 — admin member-role mutation + exact-id account lookup (branch `billing-revamp-pr1`)

Part of the billing-revamp PR1 (enterprise-entitlement primitive fix, expiring
trial grants, admin role control). SDK surface additions in
`src/react/use-admin-accounts.ts`, TDD (`use-admin-accounts.test.ts`, RED→GREEN):

- `useAdminSetMemberRole` + `adminMemberRolePath` + type `AdminAccountMemberRole`
  — POST `/admin/api/accounts/{id}/members/{userId}/role` (platform-admin
  override; server refuses demoting the last owner).
- `useAdminAccount` + `adminAccountLookupPath` — live single-account row via the
  list route's new exact-id `accountId` filter; fixes the admin sheet's stale
  pre-mutation snapshot when list filters no longer match the row.

Both surface snapshots re-recorded — additive only (5 names runtime, 5 type),
no rename, no removal.

**Status:** COMPLETE on branch `billing-revamp-pr1`, commit `0c295a7652`.

---

## 2026-08-11 — resolved-plan selector + admin plan block (branch `billing-revamp-pr3`)

Part of billing-revamp PR3 (the API half landed in `f92564a8`, which added the
resolved `plan` block to `/billing/account-state`). This is the SDK half: the
contract for that block and the one selector every host reads it through, so no
host re-derives a plan name from `subscription.tier_key` again.

Additive surface, TDD (RED → GREEN), no rename, no removal, `version` untouched:

- `src/core/rest/projects-client/billing.ts`
  - `AccountState.plan?` — `{ key, family, label, sublabel, status, shape,
    rank, is_grandfathered }`, optional so a client on an older API still
    type-checks.
  - `resolvedPlan(state)` → `ResolvedPlanView { family, label, sublabel,
    isGrandfathered }`. Reads the `plan` block; falls back to
    `tier.display_name ?? tier_key` + a three-way family guess when the API is
    older than the resolver.
  - `PlanFamily` (`'free' | 'team' | 'enterprise'`), `ResolvedPlanView`.
  - `AccountStateAppAccessView.plan?` — the login gate's projection now carries
    the resolved plan key it was already receiving on the wire.
- `src/react/use-admin-accounts.ts` — `AdminAccountPlan` + optional
  `AdminAccount.plan`, matching the admin list route's new block.

RED (before implementation):

```
SyntaxError: Export named 'resolvedPlan' not found in module '…/billing.ts'
src/react/use-admin-accounts.test.ts(50,45): error TS2344: Type '"plan"' does not satisfy the constraint 'keyof AdminAccount'.
src/core/rest/projects-client/billing.test.ts(350,5): error TS2353: Object literal may only specify known properties, and 'plan' does not exist in type 'AccountStateAppAccessView'.
```

GREEN:

- `bun run typecheck`: exit `0` for the package and `examples/tsconfig.json`.
- `pnpm test -- --sdk-only` (worktree root, the sanctioned lane): `1855 pass`,
  `0 fail`, `7120 expect()` across `142` files (was `1852 pass / 2 skip` before
  this change).
- `bun run smoke:install`: `✔ install smoke test passed`.

Both surface snapshots re-recorded. The diff is **9 insertions, 0 deletions** —
`resolvedPlan` in the runtime snapshot (root + `./react` subpath), and
`resolvedPlan` + `PlanFamily` + `ResolvedPlanView` + `AdminAccountPlan` in the
type snapshot. No subpath added, so the three-synchronized-edits rule does not
apply.

Verified against the live worktree stack (web `:15400`, API `:15408`): a
Chromium run drove `/admin/accounts` and asserted 15 conditions, including that
a trialing per-seat account renders `Team` (stored `tier` still `per_seat`), a
grandfathered per-seat account renders `Team · $40/seat/mo · grandfathered`, and
the string `· legacy` appears nowhere. `GET /v1/billing/account-state` returned
`plan = {"key":"team","family":"team","label":"Team","sublabel":null,"status":"retired","shape":"flat","rank":8,"is_grandfathered":false}`
while `subscription.tier_key` stayed `per_seat`.

**Status:** COMPLETE on branch `billing-revamp-pr3`.

**SDK package shippable to production: YES.**
