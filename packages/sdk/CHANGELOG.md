# Changelog

All notable changes to `@kortix/sdk` are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- `getProjectModelPicker()` plus `kortix.projects.modelPicker` and
  `kortix.project(id).modelPicker()` for the compact, connection-aware selector
  catalog; the existing `llmCatalog` remains the complete runtime catalog.
- Typed GitHub repository branch discovery through
  `kortix.github.listRepositoryBranches(accountId, installationId, repoFullName)`,
  including GitHub's default branch and branch protection metadata.
- The root entry `@kortix/sdk` is now canonical: it exports the whole
  framework-free surface (client, session, turns, files, event stream, errors).
- CDN builds: a minified ESM bundle (`dist/kortix.esm.min.js`) and an IIFE
  exposing `window.Kortix` (`dist/kortix.global.js`), wired via
  `publishConfig`'s `browser`/`unpkg`/`jsdelivr` fields. Usable from a
  `<script>` tag with no bundler.
- `KortixMasterProject` — the kortix-master daemon's board project.
- `@kortix/sdk/internal/*` for the zustand stores. Not covered by semver.

### Deprecated
- The 20 legacy subpaths (`/projects-client`, `/turns`, `/files`, `/session`,
  `/event-stream`, the stores, …). They still work. Import from the root.
- `KortixProject` **as exported from `@kortix/sdk/opencode-client`** — renamed to
  `KortixMasterProject`. The platform's `KortixProject` (from the root) is
  unchanged and keeps its name.

### Fixed
- `getPlatformUrl()` no longer reads a bare `process.env`, which threw a
  `ReferenceError` in a browser `<script>` bundle and on React Native.
- The HTTP layer (`backendApi`/`makeRequest`) now transparently retries transient
  `502`/`503`/`504` responses on idempotent reads (`GET`/`HEAD`) up to two times
  with 250ms → 500ms backoff. Mutations and HTTP `500` responses are never
  retried.

### Internal
- `src/` is now tiered: `core/` (isomorphic), `browser/`, `node/`, `react/`.
  A file's directory declares what it may import, enforced by the tripwire.
- A bare-global tripwire (`process`/`window`/`document`/`localStorage`/
  `sessionStorage`) now runs over `core/`, with `safeEnv()` extracted to
  `core/http/env.ts` as the one sanctioned way to read an env var from
  isomorphic code.
- `turns/index.ts` (1434 loc) split into `parts`/`grouping`/`shell`/`state`.
- CI now packs, installs, and imports the tarball, and asserts the two export
  maps agree.
- The install smoke test (`pnpm run smoke:install`) packs `@kortix/llm-catalog`
  alongside the SDK at a synthetic version and installs both tarballs
  hermetically, since the `workspace:*` dependency between them gets pinned to
  the release version at publish time.

## 0.2.0

Headline: **"Kortix as a Backend"** — everything a third-party server needs to
safely wrap Kortix on behalf of multiple concurrent end users, plus a
framework-free headless chat kit and a batch of previously web-local REST
domains promoted into the facade.

### Added

- **`@kortix/sdk/server`** — `runWithKortix(config, fn)` / `createScopedKortix(config)`.
  Per-request platform-config isolation via Node's `AsyncLocalStorage`, so a
  multi-tenant wrapper backend can safely handle concurrent requests carrying
  different end-user tokens without racing on the process-global
  `configureKortix()` singleton. Never reachable from the root `@kortix/sdk` or
  `@kortix/sdk/react` entry points, so `node:async_hooks` never enters a
  browser bundle.
- **Headless chat kit** — `classifyPart`/`classifyTurn`/`toolInfo`/`ToolView`
  (`@kortix/sdk/turns`, also re-exported from the root barrel) normalize every
  opencode part kind (text, reasoning, tool, file, subtask, patch, snapshot,
  agent, retry, compaction, step) into a typed, compile-time-exhaustive
  `ClassifiedPart` — plus `KortixChatEvent`/`narrowChatEvent` (a curated
  14-member event union narrowed from the raw ~50-variant SSE wire union) and
  `useChatTurns`/`renderParts`/`PartRenderers` (`@kortix/sdk/react`), a
  React binding that requires a renderer for every part kind at compile time.
- **`session(pid, sid).stream()`** — a framework-free facade over the
  `openEventStream` primitive, bound to that handle's own resolved runtime.
  Safe to call from a server-side wrapper, a worker, or a CLI — no React
  required. `@kortix/sdk/react`'s `useOpenCodeEventStream` is now a thin
  wrapper over the exact same primitive.
- **`session(pid, sid).files`** — the same 12-op workspace-files surface as
  the top-level `files` export, but bound to THIS session's own runtime
  instead of the process-global "active" sandbox — fixes cross-session bleed
  for a host juggling multiple concurrently open sessions.
- **`session(pid, sid).ensureReady()` concurrency dedup** — concurrent calls
  for the same `(projectId, sessionId)` now ride a single in-flight `/start`
  long-poll instead of each issuing their own.
