# `@kortix/sdk` — progress

**Single source of truth for _state_** across every session and every plan. Not for
design (that's a spec) and not for _how_ (that's a plan). This file indexes them.

> **Multiple sessions run against this repo.** Read this file **before** starting
> work, and update it **before** ending your turn. Both are mandatory.

**Scope:** everything `@kortix/sdk`. The **Now** section below tracks one plan at a
time. Work outside that plan lives in **Next** and **Backlog** — it is real, it is
tracked, and it is not forgotten just because it isn't scheduled.

---

### 2026-08-26 — session `session-ux-ws-k` — a fresh Bedrock workspace never auto-seeds a bare in-region id — DONE

**Files:** `react/provider-selection.ts` (`nativeProviderListFromCatalog`: the
per-provider `default` fallback is now `autoSeedDefaultModel(models)?.id`
instead of `models[0]?.id`, and the newest-first model sort gained
`bedrockInferenceProfileRank` as a tie-break so the profile precedes its bare
twin in insertion order). Shared rule added in `@kortix/llm-catalog`
(`autoSeedableModels` + `autoSeedDefaultModel`), reused by the API's
`providerFlagship` so the gateway and native default paths cannot drift.

**Why.** Proven live on the Essentia self-host 2026-08-26: a brand-new
workspace with Bedrock BYOK creds (`AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION`,
llm_gateway OFF) auto-selected `xai.grok-4.6`. Bedrock refused it
("Invocation of model ID xai.grok-4.6 with on-demand throughput isn't
supported. Retry your request with the ID or ARN of an inference profile") and
the session looped "Retrying in Ns" forever — every fresh workspace wedged out
of the box. `xai.grok-4.6` is the NEWEST Bedrock model in the 2026-08-25
catalog AND the one family with no `global.`/`us.` twin, so PR #6897's
release-date tie-break could not save it. New rule: when a provider's set
carries ANY inference-profile id, its bare ids are not AUTO-selectable. They
stay listed and pickable; nothing picks them for the user. Inert for every
non-Bedrock provider (no id has rank > 0).

**Public surface: unchanged** — `nativeProviderListFromCatalog`'s signature and
shape are identical; only which id lands in `default[providerId]` changed.

### 2026-08-26 — session `session-ux-ws-b` — a 503 is never an empty transcript + read cancellation — DONE

**Files:** `core/http/opencode-errors.ts` (NEW `SandboxNotReadyError` class; its
message always matches `isSandboxNotReadyError`) ·
`browser/session-sync/session-sync-registry.ts` (`readSessionMessagePage`
CLASSIFIES the resolved result — 503/not-ready body → `SandboxNotReadyError`,
other `error`/≥400 → real throw, only a genuine 2xx returns a page; threads an
optional `AbortSignal` into `client.session.messages`) ·
`core/session-sync/session-sync-controller.ts` (`loadPage` gains an optional
`signal` param; one controller-lifetime `AbortController` aborted in
`destroy()`; `loadTail` catch classifies — abort → no-op, not-ready →
freshness `loading` + backoff retry (existing 1s→15s cap), real error →
`error`; the framework-free HTTP loader throws `SandboxNotReadyError` on 503
and forwards the signal) · `react/use-session-sync.ts` (+`retryTranscript`) ·
`react/use-session.ts` (forwards `freshness` + `retryTranscript`). Host:
`apps/web` session-chat gates the empty transcript on freshness (error →
retry card, loading → loader) and the older-load sentinel re-arms only after
leaving the rootMargin zone (`nextOlderAutoloadArm`).
**Public surface: additive only** — `SandboxNotReadyError` (both snapshots
regenerated; diff shows additions only) and two new fields on published hook
returns.

**Why.** FINDINGS-B: the generated OpenCode client RESOLVES with `{ error }`
on non-2xx, and `readSessionMessagePage` read `result.data ?? []` — a
cold-boot 503 became a success-looking empty page, `hydrate([])`, freshness
`'fresh'`, and the thread rendered blank-and-complete with no retry. Also: no
cancellation (a superseded read could hydrate a navigated-away store), and a
short-turn prepend could chain older-pulls in one paint.

**Gates:** `npx tsc --noEmit` clean (sdk, exit 0) · `bun test --isolate src`
**2562 pass / 0 fail** across 172 files (session baseline 2547/172; +9 tests
here, +6 from concurrent WS-A) · `pnpm run smoke:install` passed · both
surface snapshots regenerated, diff additive-only · apps/web: targeted
session tests 19 pass / 0 fail, eslint 0 errors on touched files, `tsc`
noise limited to the known `@types/bun` `test.each` files.

---

### 2026-08-26 — session `session-ux` (WS-A) — routine boot progress is not a runtime error; parked box does not arm the stall clock — DONE

**Files:** `src/react/use-runtime-reconnect.ts` (+ `runtimeErrorFromHealth`: only a
genuine `boot_error` becomes `store.runtimeError`; the routine boot
`reason`/`message` — e.g. `{status:'starting', reason:'schema not ready'}` — is
progress, never an error. The `booting` branch now distinguishes a PARKED box —
`hop === 'control_plane'`, the platform answered from the session row without
dialling the box — from a genuinely booting one: parked does not report
`connected` and does not arm the stall clock) ·
`src/browser/stores/sandbox-connection-store.ts` (`setOpenCodeHealth` gains an
optional `options?: { parked?: boolean }` 4th param — additive, existing callers
unchanged; parked clears/never arms `bootingSinceAt`) · tests in
`use-runtime-reconnect.test.ts` (RED first, then GREEN).
**Public surface: additive** — one new export (`runtimeErrorFromHealth`) and one
optional trailing param on `setOpenCodeHealth`; no renames, no removals.
Snapshots regenerated (the diff also picked up `SandboxNotReadyError` from
concurrent WS-B work in the same worktree).

**Why.** RC-1/RC-3 of the session-ux runtime-status pass: the boot `reason`
string landed in `runtimeError` and the web route painted a terminal "OpenCode
runtime is not ready" card during every normal cold boot; a parked (idle)
sandbox's control-plane 503 armed `bootingSinceAt`, so after 45s the composer
latched "Still waking… taking longer than usual" forever over a box that only
resumes on the next send.

**Gates:** `tsc --noEmit` (main + examples) clean · `bun test
src/react/use-runtime-reconnect.test.ts` 46 pass 0 fail · surface snapshot
tests pass after regen · smoke:install run recorded in the session report.

---

### 2026-08-25 — session `effort-unify` — gateway picker carries variants + raw picker hook — DONE

**Files:** `src/react/provider-selection.ts` (`projectLlmCatalogToProviderList`
derives `variants` from `reasoning_options` via `@kortix/llm-catalog`'s
`generationControlCapabilities`; an API-sent `variants` map wins) ·
`src/react/use-project-models.ts` (+ `useProjectModelPickerCatalog`, the raw
`/model-picker` record, same query key as `useProjectModels`) · tests.
**Public surface: additive** — one new hook export from `@kortix/sdk/react`; no
renames, no removals, no subpath change.

**Why.** On-gateway the picker list never carried `variants`, so the composer's
Thinking control (`Object.keys(model.variants)`) had nothing to offer and the
only effort path was a project-level routing-policy write from the composer
(#6872 split the knob by mode). Now both modes expose the model's own tiers as
the session variant; the sandbox publishes the same ids on the `kortix`
provider (apps/kortix-sandbox-agent-server, follow-up PR) and the gateway
forwards / refuses (400 `unsupported_param`) per upstream family.

---

### 2026-08-25 — session `opencode-bump-11823` — OpenCode 1.18.19 → 1.18.23 lockstep — DONE

**Files:** `package.json` (`@opencode-ai/sdk` 1.18.23) · `packages/shared/src/runtime-versions.json`
(`opencode` + `opencodeSdk`) · shared Dockerfile goldens. **Public surface: no
changes** — `@opencode-ai/sdk` 1.18.19→1.18.23 changes one line each in
`v2/gen/types.gen.ts` / `sdk.gen.ts` (the `global.upgrade` payload); the
type-surface snapshot is byte-identical.

**Why.** Essentia (native mode) ran `amazon-bedrock/global.openai.gpt-5.6-sol`
and every reasoning stream died on `contentBlockDelta.delta.reasoningContent.redactedContent`
failing schema validation. Upstream anomalyco/opencode#43686 → #43909 bumped
`@ai-sdk/amazon-bedrock` 4.0.112→4.0.158 (adds `redactedContent`); first
release carrying it is v1.18.22. We pinned 1.18.19.

**Gates:** `pnpm typecheck` clean · `pnpm test` 172 files 0 fail ·
`public-type-surface.test.ts` pass · api `config-deps-version.test.ts` pass ·
shared sandbox suite 72 pass (goldens regenerated).

### 2026-08-25 — session `native-catalog-status` — pre-boot picker hides deprecated models like the runtime — DONE

**Files:** `react/provider-selection.ts` (`nativeProviderListFromCatalog` drops
`status === 'deprecated'` for every provider) + test. Cross-package:
`packages/llm-catalog` `CatalogModel.status?`, `apps/api`
`runtime-catalog.ts` passthrough + test, `apps/web/scripts/enrich-llm-catalog-capabilities.ts`
(baked path keeps the same field set). **Public surface: `CatalogModel` gains
an optional field** (additive; type-surface snapshot unchanged).

**What.** Dev verification of the merged picker (#6872) on a native project:
pre-boot listed 16 OpenCode Zen free models, the running box served 7. The
box's own `~/.cache/opencode/models.json` had all 29 — opencode hides the 22
marked `status: "deprecated"` (core plugin: `enabled = status !== "deprecated"`).
Our `/llm-catalog/providers` route whitelists model fields and dropped
`status`, so the pre-boot source could not apply the rule. Now it can, for
every provider, not only Zen.

**Gates:** `pnpm typecheck` clean · `pnpm test` (see run) · type-surface pass.

### 2026-08-25 — session `native-picker-unify` — ONE native picker across sandbox states + no dead effort chip — DONE

**Files:** `react/provider-selection.ts` (NEW pure `mergeNativeProviderLists`;
`nativeProviderListFromCatalog` now lists OpenCode Zen's free models keyless,
ranked last) + tests · `react/use-opencode-sessions/providers.ts` (the
`native-catalog` query stays enabled after boot; native mode returns the
catalog ∪ runtime merge, never a source swap) ·
`react/use-gateway-routing-policy.ts` (`llmGatewayEnabled` beside `data`) +
test. **Public surface: no barrel changes** (additive field on the routing
hook result; type-surface snapshot unchanged).

**What.** Two field reports on the native path. (1) "the model pickers are
different when the sandbox isn't started and when it is" — pre-boot the picker
read the catalog synthesis, post-boot the runtime list; the two disagreed on
provider order, on Zen (runtime auto-connects `opencode` free models keyless),
and on the auto-picked default (runtime `default` is catalog-file-order). Now
the catalog list is the skeleton (order + curated flagship default), the
runtime provider object replaces each shared id (real variant settings, the
box's exact models), runtime-only providers append, and a catalog default
survives only while the runtime serves that model. (2) "2 thinking mode
selections" — the composer's reasoning-effort chip is a gateway routing-policy
control; the hook's query is disabled off-gateway, but a disabled query still
serves cache residue, so `data.capabilities.write` kept the chip alive beside
the model's real THINKING MODE variants. The hook now states the flag; the
web chip requires it.

**Gates:** `pnpm typecheck` clean · `pnpm test` 172 files 0 fail ·
`public-type-surface.test.ts` pass · `pnpm smoke:install` pass.

### 2026-08-24 — session `fabricated-idle-veto` — a fabricated idle frame can no longer contradict the ledger — DONE (PR open, not merged)

**Files:** `core/session/working.ts` (`WorkingStreamInput.origin?: 'wire' | 'local'`;
the idle-frame veto and the "fresher frame outranks the open row" ordering now apply
to WIRE frames only) · `react/use-session-working.ts` (`buildWorkingInputs` threads
`statusOrigin`; the hook reads `sessionStatusOrigin`) ·
`browser/stores/sync-store.ts` (`sessionStatusOrigin` slice; `setStatus(id, status,
origin='wire')`; same-value writes keep object identity but may flip origin;
`clearSession` marks its fabricated idle `local`; `applyEvent` honors a
`synthetic: true` event marker) · `react/use-opencode-events/use-event-stream-refs.ts`
(`markSessionIdleLocally` / `markSessionAbortedLocally` mark their events synthetic) ·
`react/use-opencode-events/index.ts` (hydrate snapshot writes are synthetic; the
fill-gap guard now lets a snapshot overwrite a `local` frame, so a wrong sweep
self-heals) + tests in all five areas.
**Public surface: additive only** — the optional `origin` field on
`WorkingStreamInput` and `statusOrigin` on `buildWorkingInputs`; snapshots unchanged.

**Why.** Reported from dev (2026-08-24): mid-turn — long `run command` /
tool calls — the busy indicator disappears, the composer swaps Stop for Send, the
transcript freezes (the liveness poll gates on the projection), and the UI comes
back for a couple of seconds right as the reply streams. Root cause: locally
fabricated idle frames (`reconcileMissingBusySessions` sweeping the GLOBAL status
map with a per-sandbox snapshot, `markSessionAbortedLocally` on
`server.instance.disposed`, `clearSession`) were indistinguishable from the
runtime's own frames, and the (deliberately unbounded, #6807) idle veto let one
fabricated frame discard every fresh `/turn` read for the rest of a quiet turn —
while the fill-gap guard blocked the snapshot from ever correcting the slot.

**Gates:** `typecheck` clean (both projects) · `pnpm run test` (isolated runner)
171 files / **2513 pass / 0 fail** · `smoke:install` passed.
**Known follow-ups (not done here):** the sweep is still scope-blind
(cross-sandbox absence fabricates local idles — now harmless to the projection but
still wrong for child-session raw-slot readers); a session whose ledger row is
lost server-side while its SSE is dead still freezes until visibility/remount.

---

### 2026-08-24 — session `llm-gateway-off` (follow-up) — native picker source BEFORE the runtime exists — DONE

**Files:** `react/provider-selection.ts` (NEW pure `nativeProviderListFromCatalog`)
+ tests · `react/use-opencode-sessions/providers.ts` (pre-runtime
`['project-providers', :id, 'native-catalog']` query; returned while the native
runtime query has no data). **Public surface: no barrel changes.**

**What.** Reported from the field right after the native-mode ship: "no models
shown after connecting api key". The native provider query is gated on
`runtimeReady` — on the project home / a cold session there is no opencode to
read, so the composer showed "No models available" and a key save changed
nothing until a sandbox booted. Gateway mode always had `/model-picker` for
this window; native mode now synthesizes its list from the ungated
`/llm-catalog/providers` + the project's secret names (members whose secret
read 403s degrade to empty until boot). Runtime truth still wins the moment it
exists.

**Gates:** `typecheck` clean · `bun run test` 2513 pass / 0 fail ·
`smoke:install` passed. Shippable: YES.

**Addendum 2 (field UX report):** the pre-runtime list rendered every
historical version + duplicate display names and no thinking-mode row — the
synthesized entries carried only {id,name,release_date}. They now pass through
the catalog's family/capabilities/limits/cost (the wire payload was always the
full `CatalogModel`; `ProjectLlmCatalogProviderModel` = that shared type now)
and synthesize variant IDS from `reasoning_options` mirroring opencode's own
`reasoningVariants` rule (effort values verbatim, budget_tokens → high/max) —
so newest-per-family curation, badges, and the THINKING MODE row behave
identically before and after the runtime loads. Type-surface snapshot
regenerated (+ProjectLlmCatalogProviderModel, additive).

**Addendum (same session):** the first live dev run auto-picked
`Hy-MT2-30B-A3B` (models.dev file order) and OpenRouter refused the first
message with "No endpoints found that support tool use". The synthesized list
now carries a per-provider `default` (flagship-candidate table mirroring the
API picker's, else most-recent release), ranks flagship-table providers first,
and orders models newest-first.

---

### 2026-08-24 — session `llm-gateway-off` — native-mode (flag off) model path — DONE

**Files:** `react/model-flatten.ts` (`flattenModels` gains optional
`{ providerMode: 'gateway' | 'native' }` — native flattens OpenCode's own
connected providers, still never the synthetic `kortix`) + tests ·
`react/use-opencode-local.ts` (passes the resolved mode) ·
`react/use-project-llm-gateway.ts` (NEW, internal: `useProjectLlmGatewayEnabled`
+ pure `projectDetailLlmGatewayEnabled`) + tests · `react/use-model-defaults.ts`,
`react/use-project-models.ts`, `react/use-gateway-routing-policy.ts` (all three
gateway-only queries now gate on the project's `llm_gateway` flag instead of
firing guaranteed `404 llm_gateway_disabled`).
**Public surface: additive only** — a new OPTIONAL second parameter on the
exported `flattenModels`; no new barrel exports (`use-project-llm-gateway` is
internal).

**What.** The platform's `llm_gateway` flag now defaults OFF (native OpenCode
model management: provider keys injected into the sandbox, native
`provider/model` refs). `flattenModels` hard-dropped every non-`kortix`
provider, so a native project's composer had ZERO models and refused to send;
the three gateway queries 404'd on every session page.

**Gates:** `typecheck` clean (both projects) · `bun run test` 2504 pass / 0
fail · `smoke:install` passed. Shippable: YES.

---

### 2026-08-24 — session `composio-connect-link-types` — generic connector authorization results — DONE

**Files:** `core/rest/projects-client/connectors.ts` + test and both public-surface snapshots.
**Public surface:** additive `ConnectorConnect*`, `ConnectorFinalizeResult`,
`ConnectToolkit*`, and `listConnectToolkits`; `AdminConnector.provider` adds `composio`.
**Gates:** typecheck; 45 connector tests; both public-surface snapshot tests.

---

### 2026-08-24 — session `html-preview` — an HTML file is served, never injected — DONE

**Files:** `core/session/static-file-preview.ts` (NEW: `staticFilePreviewTargets`,
`shouldRetryStaticFileHealth`, `STATIC_FILE_HEALTH_RETRY_MS`,
`STATIC_FILE_HEALTH_MAX_ATTEMPTS`) + `static-file-preview.test.ts` (NEW, 7 tests) ·
`react/use-static-file-preview.ts` (NEW: `useStaticFilePreview`) ·
`react/index.ts` (+1 barrel line) · both public-surface snapshots.
**Public surface: additive only** — `useStaticFilePreview` plus the
`StaticFilePreview` / `StaticFilePreviewStatus` types on `./react`.

**What.** Reported from dev: "any html … renders the html directly in browser
hence things dont work". The session panel's file viewer framed an HTML file
with `srcDoc`, which gives the document no URL at all — so `./style.css`,
`img/logo.png` and `app.js` had nothing to resolve against and every page
arrived as unstyled text. `sandbox=""` made its scripts inert on top of that.
The sandbox already ships the server that fixes it (static file server, port
3211); only the files viewer was wired to it, and it had hand-rolled the wiring.

**Fix.** One hook owns reaching that server — proxied `/open?path=…` URL, the
preview session, a bounded liveness wait, and a `retry`. Two things it does that
the hand-rolled copy did not: it reads `useActiveSandboxProxyContext()` rather
than freezing `deriveSubdomainOpts()` on mount (the documented `sandboxId: ''`
freeze), and `staticFilePreviewTargets` returns `null` until a sandbox binds
instead of addressing `http://localhost:3211` — the VIEWER's own machine, which
a probe can answer `200` for. The probe is `probePreviewPort`, so `401/403` reads
as our auth gate catching up rather than a dead sandbox.

**Gates:** `typecheck` clean (both projects) · `bun test` 2443 pass / 0 fail ·
`smoke:install` passed.

---

### 2026-08-24 — session `session-open-overfetch` — one read where there were three, one entry where there were two — DONE

**Files (SDK):** `core/session-sync/session-sync-controller.ts` (tail 20 -> 50,
older 50 -> 100 — the bytes are gone, so a page is ~2-7 kB a message) ·
`react/use-opencode-sessions/agents.ts` (its `/detail` read goes through the
canonical `qk.project.detail` entry via `fetchQuery` instead of a private
fetch) · `react/use-opencode-sessions/providers.ts` (its `/model-picker` read
goes through `qk.project.modelPicker` the same way). Web/API changes in the
same PR: history autoload only after the reader scrolls up; the audit badge no
longer drains the audit write queue and asks for 100 rows not 1000; the sidebar
probes seven IAM leaves in one `effective:batch`; the 4 MB provider catalog
bootstrap waits for idle.

**What.** A HAR of one cold session open on a self-host (322 requests,
7.35 MB) after the attachment strip: `message?limit=20` + two `before=` pages
fired on mount because 20 stripped messages do not fill a viewport and the top
sentinel sat inside its 400px margin; `/detail` and `/model-picker` each fetched
twice, concurrently, from hooks calling the fetcher directly under their own
keys; `/audit?limit=1000` 503'd at the 25 s deadline twice because the badge
poll awaited a bulk INSERT it never reads; seven sidebar probes = fourteen
round trips; and `llm-catalog/providers` was 4 MB, 55 % of the page, for a
Customize surface nobody had opened.

**Gates:** `typecheck` clean (both projects) · `pnpm test` (below) · apps/web
tsc + eslint clean, session + sidebar suites green · apps/api tsc clean,
project-audit tests green.

---

### 2026-08-24 — session `strip-attachment-bytes` — the transcript stops shipping file bytes — DONE

**Files (SDK):** `platform/auth-core.ts` (`DEFAULT_FETCH_TIMEOUT_MS` 30s -> 120s, with
the reason written on it). Everything else lives outside the SDK: the strip
itself is `stripInlineAttachmentBytes` in BOTH `apps/kortix-sandbox-agent-server`
(daemon proxy + new `GET /kortix/part/:sid/:mid/:pid`) and
`apps/api/src/sandbox-proxy` (second pass for sandboxes on an older daemon), and
`apps/web/.../sandbox-image.tsx` resolves the new `/kortix/part/…` reference
through the same authenticated runtime fetch as every other sandbox read.

**What.** On a real session (essentia, hundreds of image reads) the transcript
list at `limit=20` weighed 7-19 MB because every file part carried its whole
file as a `data:` url. The browser's 30 s fetch deadline killed five reads in a
row at 29.23-30.08 s, and the tail retry re-issued the whole thing — "downloading
more and more data" with nothing rendered. The same read answered in-VM in
276 ms. The bytes leaving the sandbox were the entire cost.

**Fix.** The list leaves without the bytes: oversized `data:` urls become a
reference to the daemon's part endpoint, fetched per part when the row is on
screen, `immutable` + ETag so it is asked once ever. Daemon e2e: a list with one
image went from 21,870 saved bytes to a 367-byte body. The fetch timeout is
raised so a large-but-legitimate response is no longer manufactured into a
failure by the client that asked for it; the API's own 50 s proxy budget still
bounds a wedged box.

**Gates:** sdk typecheck clean · `pnpm test` 2483 pass / 0 fail · daemon
841 tests exit 0 (+6 e2e) · api proxy 44 pass / 0 fail · web tsc + eslint clean,
session suite 2527 pass / 0 fail.

---

### 2026-08-24 — session `opencode-v1-normalization` — take over OpenCode's own v1 page handling — DONE

**Files:** `browser/session-sync/session-sync-registry.ts` (`readSessionMessagePage`
filters + sorts) + tests (+6).

**What.** We make the same v1 call OpenCode's own client makes —
`client.session.messages({sessionID, limit, before})`, cursor from the
`x-next-cursor` header — and then did none of what they do with the response.
Theirs (`packages/app/src/context/server-session.ts:566-583`):

```ts
const items = (response.data ?? []).filter((item) => !!item?.info?.id)
session: items.map((item) => cleanMessage(item.info)).sort(compareMessages)
part:    items.map((item) => ({ id: item.info.id,
           part: item.parts.filter((part) => !!part?.id).sort((a,b) => cmp(a.id,b.id)) }))
```

with `compareMessages` keyed on `time.created + id`
(`packages/app/src/utils/session-message.ts:15-21`).

Ours was `messages: result.data ?? []`. No filter, so a malformed row reached
the renderer — the shape behind "TypeError: t is not iterable". No sort, so
transcript order was whatever the wire said.

**Also settled by measurement, so nobody re-opens it.** The v2/durable surface
(`/api/session/{id}/history`, `/api/session/{id}/event?after=`) is present in
the SDK we already pin AND answers 200 through our proxy — but it is EMPTY for
sessions our runtime produces, because we prompt through v1
(`core/client/kortix.ts:1145`). Measured on a real 2-day-old session:
v1 `/session/{id}/message?limit=5` -> 15,429 bytes / 5 messages;
v2 `/api/session/{id}/message?limit=5&order=desc` -> 50 bytes / 0 messages;
v2 `/history` -> 0 events. Migrating reads to v2 would blank every existing
session. v2 also caps `limit` at 100 (400 above it). Do not migrate reads
without migrating writes, and note that existing sessions have no v2 history at
all.

**Gates:** `typecheck` clean (both projects) · `pnpm test` 2481 pass / 0 fail ·
apps/web tsc clean, session suite 2523 pass / 0 fail.

---

### 2026-08-24 — session `read-is-the-liveness-check` — a session page must never wait on a probe — DONE

**Files:** `core/session-sync/session-sync-controller.ts` (`markLoaded` on
SUCCESS only; `scheduleTailRetry` with backoff; destroy cancels it) + tests
(+4, one replaced) · `react/use-session-sync.ts` (the initial read no longer
waits for `runtimeHealthy`).

**What.** Two screenshots, same page: the SIDEBAR showed a session live with a
green dot while the MAIN PANE sat on "Waking the agent — this is taking longer
than usual". Elsewhere, a session opened completely blank while its runtime
terminal held the whole conversation.

One mechanism under both. `resolveSessionContentState` keeps the web app on its
loader while there are no messages, and exactly one thing produces messages:
`reconcile('initial')`. That read was gated on `runtimeHealthy === true`. So the
page's only exit from the loader was a health probe — and a box that is up while
failing its probe (loaded, mid-turn, slow) shows a spinner over a session that
could have been read the whole time. The sidebar reads the session list instead,
which is why one page gave two answers.

The blank came from the same function, eight lines away. `markLoaded` ran in a
`finally`, so a read that FAILED still told the store the session was loaded —
and the store plants an empty message list for that. A first read losing to a
waking box therefore RECORDED "this session has no messages", the UI painted an
empty conversation, and nothing came back: the mount had run, and the liveness
poll only turns on while a session is working.

**Fix.** `markLoaded` on success only — a successful read of zero messages is a
fact about the session, a failed read is a fact about nothing. Failures schedule
a retry with backoff (1s -> 15s cap) until one lands. And the read no longer
waits for the probe: it starts as soon as the sandbox is known, because THE READ
IS THE LIVENESS CHECK. Readiness is a byproduct of asking for what we wanted
anyway, not a precondition for asking.

**And the last blank.** The session OBJECT arriving is not the transcript
arriving — two different requests, and the message read is the one that loses.
`resolveSessionContentState` treated the first as proof of the second, so a
session whose read had not landed rendered the full shell — header, composer,
empty thread — over a long history. It now takes `transcriptLoaded` (the sync
hook's `isLoading`, which flips only when an authoritative read lands) and waits
for the read rather than for the metadata.

**And the blank thread whose reads ALL returned 200.** Measured from the
network panel (essentia, a run with hundreds of image reads):

```
message?limit=50            200   8,228 kB   30.39 s
message?limit=50            200  24,460 kB   48.76 s
message?limit=50&before=..  200  20,284 kB   35.74 s
message?limit=50&before=..  200  25,125 kB   29.23 s
-> 78,097 kB transferred, finish 3.8 min, NOTHING on screen
```

Fifty messages weigh 8-25 MB because the parts carry image bytes. The tail read
kept walking backwards until every assistant message had its parent prompt in
hand — so an assistant reply could never render above its own prompt — and
`hydrate` ran only when that walk ENDED. On a long turn the walk is the whole
session, serially, through the sandbox proxy.

The tail is now ONE page, rendered — what OpenCode's own client does. The window
may start on an assistant whose prompt is a page up; that is what OpenCode shows
too, and `loadOlder` (user-driven) still completes the turn, bounded by
`MAX_TURN_BACKFILL_PAGES`.

**Gates:** `typecheck` clean (both projects) · `pnpm test` 2467 pass / 0 fail ·
apps/web tsc clean, session suite 2523 pass / 0 fail.

---

### 2026-08-24 — session `reconcile-on-eviction` — close the hole the IndexedDB removal named — DONE

**Files:** `core/session-sync/fragment.ts` (NEW — `transcriptIsFragment`) +
`fragment.test.ts` (4 tests) · `core/session-sync/session-sync-controller.ts`
(`SessionSyncReason` += `eviction`) · `react/use-session-sync.ts` (subscribes
and repairs).

**What.** `5a7a43517f` removed the IndexedDB transcript mirror and said so in
its own message: "#6146 evicts a detached session's transcript, and a session
evicted while its agent runs comes back from SSE as a fragment; that repaint is
gone here and no reconcile is keyed on eviction, so an evicted-then-refilled
session can sit on a partial transcript until a reload. This PR does not address
that; it should land with, or before, a reconcile-on-eviction fix." It landed
without one. Reported the same day from live sessions: transcript blank or
starting mid-conversation while the runtime held everything.

**Fix.** The store already carries the exact signature. Eviction drops the
messages AND marks the id; every authoritative re-establishment — `hydrate`,
`clearSession`, `optimisticAdd` — clears the mark, and `applyEvent` does not. So
messages present while the mark is still set can only have come from frames that
arrived after the eviction: a fragment, by construction. `transcriptIsFragment`
names that, and `useSessionSync` subscribes to the store rather than checking
once, because the refill happens while the component is already mounted. The
successful read disarms it — `hydrate` clears the mark.

**Gates:** `typecheck` clean (both projects) · `pnpm test` 2460 pass / 0 fail ·
`smoke:install` passed · apps/web tsc clean, session suite 2517 pass / 0 fail.

---

### 2026-08-24 — session `transcript-convergence` — the transcript must catch up, and five things stopped it — DONE

**Files:** `core/session-sync/session-sync-controller.ts` (turn-end reconcile,
`SessionSyncReason` += `turn-end` | `visible`) + tests (+3) ·
`browser/session-sync/session-sync-registry.ts` (freshness renews only on
transcript frames) + tests (+2) · `browser/session-sync/visibility.ts` (NEW) +
tests (+4) · `react/use-session-sync.ts` (visible-reconcile effect;
`livenessBusy` no longer gated on the health probe) + tests (+1) ·
`react/use-opencode-events/rehydrate-targets.ts` (NEW) + tests (+3) ·
`react/use-opencode-events/stream-revival.ts` (NEW) + tests (+6) ·
`react/use-opencode-events/index.ts` (gap rehydrates every held transcript;
supplies `onParked`).

**What.** Reported from a live self-host with a screenshot: an 8m13s turn
FINISHED — the runtime's own terminal shows the complete answer — and the
browser's transcript stopped mid-turn under a spinner. Not a label bug. The
messages were never fetched.

The repair for a stream that drops content is the liveness poll: one bounded
tail read every 10s while a session is working. Four separate things could stop
it, and each one is the same mistake — the repair was gated on a signal that
fails in exactly the situation the repair exists for.

1. **`noteActivity()` renewed on EVERY frame** carrying the session id, and
   `checkLiveness` skips while activity is newer than the interval. A runtime
   emitting status frames while its message frames were lost kept postponing
   the poll built to catch the loss. Now only transcript-bearing frames renew.
2. **`setBusy(false)` stopped the poll with no final read.** Turn end is when
   a transcript is most likely to be short — the closing frames are the ones
   most often lost — and stopping there made the truncation PERMANENT. A busy
   session now always reads its own tail one last time (`turn-end`).
3. **`livenessBusy` was gated on `runtimeHealthy`.** The health probe is the
   thing that flaps; a loaded box that misses its deadline mid-turn lost its
   transcript repair for as long as the probe kept missing. The probe no longer
   decides. (`runtimeHealthy` stays on the published input shape, ignored.)
4. **The SSE-gap rehydrate only re-read sessions whose STATUS SLOT said busy** —
   and the slot is filled by the stream, so a gap wide enough to lose message
   frames is wide enough to lose the frame that marks the session busy. Every
   held transcript is re-read now.

Plus the case the user named directly: a backgrounded tab has its timers
clamped to about one a minute, so return is the moment the tab is least sure
what it holds. `onTabVisible` reconciles on the way back in.

**5. And the stream could die for good.** `openEventStream` PARKS after 8
consecutive hard failures and documents itself as terminal for that handle —
correct, and the point: a dead or archived sandbox should not be hammered
forever. But **nothing in this package supplied `onParked`**, so "terminal for
this handle" silently became terminal for the PAGE. No error, no retry, no
transcript updates until the user reloaded. `createStreamRevival` re-opens the
stream on the first cheap evidence that something may have changed — the tab
came back, the network came back, or 30s passed — exactly once per park, so a
genuinely dead box costs one connect attempt per interval instead of a storm.

**Gates:** `typecheck` clean (both projects) · `pnpm test` 2456 pass / 0 fail ·
`smoke:install` passed · apps/web tsc clean, session suite 2513 pass / 0 fail.

---

### 2026-08-24 — session `connection-projection` — one answer for "is this session connected" — DONE

**Files:** `core/session/connection.ts` (NEW — `SessionConnection`,
`SandboxLifecycle`, `SessionConnectionInputs`, `projectSessionConnection`,
`connectionIsFaulted`) + `connection.test.ts` (12 tests) ·
`core/session/index.ts` (barrel) · both surface snapshots (additive) ·
`apps/web/.../session-composer-readiness.ts` (+ optional `connection` input) ·
`apps/web/.../session-chat.tsx` (reads `project_sessions.status`, computes the
projection, passes it in).

**What.** The composer's waking notice was a FALLBACK: every specific branch
(ready / open server turn / unreachable / stalled) missed, so it asserted the
one thing nobody had checked — "this session is asleep." On a reload that fires
before any probe answers, which is every reload. Screen recording (dev,
2026-08-24 00:10): page reloads at 00:05, "Waking this session up… messages you
send will be queued" shows 00:11–00:13 over a session that streams at 00:13
with a live green dot. Nothing was waking. Nobody had looked yet.

A settle TIMER was the first attempt and the wrong shape — it guessed HOW LONG
to stay quiet instead of asking whether anything was wrong, so it was always
either too short (notice flashes over a live session) or too long (a genuinely
parked box announces itself late).

**Fix.** `projectSessionConnection` folds the four observers into one ordered
answer, and the order is the whole design: streamed CONTENT and a passing probe
mean `live` whatever else says; a failed probe means `unreachable`; only the
control plane's own `project_sessions.status` earns `waking`. Everything else
is `connecting` or `unknown` — a WAIT, not a fault, and a wait says nothing.
Stale status is safe in both directions because the probe outranks it: a stale
`stopped` under a live runtime still reads `live`, and a stale `running` over a
dead box still reads `unreachable`.

**Gates:** `typecheck` clean (both projects) · `pnpm test` 2456 pass / 0 fail ·
`smoke:install` passed · apps/web tsc clean (known `@types/bun` `test.each`
noise only), readiness suite 29 pass / 0 fail.

---

### 2026-08-24 — session `content-is-evidence` — the runtime's output is not an opinion about the runtime — DONE

**Files:** `core/session/working.ts` (+`WorkingActivityInput`, the content branch,
its expiry) + `working.test.ts` (+5 tests) · `browser/stores/sync-store.ts`
(+`sessionActivityAt`, `noteSessionActivity`, stamped on `message.updated` and
`message.part.updated`) · `react/use-session-working.ts` (subscribes and folds
it in) · both surface snapshots (one additive TYPE export).

**What.** Every input to `projectWorking` was an OBSERVER of the runtime: a
`/turn` poll, an SSE status frame, a health probe, an inbox read. The transcript
renders the runtime's actual OUTPUT, and that was not an input at all — so a
dropped status frame, or a poll throttled by a backgrounded tab, left the
composer showing its send arrow over a transcript that was visibly streaming
(screen recording, essentia 2026-08-23: 00:00–00:03 arrow with a live tool
spinner and a 19s timer on screen).

The same gap explains the rarer "Lost contact with this session's runtime while
a turn is still open": on return from a background tab both observations can be
older than their bounds while content is still arriving, and the projection had
nothing left that could speak for the runtime.

**Fix.** Content is now an input, bounded by the stream's own freshness rule and
outranking every observer inside that window — including an idle frame it
postdates. Quantized to 1s in the store so subscribing cannot re-render at the
stream's ~140ms rate.

**Gates:** `typecheck` clean (both projects) · `bun test` 2446 pass / 0 fail ·
`smoke:install` passed · apps/web tsc clean, session suite 2513 pass / 0 fail.

---

### 2026-08-23 — session `queued-prompt-invisible` — ask the inbox, not the runtime — DONE

**Files:** `react/use-session-send.ts` (`recoverFromSendFailure` takes
`inboxRowExists`) + `use-session-send.test.ts` (+3 tests). Additive optional
option — no export added, no signature broken.

**What.** Reported from a live self-host: stop a turn, send the next prompt, and
the SERVER queues and runs it while the tab shows nothing — no bubble, no queued
row, composer back on its send arrow. Everything appeared ~30s later under the
runtime's echo.

`recoverFromSendFailure` asked `client.session.messages()` — the RUNTIME — whether
the send survived. A prompt that goes to `POST .../prompts` is a control-plane
row waiting for admission and is not in OpenCode's transcript until the gate
delivers it, so that question always answers "no such message", and the recovery
deleted the user's bubble on the strength of it.

**Fix.** For an inbox-backed send the recovery asks the INBOX, addressed by the
`clientMessageId` the POST already carries. A row that exists means the send
succeeded however the response ended — the bubble stays and the receipt is
re-taken. No row means it really was lost. A lookup that itself fails keeps the
bubble: not knowing is not evidence of loss.

**Gates:** `typecheck` clean (both projects) · `bun test` 2441 pass / 0 fail.

---

### 2026-08-24 — session `invisible-message-running` — remove the IndexedDB transcript mirror — DONE

**Files:** `react/use-session-sync.ts` (both cache effects removed) ·
`browser/session-sync/session-transcript-cache.ts` + test (DELETED, 14 tests) ·
`browser/cache/idb-write-policy.ts` + test (DELETED, 8 tests) ·
`browser/cache/idb-sync-cache.ts` (write-policy stripped, `DB_VERSION` 2 → 3 so
`onupgradeneeded` drops what the mirror already wrote — **not on page load**:
`openDB` is lazy and its only remaining callers are `deleteSessionFromIDB` and
`clearSessionIDBCache`, so stale entries survive until a session delete or a
sign-out; they are inert, since nothing reads them) ·
`browser/cache/no-transcript-mirror.test.ts`
(NEW, 1 static import-graph tripwire). No public surface change — the seven
`*IDB*` exports stay and keep their contract.

**What.** Reported from dev: stop a thread, send a message, and the message runs
while the UI shows it dimmed and captioned "Queued — runs with your next
message". Part of that is the mirror added by #5837 and gated by #6810. The gate
(`transcriptSignature`) is STRUCTURAL — message count, total part count, tail id
— and neither change that ends a turn moves any of them: `time.completed`
stamped on the tail, and the `error` an abort stamps. Proved with a throwaway
probe: all three of "turn completed", "abort stamped", "tokens appended to the
same text part" leave the signature identical, so no write is queued.

A normal turn escaped by accident, because OpenCode appends a `step-finish` part
and that moves the part count. **A Stop appends no part at all.** So the disk
copy of a stopped thread held an assistant message with neither `time.completed`
nor `error` — which `core/turns/open-turn.ts` reads as a turn that is STILL
RUNNING. On the next cold paint `resolveWorkingTurn` picked it as the working
turn and dimmed every message after it to "Queued".

**Fix.** Remove the mirror rather than re-tune the signature. Its own test file
covered six cases, all structural; a shape-based freshness test cannot see a
turn end, and making it see one means hashing the bodies — which is the cost the
gate existed to avoid.

**Known cost, accepted:** opening a hibernated session no longer paints history
before the sandbox wakes (18.9s Daytona / 24.5s Platinum, measured in #5837). If
that is worth re-solving it needs a mirror keyed on the MESSAGE, not its shape.

**Left in place, deliberately:** the sync store's `hydrate(…, { source: 'cache' })`
branch and its `cacheSourcedIds` provisional-phantom reconciliation are now
unreachable (`fromCache` is never true). Inert, and a ~40-line excision inside a
2000-line store is its own change — recorded here as follow-up rather than done
in this one.

**Gates:** `typecheck` clean (both projects) · `bun run test` (`--isolate`)
**2420 pass / 0 fail**, 163 files — HEAD measured at 2441 across 164, and the
delta is exactly the 22 deleted minus 1 added · `smoke:install` passed ·
apps/web `bun test src/features/session` 2513 pass / 0 fail.

> **Trap for the next session:** the suite MUST be run as `bun run test`
> (`bun test --isolate src`). A bare `bun test src` shares module state across
> files and reports **477 pre-existing failures** that have nothing to do with
> your change.

---

### 2026-08-23 — session `session-memory-retention` — stop paying for the transcript twice a second — DONE

**Files:** `browser/cache/idb-write-policy.ts` (NEW: `idbFlushIntervalMs`,
`transcriptSignature`) + `idb-write-policy.test.ts` (NEW, 8 tests) ·
`browser/cache/idb-sync-cache.ts` (skips an unchanged write; a large transcript
writes less often). Internal module — not re-exported from the package barrel,
so no public surface change.

**What.** The IndexedDB transcript mirror rewrote the WHOLE transcript every
500ms for as long as a turn streamed, and `put()` structured-clones what it is
given — roughly 40MB/s of transient main-thread allocation on a 20MB transcript,
for a cache whose only job is to paint something on the next load. It is the
largest single allocator in a long session and a leading suspect for the tab
discards behind "my session reloaded itself".

**Fix.** Two levers, both pure and tested: do not write what is already written
(an O(messages) signature over counts and the tail id, never the bodies), and
write a transcript past 120 messages every 3s instead of every 500ms. A failed
flush drops its signatures so the mirror cannot get stuck claiming a write
landed.

**Gates:** `typecheck` clean (both projects) · `bun test` 2438 pass / 0 fail ·
`smoke:install` passed.

---

### 2026-08-23 — session `turn-end-flap-2` — the same flap, 42 seconds later — DONE

**Files:** `core/session/working.ts` (the veto is no longer gated on
`streamFresh`) + `working.test.ts` (+1 test, 1 rewritten) ·
`react/use-session-send.ts` (an abort TIMEOUT no longer settles the receipt).

**What.** An audit of the first fix found it incomplete. `idleFrame` was still
gated on `streamFresh`, so at `stream.atMs + STREAM_OBSERVATION_MAX_MS` the veto
vanished with no new input and a still-open ledger row put the composer back on
Stop — this time permanently, since an accepted turn's record is cleared only at
its deadline (240 minutes by default). Proven against the real function: idle at
+21s and +64s, `working` at +65.1s with identical inputs.

**Fix.** The freshness bound is about testifying to the PRESENT, and the veto is
not asked about the present: a turn that started before the frame has ended, and
that stays true however old the statement gets. A turn which resumed would have
produced a newer, non-idle frame — at which point it is not an idle frame at all.
The bound still gates every branch that reads `working` out of the stream.

Also: `awaitAbortSettlement` resolves `timed-out` when nobody answered, and that
was written into `AbortReceipt.settledAtMs` — 5s of clock in an evidence field,
which cleared `abortFloor` and brought the Stop button back mid-cancel.
`OPTIMISTIC_ABORT_MAX_MS` bounds an unanswered abort instead; that is what it is
for.

**Gates:** `typecheck` clean (both projects) · `bun test` 2427 pass / 0 fail.

---

### 2026-08-23 — session `turn-end-flap` — a finished turn does not un-finish itself — DONE

**Files:** `core/session/working.ts` (`endedByRuntime` is causal; `workingExpiryAtMs`
schedules no flip) + `working.test.ts` (+2 tests, 2 rewritten). No public surface
change — `TURN_END_LEDGER_LAG_MS` stays exported, now as a measurement rather
than a rule.

**What.** Reported from dev with three screenshots a second apart: the answer is
on screen and the composer is idle, then "Gathering thoughts…" and the Stop
button come BACK for a couple of seconds, then leave again. The runtime's idle
frame outranked the still-open ledger row for exactly `TURN_END_LEDGER_LAG_MS`
(3s) and then handed authority back. When the `kind:"end"` relay is DROPPED —
the documented failure mode, closed by a reconciliation sweep 15.1s late in this
file's own measurement — the row is still open for that whole window, so the UI
re-announced a turn that had already finished.

**Fix.** Time is not evidence. The veto now holds for as long as the idle frame
is the newest runtime observation; a turn that is really still running says so,
and any newer non-idle frame (`busy`/`retry`) hands the ledger back immediately
with no window to tune. A runtime that goes silent instead is still bounded by
`STREAM_OBSERVATION_MAX_MS`.

**Gates:** `typecheck` clean (both projects) · `bun test` 2426 pass / 0 fail ·
`smoke:install` passed.

---

### 2026-08-23 — session `terminal-ws-wake` — a terminal attach may wake a parked box — DONE

**Files:** `core/runtime/pty.ts` (`getKortixPtyWebSocketUrl` takes `{ wake }`) +
`core/runtime/pty.test.ts` (NEW, 3 tests) · `react/use-opencode-pty.ts`
(`getPtyWebSocketUrl` passes it through). Additive optional argument — no
export added, no signature broken.

**What.** The session Terminal panel looped `Reconnecting in Ns (code 1006)`
forever. A sandbox that idle-parks answers a WebSocket UPGRADE with
`503 sandbox not ready` (`resolvePreviewWsUpstream` in `apps/api`), and a
browser can only report a refused upgrade as close code `1006`. The HTTP data
path wakes a parked box on explicit user intent; the WebSocket path had no wake
branch at all, so nothing in the retry loop could ever resume the box — and the
panel's own `GET /kortix/pty` is a GET on a session-data port, which by policy
also never resumes. Reloading the page did not help.

**Fix.** A USER-INITIATED attach (panel mount, "Reconnect now") carries
`wake=1`; the API resumes a stopped box for a marked PTY attach only
(`shouldWakeStoppedSandboxForWsAttach`). Automatic backoff retries stay
unmarked, so polling and background reconnects still cannot resurrect a box.

**Gates:** `typecheck` clean (both projects) · `bun test` 2424 pass / 0 fail ·
verified live in a browser: parked box → `1006` loop → Reconnect now → row
`stopped`→`active` → `WebSocket connected` → `echo` executed in the shell.

---

### 2026-08-23 — session `commands-not-iterable` — a list endpoint must never hand back a non-list — DONE

**Files:** `react/use-opencode-sessions/shared.ts` (NEW internal `asRuntimeList`,
`cachedRuntimeList`) + `shared.test.ts` (+9 tests) ·
`react/use-opencode-sessions/commands.ts` (`useOpenCodeCommands` normalizes the
response and the localStorage placeholder). No public surface change — both
helpers stay inside `./shared`, which the barrel deliberately does not re-export.

**What.** `dev.kortix.com` threw `TypeError: t is not iterable` from a `useMemo`
and the session view fell into its error boundary ("Something went wrong").
Deminified, the frame is `detectCommandFromText`'s `for (const cmd of commands)`
in `apps/web` — so `commands` was TRUTHY but not iterable. It comes from
`useRuntimeCommands()` → `useOpenCodeCommands()`, which returned
`unwrap(client.command.list())` verbatim. `GET /command` is typed `Command[]`;
a runtime or proxy that answers a list route with an object body breaks that
type at runtime, and the bad value was also written to the localStorage
placeholder cache, so the crash survived a reload.

**Fix.** Normalize at the seam. `asRuntimeList` coerces a non-array list
response to `[]`; `cachedRuntimeList` treats a cached non-array as a MISS so a
poisoned placeholder refetches instead of painting. Every consumer
(`detectCommandFromText`, the slash menu's `slash-items`, `composer-logic`,
`command-attachments`) iterates the list unconditionally, so the guard belongs
here — one place — not at four call sites. `apps/web`'s `detectCommandFromText`
also grew an `Array.isArray` guard for defense in depth, matching its existing
per-item non-string `template` guard.

**Gates:** `typecheck` clean (both projects) · `bun test` — see PR.

---

### 2026-08-21 — session `session-busy-flicker` — display order was not an order — DONE

**Files:** `core/turns/grouping.ts` (`compareMessagesForDisplay` rewritten as two
segments) + `core/turns/display-order.test.ts` (new, 7 tests). No public surface
change.

**What.** Three prompts sent "who", "are", "you" rendered "who", "you", "are",
and assistant replies attached to the wrong user messages.

`compareMessagesForDisplay` switched ordering PER PAIR: wire-id order when both
ids were well-formed wire ids, `time.created` for every pair involving anything
else. A queued row carries a host-fabricated stamp, so two placed messages A, B
and one queued row S compared as A < B (by id), S < A (by time), B > S (by
time) — a cycle. `Array.prototype.sort` may emit any permutation of a cyclic
comparator and V8 switches algorithm with input length, which is why the order
looked random. `groupMessagesIntoTurns` walks the same sorted list to attach
assistant messages with no `parentID`, so the replies re-parented too, and a
queued row could sort ABOVE the entire transcript.

**Fix.** Two disjoint segments, each internally a total order: everything the
server has PLACED (it has a wire id) first, in wire-id order; everything still
only LOCAL (an optimistic stub, a queued inbox row) after all of it, by send
instant, untimed last. A local placeholder exists precisely because the server
has not placed it, and gains a wire id the moment it is echoed. No fabricated
timestamps anywhere, so no clock skew can reorder a conversation.

Two untimed messages stay a TIE so the stable sort keeps the host's input order
— an id tiebreak there regrouped `groupMessagesIntoTurns`' own sequential
fallback (`u1`, `a1`, `a2` → `a1`, `a2`, `u1`), caught by its existing test.

**Gates:** `typecheck` clean (both projects) · `bun test --isolate src` 2426
pass / 0 fail · surface snapshots unchanged.

---

### 2026-08-21 — session `changes-truth` — the Changes surface has ONE source of truth — DONE

**Files:** `react/use-opencode-sessions/vcs.ts` (NEW: `useOpenCodeVcsDiff`,
`VcsDiffMode`, re-exported `VcsFileDiff`) + `vcs.test.ts` (NEW, 8 tests) ·
`react/use-opencode-sessions/keys.ts` (+`opencodeKeys.vcsDiff`, `vcsDiffAll`) ·
`react/use-opencode-sessions/index.ts` (barrel) · `react/opencode.ts`
(+`useRuntimeVcsDiff` alias) · `react/use-opencode-events/handle-event.ts`
(+5 invalidation points) + `handle-event.test.ts` (+5 tests) · both surface
snapshots. Additive only — no rename, no breaking change, no new subpath.

**What.** A fresh session showed a tab badge reading "Changes 32" directly above
a body reading "No changes yet". Two sources of truth, contradicting each other
on screen at the same moment:

- the badge counted `GET /file/status` (`git status --porcelain -uall`);
- the body read `client.session.diff({ sessionID })`, which answers "what did
  ONE user message change". Zero user messages on a fresh session → `[]`.

`session.diff` is a message-scoped endpoint, so `useRuntimeSessionDiff` was a
misnomer for what the panel wanted. The correct endpoint is `GET /vcs/diff`,
already in the pinned `@opencode-ai/sdk@1.18.19`. `useOpenCodeVcsDiff` wraps it
with ONE query key per (mode, sandbox), so every Changes surface reads the same
cache entry and they cannot disagree by construction.

**Mode is `branch`, not `git`.** `git` is the working tree alone and drops to
zero the moment the agent commits — the badge and the "Propose changes" CTA
vanished while the work still was not in the base version, which is the exact
opposite of what the surface's own copy promises. `branch` = branch commits +
working tree. Verified live against a real `opencode-ai@1.18.19` server: on a
branch with one commit plus one untracked file, `mode=git` returned 1 entry
(the untracked file) and `mode=branch` returned 2.

`useRuntimeSessionDiff` / `useOpenCodeSessionDiff` stay exported — public API.

**Gates:** `typecheck` clean (both projects) · `bun test --isolate src` 2401
pass / 2 skip / 0 fail · `smoke:install` passed.

---

### 2026-08-21 — session `session-busy-flicker` — the ledger is not timely about the END of a turn — DONE

**Files:** `core/session/working.ts` (`endedByRuntime`, all-rows `openTurn`),
`react/use-session-working.ts` (+`streamTurnPhase`, phase-keyed invalidation),
`react/use-session-prompts.ts` (`sessionPromptsPollMs` believed-pending arg)
+ 4 test files. **No public surface change** — both snapshots are byte-identical.

**What.** The agent finished, the reply was on screen, and the spinner and Stop
button came BACK about 200ms later and stayed for up to 18s.

`projectWorking` ranked its observations by wall-clock: a newer read beat an
older frame. That is wrong here, because the two observers do not learn the
same fact at the same time. `session.idle` comes straight off the runtime over
SSE; the ledger row is closed by a SEPARATE daemon relay
(`POST .../turn-stream` `kind:"end"`). The idle frame ALSO triggers an immediate
`/turn` refetch (`use-session-working.ts`), and that refetch is stamped after
the frame while still reporting the turn the frame just ended → `working`.

MEASURED, local stack, five consecutive turns: ledger lag behind the runtime of
**6.9s, 10s, 15.2s and 18.5s**, and only ONE of the five turns produced a relay
POST at all — the rest were closed late by a reconciliation sweep. One captured
transition: idle frame 00:03:59.964 → `working` again at 00:04:00.150 (read
stamped +44ms, turn still `active`) → idle at 00:04:15.248. 15.1s of false busy.

**Fix.** A turn whose `started_at` PREDATES the freshest idle frame is the turn
that frame ended, and no ledger read may report it as working. A turn that
started after the frame is a new one the frame knows nothing about and keeps the
ledger's full authority — so a queued prompt draining, a trigger, or a second
device still lights the composer immediately, with no window and no delay. The
rule scans every open row, not `turns[0]`: the ledger holds two open turns while
a prompt is forwarded under a running one, and the list is not newest-first.
`serverOpenTurnToken` deliberately does NOT move — it answers "does the control
plane still hold authority", which is what an admission-gate-less `/` command
checks.

**Also.** (a) `streamTurnPhase` keys the SSE-triggered invalidation on the
idle/active PHASE instead of the observation instant: the runtime alternates
`busy`→`retry` about every 140ms mid-turn (measured), and each flip was
re-invalidating `/turn` AND `/prompts`, once per mount, three mounts per session.
(b) `sessionPromptsPollMs` now counts what the tab BELIEVES is pending, not only
the fetched list length — a first read that landed before the row existed
answered zero, locked the 15s idle cadence, and let the 10s
`INBOX_OBSERVATION_MAX_MS` belief die under a prompt that was still queued
(captured: `inbox=1@10004` → `idle`).

**Tried and reverted.** Excluding FORWARDED (`delivering`) inbox rows on the same
idle frame. A prompt queued behind a running turn is handed to OpenCode early and
sits in `delivering` ACROSS the turn boundary, so that frame says nothing about
it; the change put the composer back on Send for 13.8s with the user's queued
prompt still waiting. Reverted whole, including its `countForwardedInboxPrompts`
export — the hypothesis it was built on (rows closing late) is also false: rows
leave `GET .../prompts` at acceptance, ~1.7s after the turn opens.

**Open, server side, NOT fixed here.** The daemon's `kind:"end"` relay is
missing for most turns on the local stack, which is what makes the ledger 7-18s
late and also delays `reconcileForwardedTurnsAtEnd` — a prompt queued behind a
running turn was stranded and re-queued, starting 13.6s after the turn ahead of
it ended. The client is now correct regardless, but the relay gap is worth its
own investigation.

**Verification.** Real turns against a live Platinum sandbox, UI sampled at 100ms
on `[data-testid="session-busy-indicator"]` + the Stop control: **0 busy
reversals in 1133 samples** on a turn whose ledger lagged 18.5s. Before the fix
the same measurement showed idle→working→idle with a 15.1s false-busy leg.

**Gates:** `typecheck` clean (both projects) · `bun test --isolate src`
2402 pass / 2 skip / 0 fail · `smoke:install` — see below.

---
