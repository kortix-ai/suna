# @kortix/sdk

The **single, opinionated data layer** for the Kortix agent platform. One typed
client wraps the **Kortix REST API**, session-scoped **ACP** conversation
endpoints, and the provider-neutral daemon/runtime helpers so a host app — web,
mobile, reference — imports **only `@kortix/sdk`** and never the native SDK for a
specific harness. (The no-raw-`backendApi`/`authenticatedFetch` rule below is
the target state, not yet fully true of apps/web — see Rules of the road.)

> Philosophy: **one Kortix token, one client, every action a method.** Keys never
> leave the server; mutations own their side-effects there; the host states intent.

📖 **Full documentation:** [kortix.com/docs/sdk](https://kortix.com/docs/sdk) —
getting started, the full client, sessions, React hooks, and the subpath modules.
The REST API has an auto-generated reference at
[api.kortix.com/v1/docs](https://api.kortix.com/v1/docs).

---

## Install

```bash
npm install @kortix/sdk
```

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({ backendUrl: 'https://api.kortix.com/v1', getToken });
await kortix.projects.list();
```

## No bundler, no framework

The published package ships a browser IIFE bundle alongside its ESM `dist/` —
no build step required:

```html
<script src="https://unpkg.com/@kortix/sdk"></script>
<script>
  const kortix = Kortix.createKortix({ backendUrl, getToken });
</script>
```

> **CORS:** a `<script>` page calls the API from its own origin, so that origin
> must be in the API's CORS allowlist. Kortix's own domains and `localhost:3000/3010`
> are allowed out of the box; any third-party origin (or a local page on another
> port) needs adding via the API's `CORS_ALLOWED_ORIGINS` — otherwise the browser
> blocks the request before it leaves the page.

## Entry points

`@kortix/sdk` is the canonical entry — everything framework-free lives there.
Three others exist, each for a reason that fits in one sentence:

| Entry | Why it can't live at root |
|---|---|
| `@kortix/sdk/react` | React is a peer dependency |
| `@kortix/sdk/server` | imports `node:async_hooks` |
| `@kortix/sdk/internal/*` | unsupported, outside semver |

Older subpaths (`@kortix/sdk/projects-client`, `/turns`, …) still work and are
`@deprecated`. Import from the root instead — see **API-MAP.md**'s Stability
table for the full list (20 of them).

> **React Native / Expo:** REST works. **Streaming does not** — RN's `fetch` has
> no `response.body`. Tracked; do not depend on it yet.

## Quick start

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: 'https://api.kortix.com/v1',
  getToken: () => supabase.auth.getSession().then(s => s.data.session?.access_token ?? null),
});

// Projects
const projects = await kortix.projects.list();
const detail   = await kortix.project(pid).detail();
await kortix.project(pid).secrets.upsert({ name: 'STRIPE_API_KEY', value });

// Sessions (id-bound handle)
const s = kortix.session(pid, sid);
await s.send('Build me a widget');   // provisions/resumes if needed, then prompts
await s.previews();

// Lower level: ACP transport for THIS session's runtime.
// The ACP session id is runtime-owned, not the Kortix `sid`.
const { runtimeSessionId } = await s.ensureReady();
const acp = await s.acp.client();
await acp.prompt(runtimeSessionId!, [{ type: 'text', text: 'Inspect this repo' }]);
```

## The facade surface

`createKortix(config)` returns one client. The table below is illustrative, not
exhaustive — see `API-MAP.md` for the full per-domain surface:

| namespace | what |
|---|---|
| `kortix.projects` | list · get · detail · create · provision · update · archive · llmCatalog · modelPicker · sandboxTemplates · sessions (+ more: `listForAccount`, `sandboxHealth`, `createSession`) |
| `kortix.accounts` | list · get · create · members · invites · `tokens.{list,create,revoke}` (account-scoped CLI PATs, `kortix_pat_…`) · `audit.{log,export,webhooks.*}` (Enterprise audit trail) (+ more: `updateName`, `leave`, `invite`, `removeMember`, `updateMemberRole`) |
| `kortix.billing` | entitlement/usage reads: `accountState` · `accountStateMinimal` · `transactions` · `transactionsSummary` · `creditBreakdown` · `usageHistory` · `tierConfigurations` — plus a curated mutation surface: `checkout.{createSession,confirmSession}` · `subscription.{createPortalSession,cancel,reactivate,scheduleDowngrade,cancelScheduledChange,prorationPreview}` · `credits.{purchase,autoTopupSettings,configureAutoTopup}` |
| `kortix.marketplace` | public marketplace catalog browse + sources (not project-scoped): `items` · `item` · `itemFile` · `marketplaces` · `featured` · `sources.{list,add,remove}` — distinct from the install-scoped `project(id).marketplace` |
| `kortix.validateToken()` | pasted-API-key validation helper — `GET /accounts/me`, never throws, resolves `{valid, identity?, error?}` |
| `kortix.project(id)` | id-bound handle: `.secrets` · `.access` · `.connectors` · `.policies` · `.triggers` · `.files` · `.git` · `.changeRequests` (incl. `requestChanges`) · `.sessions` · `.tokens` (project-scoped CLI PATs — the `KORTIX_TOKEN` shape) · `.marketplace` / `.registry` (install/update/remove catalog items) · `.setupLinks.{requestSecret,requestConnector}` (agent-minted secret-entry / connector links) · `.validateManifest` · `.gitToken` · `.setDefaultAgent(name)` · `.session(sid)` (+ more namespaces: `.review`, `.approvals`, `.gateway` (incl. `.routing` and `.playground`), `.channels`, `.modelDefaults`, `.sandbox`) |
| `kortix.session(pid, sid)` | id-bound handle: lifecycle (`get`/`update`/`delete`/`start`/`restart`/`stop`/`setSharing`/`previews`/`commit`/`publicShares`/`ensureReady`) · `send`/`abort` (ACP prompt wrappers) · `stream()` / `.acp.*` (ACP live transport) · `transcript()` (compact server-side transcript read) · `.files` (the 12-op workspace-files surface, bound to THIS session's own runtime) · **its own runtime** (`health`/`previewUrl`/`proxyUrl` — sandbox resolved for you) |
| `kortix.runtime()` | structural daemon/runtime helpers for the active session runtime (escape hatch, not the conversation protocol) |

### Harness-aware agent and model selection

Agents declare the ACP harness that executes them: `claude`, `codex`,
`opencode`, or `pi`. Read that capability from `@kortix/sdk/react` instead of
branching on agent names:

```ts
import {
  agentHarness,
  agentRequiresCatalogModel,
  harnessPresentation,
} from '@kortix/sdk/react';

const harness = agentHarness(agent);
const usesGatewayCatalog = agentRequiresCatalogModel(agent);
const label = harness ? harnessPresentation(harness).label : 'Agent';
```

The model contract intentionally has two paths:

- **OpenCode** uses the project/provider model catalog. Send its selected model
  through the existing catalog-model field.
- **Claude Code, Codex, and Pi** own their native default model. Omit a model to
  keep that default, or send one explicit harness model id as `runtime_model`
  when the project session is created.

```ts
await kortix.project(projectId).sessions.create({
  agent_name: 'codex',
  runtime_model: 'openai/gpt-5.4', // optional, immutable launch-time override
});
```

`runtime_model` is persisted with the project session and applied when the ACP
runtime launches. It is not a provider/model catalog key, and it should not be
reused across harness switches. Hosts should keep a separate pending value per
harness and omit the field for "Harness default".

Runnable, self-contained scripts for the highest-value flows live in
[`examples/`](./examples): list projects with a PAT, send + stream, the
multi-tenant server-wrapper pattern, headless transcript rendering, cost
pass-through / re-billing, and session files + project secrets. Each file's
header comment states the env vars and the exact `bun run examples/….ts`
invocation.

Wrapper backends can attach bounded, non-secret scalar context when creating a
session. It is persisted across cold recovery/replacement restart and exposed
to the agent only as one `KORTIX_SESSION_CONTEXT` JSON envelope:

```ts
await kortix.project(projectId).sessions.create({
  runtime_context: { workspace_id: 'org_123', locale: 'de' },
});
```

Do not put credentials in this map. For a white-label/backend wrapper, create a
server-owned connection profile, store its credential through the dedicated
credential endpoint, and pass only the non-secret profile id at session create:

```ts
const project = kortix.project(projectId);
const profile = await project.connectors.profiles.reconcile({
  connector_alias: 'customer-data',
  owner_type: 'external',
  owner_id: wrapperUserId,
  label: 'Customer data',
  metadata: { tenant_ref: wrapperTenantReference },
});
await project.connectors.profiles.updateCredential(profile.profile_id, {
  value: shortLivedCapability,
  kind: 'secret',
});
await project.sessions.create({
  runtime_context: { locale: 'de' },
  connector_bindings: {
    'customer-data': { profile_id: profile.profile_id },
  },
});
```

Profiles are project/connector scoped, manager-authorized, and resolved on
every Executor request. Revocation therefore takes effect without restarting
the session. The credential is encrypted server-side and is never returned,
placed in `KORTIX_SESSION_CONTEXT`, or injected into the sandbox environment.
Raw env and MCP configuration are not session-create inputs.

`session.stream()` is a thin facade over the framework-free `openEventStream`
primitive (also exported directly, for hosts that want to manage the client
themselves): it resolves THIS handle's own runtime (`ensureReady()`), connects
to that runtime's SSE endpoint, and hands you a `close()`-able handle. No React
required — safe to call from a server-side "Kortix as a Backend" wrapper
(Node/Bun), a worker, or a CLI:

```ts
const handle = await kortix.session(pid, sid).stream({
  onEvent: (event) => console.log(event.type, event),
  onGapRehydrate: (gapMs) => console.warn(`reconnected after a ${gapMs}ms gap`),
});
// later, to stop:
handle.close();
```

`@kortix/sdk/react`'s session hooks use the same primitive under the hood — they
also write into the React Query/cache stores that the web UI consumes.

## Kortix as a Backend (server-side)

`createKortix()` stores its config — crucially, the bearer-token getter — in a
process-wide singleton. That's correct for a host with one config for its whole
lifetime (a browser tab, a CLI, a single-tenant server), but **unsafe for a
server process handling concurrent requests for different end users**: two
in-flight requests racing through `createKortix()`/`configureKortix()` with
different tokens clobber each other, and the last write wins for every other
in-flight request.

`@kortix/sdk/server` (Node/Bun only — never import it from a browser bundle;
it statically imports `node:async_hooks`) fixes this with `AsyncLocalStorage`:

```ts
import { createScopedKortix } from '@kortix/sdk/server';

// Express/Hono/Bun.serve — any per-request handler. One scoped client PER
// REQUEST; each end user's token stays isolated to that request's own async
// call tree, even across `await`s, even under concurrency.
app.get('/projects', async (req, res) => {
  const kortix = createScopedKortix({
    backendUrl: process.env.KORTIX_API_URL!,
    getToken: async () => resolveKortixTokenFor(req), // per-end-user PAT/token
  });
  res.json(await kortix.projects.list());
});
```

`createScopedKortix(config)` has the same shape as `createKortix(config)` —
every method call (including calls through `.project(id)` / `.session(pid, sid)`
handles minted at call time) automatically runs inside that config's scope, and
it never writes the process-global singleton. For middleware-style wrapping of
an entire request body instead, use the lower-level primitive:

```ts
import { runWithKortix } from '@kortix/sdk/server';

app.use(async (req, res, next) => {
  await runWithKortix(
    { backendUrl, getToken: async () => resolveKortixTokenFor(req) },
    async () => {
      await next(); // every Kortix call anywhere in this request sees THIS config
    },
  );
});
```

A runnable version of the pattern is `examples/03-server-wrapper.ts`, and the
full production-shaped reference (per-user project isolation, route policy,
rate limiting, cost markup for re-billing) is `apps/whitelabel-demo` in wrapper
mode — see its README.

## Rendering chat (the headless chat kit)

Everything needed to render an agent transcript without adopting any Kortix
UI: `classifyPart`/`classifyTurn` (`@kortix/sdk/turns`, framework-free)
normalize the runtime part types (text, reasoning, tool, file,
subtask, patch, snapshot, agent, retry, compaction, step, + a forward-compat
`unknown`) into a typed `ClassifiedPart`, and normalize a failed assistant
turn's `info.error` into a `{ name, message }` `TurnError` — so "assistant
message with zero parts but an error" renders as a failure, not silence.
`renderParts` (`@kortix/sdk/react`, though it has no React import) requires a
renderer for **every** part kind at compile time, so a new part type is a
build error at your call site instead of a silent drop in production:

```tsx
import { renderParts, type PartRenderers } from '@kortix/sdk/react';
import { classifyTurn } from '@kortix/sdk/turns';

const renderers: PartRenderers<React.ReactNode> = {
  text: (p) => <Markdown>{p.text}</Markdown>,
  reasoning: (p) => <Thinking text={p.text} />,
  tool: (p) => <ToolCard name={p.tool.name} status={p.tool.status} />,
  file: (p) => <Attachment name={p.filename ?? p.url} />,
  subtask: (p) => <Delegated agent={p.agent} />,
  patch: (p) => <DiffStat files={p.fileCount} />,
  retry: (p) => <Note>{`retrying (attempt ${p.attempt})`}</Note>,
  compaction: () => <Note>context compacted</Note>,
  snapshot: () => null,  // internal checkpoint hash — nothing to show
  agent: () => null,     // inline @mention, already in the sibling text
  step: () => null,      // model-step bookkeeping
  unknown: () => null,   // forward-compat: newer server than client
};

function Turn({ message }: { message: MessageWithParts }) {
  const { parts, error, isEmpty } = classifyTurn(message);
  if (isEmpty && !error) return null;
  return <>{renderParts(parts, renderers)}{error && <TurnFailed {...error} />}</>;
}
```

The living reference is
`apps/whitelabel-demo/src/components/chat/message-view.tsx` — one deliberate
rendering decision per part kind, with the rationale for each `null`. For a
memoized message-list binding use `useChatTurns(messages)` (`@kortix/sdk/react`);
for a no-React plain-text version of the same classification see
`examples/04-render-transcript.ts`. On the live side, `narrowChatEvent`
(root barrel) narrows the raw ~50-variant SSE union from `session.stream()` /
`openEventStream` down to the curated `KortixChatEvent` union (~14 members) a
chat UI actually dispatches on.

## Errors

One typed hierarchy, produced by **every** HTTP layer — `backendApi`, the
platform client's `platformFetch`, `authenticatedFetch`, the files client, the
daemon/runtime client, and `ensureReady()` all throw/return the same classes (from
the root barrel or `@kortix/sdk/api-client`; `@kortix/sdk/react` re-exports
them too). They're real classes: `instanceof` works across every host, and
`name`/shape are preserved for legacy `error.name === 'ApiError'` sniffers.

- `ApiError` — any failed request; branch on `.status` / `.code` (e.g.
  `'TIMEOUT'`, `'RUNTIME_UNAVAILABLE'`, `'ABORTED'`). Timeout errors carry
  `.url` / `.endpoint` / `.timeout`.
- `AuthError extends ApiError` — `getToken()` returned null; the request was
  never sent (`code: 'NO_SESSION'`).
- `BillingError` — HTTP 402, with the backend's payload on `.detail`.
- `RequestTooLargeError` — HTTP 431 (usually a too-large upload batch), with a
  `.detail.suggestion`.
- `SessionNotReadyError` (root barrel) — a session handle's runtime-scoped
  member (`.runtime`, `.previewUrl()`, `.proxyUrl()`) was touched before
  `ensureReady()` resolved this session's own sandbox.

The canonical server-side wrapper shape — catch a 402 and pass the payload
through to your own client for re-billing, instead of leaking a Kortix error:

```ts
import { ApiError, AuthError, BillingError } from '@kortix/sdk';

try {
  await kortix.session(pid, sid).send(prompt);
} catch (err) {
  if (err instanceof BillingError) {
    // 402 — surface the upgrade/cost payload under YOUR billing story.
    return res.status(402).json({ reason: 'quota', detail: err.detail });
  }
  if (err instanceof AuthError) return res.status(401).json({ error: 'not authenticated' });
  if (err instanceof ApiError) return res.status(err.status ?? 502).json({ error: err.message });
  throw err;
}
```

Every non-streaming request also carries a **30s default timeout** (the
long-lived SSE event stream is exempt), so a hung sandbox/daemon call can't
wedge a server-side handler forever — it surfaces as an `ApiError` with
`code: 'TIMEOUT'` instead.

## Subpath modules

Stable, tree-shakeable surfaces (also reachable via the facade). Not exhaustive
— see `package.json`'s `exports` field for the complete list (it also includes
`./config`, `./api-client`, `./feature-flags`, `./fresh-sessions`,
`./instance-routes`, `./runtime-errors`, `./platform-client`,
`./sandbox-connection-store`, `./runtime-pending-store`, `./session/url`,
`./idb-sync-cache`):

| import | provides |
|---|---|
| `@kortix/sdk` | `createKortix`, `configureKortix`, `files`, the error classes, ACP transcript projections, `classifyPart`/`classifyTurn`, and domain result types |
| `@kortix/sdk/server` | **Node/Bun only** — `runWithKortix`, `createScopedKortix`, `getScopedConfig` (per-request config isolation; see "Kortix as a Backend") |
| `@kortix/sdk/react` | `useSession`, ACP/runtime hooks, `useChatTurns`/`renderParts`, domain hooks (`useProjectSecrets`/`useProjectTriggers`/`useChangeRequests`) |
| `@kortix/sdk/turns` | framework-free part/turn classification (`classifyPart`, `classifyTurn`, `toolInfo`, turn grouping/cost helpers) |
| `@kortix/sdk/files` | workspace file ops (daemon `/file` + `/find`): `listFiles`, `readFile`, `readBlob`, `getFileStatus`, `findFiles`, `findText`, `uploadFile`, `deleteFile`, `mkdir`, `renameFile`, … |
| `@kortix/sdk/session` | a session's runtime surface — `getSessionHealth`/`isRuntimeReady` + proxy/preview URL builders (`rewriteLocalhostUrl`, `proxyLocalhostUrl`, `detectLocalhostUrls`, …) + preview-auth helpers. **No "sandbox" in the public surface** — a session owns its runtime |
| `@kortix/sdk/acp` | ACP client helpers, protocol types, project-session endpoint helpers, and transcript projection utilities |
| `@kortix/sdk/projects-client` | the raw REST functions (the facade wraps these) |
| `@kortix/sdk/auth` | `authenticatedFetch`, token accessors |
| `@kortix/sdk/api-client` | the raw `backendApi` primitive — host code should go through the facade or another subpath module instead of calling this directly |
| `@kortix/sdk/server-store` · `@kortix/sdk/sync-store` | active-sandbox state · live message/part/status store |

## Configuration

`configureKortix(config)` (called for you by `createKortix`) wires one seam:

```ts
interface KortixPlatformConfig {
  backendUrl: string;
  getToken: () => Promise<string | null>;
  getUserId?: () => Promise<string | null>;
  billingEnabled?: boolean;
  sandboxId?: string | null;
  onError?: (error: unknown, context?: unknown) => void;
  onToast?: (level, message, options?) => void;
  onNotify?: (event) => void;
  featureFlags?: KortixFeatureFlagOverrides; // per-flag overrides for non-Next.js hosts
}
```

The SDK is host-agnostic: no Next.js / web coupling in the core. The host injects
its token getter and toast/notify sinks; the SDK does the rest. Today that's proven
in React DOM (`apps/web` and the `apps/whitelabel-demo` reference app are the
`configureKortix`/`@kortix/sdk/react` consumers).
The framework-free core modules — `turns`, `session/url`, `session` (health),
`projects-client`, `files`, `transcript` — have no React or DOM dependency and are
usable from any JS host; `apps/mobile` already imports `@kortix/sdk/turns` this way.
React Native adoption of live streaming is limited by RN's fetch implementation.
REST/facade calls work anywhere `fetch` does; mobile-specific UI may still use a
thin native data layer until streaming support is available.

## Rules of the road

- **No native harness SDKs in host code.** Host apps and `@kortix/sdk` do not
  depend on native harness SDKs. Conversation traffic is ACP-first; remaining
  daemon helpers go through `@kortix/sdk/runtime-client`.
- **No raw `backendApi` / `authenticatedFetch` in host code.** Use the facade or a
  subpath module. (Aspirational: apps/web still calls `backendApi` via its
  `@/lib/api-client` re-export in ~30 files and keeps a parallel
  `authenticatedFetch` in `apps/web/src/lib/auth-token.ts` — migration pending.)
- **React data** comes from `@kortix/sdk/react` hooks; **imperative actions** from
  the `createKortix` facade.

## Auth

`Authorization: Bearer <token>` — a Supabase JWT (user sessions) or a Kortix PAT
(`kortix_pat_…`) for server-side / automation use, supplied via `getToken`.

## Tests

```sh
pnpm --filter @kortix/sdk typecheck  # package + examples/ (examples/tsconfig.json)
pnpm --filter @kortix/sdk test   # facade, files, react hooks, turns, transcript, session url/health, projects-client domains
```

See **`API-MAP.md`** for the complete endpoint catalogue (REST + ACP/runtime)
and per-domain SDK coverage status, and **`CHANGELOG.md`** for what changed per
release.
