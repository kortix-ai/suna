# Changelog

All notable changes to `@kortix/sdk` are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- `useModelPicker` (`@kortix/sdk/react`) — the unified model-first picker
  view-model. Folds the catalog-vs-harness fork (`agentModelPolicy`) into one
  shape (`ModelPickerViewModel`/`ModelPickerGroup`/`ModelPickerItem`) so a
  consuming component never branches on harness; pure derivation over the
  existing `useComposerCapabilities`/`useComposerModelCatalog`/
  `useHarnessConnections` hooks, plus a live ACP session's own advertised
  config options when present. `buildModelPickerViewModel` is exported
  alongside it as the pure, fixture-testable projection.
- `clearOpenPrompts` (`@kortix/sdk/acp`) — supersedes every open ACP prompt in
  reducer state the same way a `session/cancel` would, without touching
  `envelopes`/`chatItems`/`dedupeKeys`. Backs `AcpSession`'s persisted-busy
  reload-recovery wedge guard; additive export.
- `packages/sdk/src/acp/README.md` — the ACP protocol/transport reference:
  the 3-identity model, the session-scoped transport and daemon bridge
  contract, the shared `sse-core.ts` SSE parser and its three consumers, the
  durable envelope-log laws (including the honest DISC-05 open exception),
  the `AcpSession` store, and the OpenCode-wire deprecation pointer.
- Project branch responses now expose the current caller's effective session
  base ref (project or group default), and group-grant mutations can set or
  clear an optional `default_base_ref`. Existing fields and call signatures
  remain compatible.
- `getProjectModelPicker()` plus `kortix.projects.modelPicker` and
  `kortix.project(id).modelPicker()` expose the compact, connection-aware
  selector catalog; the existing `llmCatalog` remains the complete runtime
  catalog.
- Typed GitHub repository branch discovery through
  `kortix.github.listRepositoryBranches(accountId, installationId, repoFullName)`,
  including GitHub's default branch and branch-protection metadata.
- The root entry `@kortix/sdk` is now canonical: it exports the whole
  framework-free surface (platform client, ACP client/projections, session,
  turns, files, and errors).
- `AcpClient`, `useAcpSession`, and the canonical ACP-only `useSession()`
  lifecycle: initialize, new/load, prompt/cancel, config options, permission and
  question responses, session-scoped SSE, replay, and raw durable transcripts.
- Harness-neutral ACP chat/tool/plan/context/usage/pending-prompt projections
  shared by web, mobile, and headless consumers.
- React Native automatically consumes live ACP state by polling the durable
  transcript because its fetch implementation does not expose incremental SSE
  response bodies.
- CDN builds: a minified ESM bundle (`dist/kortix.esm.min.js`) and an IIFE
  exposing `window.Kortix` (`dist/kortix.global.js`), wired via
  `publishConfig`'s `browser`/`unpkg`/`jsdelivr` fields. Usable from a
  `<script>` tag with no bundler.
- `KortixMasterProject` — the kortix-master daemon's board project.
- `@kortix/sdk/internal/*` for the zustand stores. Not covered by semver.

### Deprecated

- The remaining legacy subpaths (`/projects-client`, `/turns`, `/files`,
  `/session`, the stores, …). They still work. Import from the root.
- The daemon-project `KortixProject` alias — renamed to `KortixMasterProject`.
  The platform's `KortixProject` (from the root) is unchanged and keeps its name.
- The OpenCode-wire projection stack (`transcript.ts`'s `formatTranscript` /
  `TranscriptOptions` / `SessionInfo` / `MessageWithParts` /
  `DEFAULT_TRANSCRIPT_OPTIONS`; `core/turns/classify.ts`'s `classifyPart` /
  `classifyTurn`; `core/turns/view-model.ts`'s `toolViewModel`;
  `core/turns/tool-registry.ts`'s `toolInfo`; `react/chat/use-chat-turns.ts`'s
  `useChatTurns` / `TurnView`) — superseded by the ACP projection layer
  (`acpTranscriptMarkdown`/`acpTranscriptHtml`/`projectAcpChatItems`). JSDoc
  tags only; every export keeps working (`apps/whitelabel-demo`'s chat rendering
  and `apps/web`'s transcript-export modal still depend on it directly;
  `apps/mobile` uses a hand-forked local copy, and `?oc` deep-links are
  unrelated to this stack — see the WS3-P3-a consumer inventory). A golden
  parity harness (`core/turns/__fixtures__/opencode-wire-mixed.json` + three
  captured golden outputs, asserted by `transcript.golden.test.ts`) now pins
  current output so a future removal has a contract to satisfy or explicitly
  break against. Removal itself is deferred to a future cycle.