- **New facade namespaces**, all with client fns already in
  `@kortix/sdk/projects-client`:
  - `accounts.tokens` / `project(id).tokens` — CLI PAT minting (account- and
    project-scoped `kortix_pat_...` tokens).
  - `billing.*` — `accountState`, `accountStateMinimal`, `transactions`,
    `transactionsSummary`, `creditBreakdown`, `usageHistory`,
    `tierConfigurations` (read-only entitlement/usage surface), plus a curated
    mutation surface: `billing.checkout.{createSession, confirmSession}`,
    `billing.subscription.{createPortalSession, cancel, reactivate,
    scheduleDowngrade, cancelScheduledChange, prorationPreview}`,
    `billing.credits.{purchase, autoTopupSettings, configureAutoTopup}`.
  - `project(id).marketplace` / `.registry` — install/list/updates/update/
    updateAll/remove for a catalog item on a project's default branch.
  - `marketplace.*` — public marketplace catalog browse + sources
    (`items`, `item`, `itemFile`, `marketplaces`, `featured`,
    `sources.{list,add,remove}`), top-level and distinct from the
    install-scoped `project(id).marketplace`.
  - `session(pid, sid).transcript()` — compact server-side transcript read
    (text + tool calls, no tool inputs/outputs), callable with project-scoped
    session tokens.
  - `project(id).changeRequests.requestChanges()` — Review Center feedback on
    a change request.
  - `accounts.audit.*` — Enterprise audit log (`log`, `export`, `webhooks.{list,create,update,remove}`).
  - `project(id).setupLinks.{requestSecret, requestConnector}` —
    agent-minted, short-lived links for a human to enter a secret value or
    1-click connect a Pipedream app, without the agent seeing the credential.
  - `project(id).validateManifest(raw)` / `project(id).gitToken()` —
    server-side `kortix.toml` validation and scoped git push token minting
    for a managed project.
  - `project(id).channels.slack.{getFile, uploadFile}` /
    `project(id).channels.meet.speak(botId, text, voice?)` — Slack file
    download/upload proxy and the Meet bot "speak" action.
  - `project(id).gateway.playground(prompt, models)` — run one prompt
    against up to 6 models side by side.
  - `validateToken()` — pasted-API-key validation helper (`GET /accounts/me`,
    never throws).
- **Domain hooks** (`@kortix/sdk/react`) — `useProjectSecrets`,
  `useProjectTriggers`, `useChangeRequests`: thin React Query bindings with
  their own query key + invalidation-wired mutations, over CRUD surfaces that
  previously had a client fn but no SDK-owned hook.
- Root barrel (`@kortix/sdk`) now type-only re-exports the full set of domain
  result types (`ProjectDetail`, `AccountState`, `GatewayOverview`,
  `MarketplaceInstalledItem`, `AuditEvent`, `AccountToken`, …) from
  `platform/projects-client`, so a consumer can name a facade call's return
  type without a second import.
- **`examples/`** — six runnable, self-contained scripts covering the facade
  (list projects), send+stream, the server wrapper pattern, transcript
  rendering, cost pass-through/re-billing, and files+secrets. Typechecked via
  `examples/tsconfig.json` as part of `pnpm typecheck`.

### Changed

- **One typed error hierarchy across every HTTP layer.** `ApiError`/`AuthError`
  are now real classes (`instanceof`-able, enumerable `message`, `name`/shape
  preserved for legacy string-sniffers) instead of ad-hoc
  `Object.create(Error.prototype)` objects — and every layer (`backendApi` /
  `platformFetch`/`authenticatedFetch`, the files client, the opencode client,
  `ensureReady()`) now throws/returns the SAME classes instead of duck-typed
  shapes. `BillingError`/`RequestTooLargeError` + their helpers
  (`parseBillingError`, `isBillingError`, `formatBillingErrorForUI`) are
  exported from the root barrel and `@kortix/sdk/api-client`, not just
  `@kortix/sdk/react` — a server-side wrapper can now `instanceof BillingError`
  a 402 and pass the cost/upgrade payload straight through to its own client
  without importing a React-flavored subpath.
- **30-second default request timeout** on `authenticatedFetch` and the
  `backendApi`/`platformFetch` layer, so a hung sandbox/daemon request can't
  wedge a "Kortix as a Backend" server handler forever. The long-lived SSE
  event-stream endpoint (`/global/event`) is explicitly exempted.
- `getAuthTokenWithRetry`'s `attempts`/`baseDelayMs` options now actually
  drive a retry loop (previously accepted but not applied).
- `previewUrl()`/`proxyUrl()` tolerate a relative `backendUrl` (a same-origin
  BFF proxy pattern) by resolving against the page origin in the browser, and
  now read the LIVE platform config instead of the config captured at
  `createKortix()` time — so a host that calls `configureKortix()` again after
  creation (e.g. switching into wrapper mode) is followed correctly.

### Fixed

- `session(pid, sid).stream()` — the README documented this method before it
  existed; the API-MAP gap is now closed with a real, tested implementation.
- `API-MAP.md`'s transcript row previously read "✅" with no client function
  actually behind it — `getSessionTranscript`/`session(pid,sid).transcript()`
  are now genuinely wired, and the doc reflects that.

## 0.1.0

Initial internal release — the single opinionated `createKortix()` facade
over the Kortix REST API + OpenCode v2 runtime, `@kortix/sdk/react` hooks,
the workspace files client, and the framework-free session/transcript/event-
stream primitives.