### Fixed

- Native ACP `session/load` history replay no longer appears as duplicate
  user/assistant turns after reload or reconnect. The durable envelope log
  remains lossless; only semantic chat/context/transcript/export projections
  classify load-scoped update notifications as bootstrap history. `AcpSession`
  applies the same rule to live SSE replay emitted while the load RPC is still
  in flight, so the active page does not show a transient extra copy.
- `session/load` replay frames that arrive AFTER the load response row — the
  API bridge's split SSE/POST channels let the response overtake the
  still-persisting replay stream, so the load-window rule above cannot bracket
  them — are now recognized by content identity instead of ordering, covering
  every harness replay shape: same-id re-walks (claude paragraph fragments,
  opencode part re-delivery) via a per-stream prefix-walk cursor that may only
  start when the latest load postdates the stream's last growth; new-id
  consolidated chunks (codex `item-N`) via whitespace-trimmed full-text match
  against a finished same-role stream; and id-less complete messages (pi) via
  trimmed full-text match against an existing same-role chat item. All checks
  require a `session/load` to have been folded, so never-reconnected sessions
  render exactly as before.
- `getPlatformUrl()` no longer reads a bare `process.env`, which threw a
  `ReferenceError` in a browser `<script>` bundle and on React Native.
- The HTTP layer (`backendApi`/`makeRequest`) now transparently retries transient
  `502`/`503`/`504` responses on idempotent reads (`GET`/`HEAD`) up to two times
  with 250ms → 500ms backoff. Mutations and HTTP `500` responses are never
  retried.
- The cloud API's ACP SSE proxy (`apps/api/src/projects/lib/acp-sse-proxy.ts`)
  and the headless ACP engine
  (`apps/api/src/projects/session-lifecycle/headless-acp.ts`) now both consume
  the SDK's shared `sse-core.ts` block parser instead of their own hand-rolled
  parsing, fixing two latent defects the consolidation surfaced: the proxy
  could silently drop or misparse a block whose `\r\n\r\n` terminator split
  across a chunk boundary (no CRLF holdback), and the headless engine could
  kill an entire prompt/response cycle on a single malformed SSE payload (no
  poison-event tolerance).

### Removed

- Kortix application/public SDK dependency on `@opencode-ai/sdk`, the OpenCode
  HTTP runtime client, global event stream, OpenCode session mapping, and
  OpenCode-named React hooks/stores. OpenCode remains supported only as one ACP
  harness behind the same protocol as Claude Code, Codex, and Pi.

### Internal

- `acp/sse-core.ts` extracted from `AcpClient`'s previously module-private
  `consumeSse` (`createSseBlockParser`, `isDeliverableSseBlock`,
  `isAcpResponseEnvelope`) — behavior-preserving, parity-pinned before and
  after extraction. Now the one SSE block parser shared by the SDK client,
  the cloud API's SSE proxy, and the headless ACP engine (previously each
  maintained its own copy). Additive runtime/type exports.
- `AcpSession` (`acp/session.ts`) recovers from a reload mid-turn:
  bootstrap-from-history already surfaced a persisted, unanswered
  `session/prompt` as `turnState.busy`; a new signal-based wedge guard
  (`clearStalePersistedBusy`, triggered by a terminal bootstrap failure or
  the live stream reaching connection state `'failed'` — never a wall-clock
  timeout) now clears that stale busy state when the turn is provably dead,
  instead of leaving it wedged indefinitely. A harness that dies without
  either signal ever surfacing is a stated residual case, not silently
  covered — `send()`/`cancel()` already supersede persisted-only busy
  regardless.
- Bounded history/dedupe growth: `AcpSession`'s internal `historyOrdinals`
  (an unbounded per-row `Set<number>`) is now a single
  `historyHighWaterMark` scalar, sound because transcript ordinals are a
  strictly-increasing identity column and history is always replayed from
  the full transcript. The reducer's `dedupeKeys` (a public-function-facing
  structure) instead uses a bounded 256-entry recency window, since an
  external caller can feed it out-of-order rows a bare high-water mark could
  misclassify.
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
  `platformFetch`/`authenticatedFetch`, the files client, the runtime client,
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
