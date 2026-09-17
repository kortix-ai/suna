# @kortix/sdk

The **single, opinionated data layer** for the Kortix agent platform. One typed
client wraps both the **Kortix REST API** and the **agent runtime** so a
host app — web, mobile, reference — imports **only `@kortix/sdk`** and never
`@opencode-ai/sdk` directly. (The no-raw-`backendApi`/`authenticatedFetch` rule
below is the target state, not yet fully true of apps/web — see Rules of the
road.)

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
import { createKortix } from "@kortix/sdk";

const kortix = createKortix({
  backendUrl: "https://api.kortix.com/v1",
  getToken,
});
await kortix.projects.list();
```

### Call external systems through Connectors

Use one six-method data plane for every Connector provider. A user token binds
the project explicitly. An agent-minted session token already carries its
project scope, so it can use the top-level fallback.

```ts
const connectors = projectId
  ? kortix.project(projectId).connectors
  : kortix.connectors;

await connectors.catalog();
await connectors.tools();
await connectors.search('send email');
await connectors.describe('gmail.send_email');
await connectors.call('gmail.send_email', { to, subject, body });
await connectors.uploadAttachment(bytes, {
  filename: 'invoice.pdf',
  contentType: 'application/pdf',
});
```

A Connector defines callable tools. A Connection stores one authorization for
that Connector. Credentials remain server-side and never enter the sandbox.

### Upload prompt attachments before Send

Create one controller per composer. `add(file)` starts a private project upload
without waiting for a session runtime. Subscribe to `getSnapshot()` for tile state.

```ts
const attachments = kortix.project(projectId).attachments.createController();
const localId = attachments.add(file);
const unsubscribe = attachments.subscribe(() => render(attachments.getSnapshot()));

// Inside the submit handler. Send never waits for uploads.
const ids = attachments.getSnapshot().attachments.map((item) => item.id);
attachments.submit(ids); // hand-off: the composer clears, the uploads continue
paintMessage(text, ids);
try {
  const parts = await attachments.whenReady(ids); // handle-only parts, in `ids` order
  await kortix.session(projectId, sessionId).prompts.create({
    clientMessageId,
    messageId,
    parts: [{ type: 'text', text }, ...parts],
  });
  attachments.forget(ids); // release; does not delete storage objects
} catch (error) {
  attachments.reclaim(ids); // back to the composer, with the failed file's state
}
```

React consumers use `usePromptAttachments(projectId)` from `@kortix/sdk/react`.
It returns the controller methods plus the reactive `attachments` list. It omits
`dispose`, `subscribe`, and `getSnapshot`, and keeps its identity until the list
changes.

Files move through `pending`, `uploading`, `processing`, `ready`, `error`, or
`aborted`. Progress counts bytes sent. Progress snapshots are throttled: one per
whole-percent change, at most ten per second per upload. The default concurrency
is two files.
Limits are 50 MiB per file, 100 MiB per message, and 20 files. Empty files are
rejected. Refuse Send only while a selected file is `error` or `aborted`.

`whenReady(ids, { signal })` resolves once every upload is `ready`. It rejects
when one fails, is aborted or removed, or `signal` aborts. A rejected wait does
not stop the upload.

Ownership: `submit(ids)` hands entries to one send. They leave `attachments` and
stop counting toward the limits. `dispose()` aborts and deletes only listed
work, so a composer that unmounts after Send (a navigation, a remount) does not
cancel its held uploads. The controller object lives as long as the send's `whenReady`
promise references it. Call `forget(ids)` after the prompt POST succeeds, or
`reclaim(ids)` when a failed send restores its draft. `forget()` with no argument
releases only the listed selection. A host that keeps a failed send on screen
keeps its entries: `retry(id)` reaches a handed-off entry after `dispose()`.

`retry(localId)` resumes the same upload and preserves the original File. After
`attachment_size_mismatch` or `attachment_failed` the server keeps no usable
handle, so `retry` uploads the File again as a new attachment. An expired upload
cannot retry: `retry` throws, and the item error carries code
`attachment_expired`. `remove(localId)` removes the entry, aborts its upload, and
resolves at once. It deletes unbound storage best-effort and never rejects; a
failed or refused DELETE leaves the object to the 24-hour expiry.
`abort(localId)` cancels unfinished work. `dispose()` aborts listed work and
deletes its uploads best-effort: no send holds them, and drafts keep no handle.
Call it on non-React cleanup; the hook handles unmount and project changes.
Unused uploads expire after 24 hours.

Selections live in memory only. Never persist a File, blob URL, signed URL, or
upload handle in a draft.

For non-composer uploads, call `kortix.project(projectId).attachments.upload(file,
{ signal, onProgress, onUpload, resume })`. The server selects the transport in the
handle's `upload` field:

- `kind: 'direct'` (default): one `PUT` of the whole file to `upload.url` with
  `upload.headers` and no Authorization header. Hosts with `XMLHttpRequest`
  (browsers, React Native) report sent bytes; other hosts use `fetch` and report
  0, then the full size. An expired URL, or one Storage refuses with 400/401/403,
  is re-signed once for the same `attachment_id`; the server creates no second
  upload. A `409` from Storage means an earlier attempt already stored the file.
- `kind: 'chunked'`: sequential authenticated `PUT`s of `upload.chunk_size` bytes.
  The SDK accepts any positive `chunk_size`. Only a deployment whose edge drops
  large request bodies selects it.

Completion then verifies the stored bytes. Retain the `onUpload` handle for manual
same-ID recovery. If completion answers `409 attachment_not_uploaded`, `onUpload`
reports the direct handle with `received_bytes: 0`, so a resume sends the file
again. Initiation, the upload, and completion retry timeouts, network errors,
429, and 5xx with jittered exponential backoff. The budget is 60 seconds from the
first failure, so a long upload that fails late still retries. Completion also
retries `attachment_processing`, with a five-minute budget. Initiation never
retries 402 (a `BillingError`: the account cannot run) or 429
`attachment_budget_exceeded` (40 unfinished uploads or 500 MiB of unsent uploads
for the user; unused uploads expire within 24 hours). The server answers or
refuses one completion within 105 seconds; each completion request allows 120
seconds. Caller aborts never retry.

A sent attachment's reference is released 1 hour after its prompt is delivered,
and when its session or project is deleted. The next maintenance sweep then
removes the file, and its `attachment_id` can no longer be sent.
Completed `attachment_id` parts use platform prompt routes. Runtime `sendParts`
continues to accept runtime URL parts. Legacy platform URL parts remain supported.

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

| Entry                    | Why it can't live at root   |
| ------------------------ | --------------------------- |
| `@kortix/sdk/react`      | React is a peer dependency  |
| `@kortix/sdk/server`     | imports `node:async_hooks`  |
| `@kortix/sdk/internal/*` | unsupported, outside semver |

Install the optional peers before you use the React entry:

```bash
npm install @kortix/sdk react @tanstack/react-query
```

Older subpaths (`@kortix/sdk/projects-client`, `/turns`, …) still work and are
`@deprecated`. Import from the root instead — see **Entry points** below for
the three that are real, and **API-MAP.md**'s Stability table for the full
list of aliases (20 of them).

> **React Native / Expo:** REST works. **Streaming does not** — RN's `fetch` has
> no `response.body`. Use `createHttpSessionSyncController` for bounded history
> synchronization. Keep the platform-specific event transport for live events.

## Quick start

```ts
import { createKortix } from "@kortix/sdk";

const kortix = createKortix({
  backendUrl: "https://api.kortix.com/v1",
  getToken: () =>
    supabase.auth
      .getSession()
      .then((s) => s.data.session?.access_token ?? null),
});

// Projects
const projects = await kortix.projects.list();
const detail = await kortix.project(pid).detail();
await kortix.project(pid).secrets.upsert({
  name: "LOCAL_TOOL_TOKEN",
  value,
  strategy: "runtime",
  consumer: "sandbox",
});
await kortix.project(pid).secrets.upsert({
  identifier: "anthropic-primary",
  name: "ANTHROPIC_API_KEY",
  value: providerKey,
  strategy: "broker",
  consumer: "llm_gateway",
});
// When pooled_provider_secrets and llm_gateway are enabled for the project,
// a new account secret is available to this project's members by default.
const shared = await kortix.accounts.secretResources.create(accountId, {
  project_id: pid,
  label: "Anthropic backup",
  provider_id: "anthropic",
  name: "ANTHROPIC_API_KEY",
  value: providerKey,
  consumer: "llm_gateway",
  strategy: "broker",
});
// Restrict it to selected members when needed. The creator keeps access.
await kortix.accounts.secretResources.setAccess(accountId, shared.secret_id, "members", [memberUserId]);
await kortix.session(pid, sid).providerSecretPool.set("anthropic", [shared.secret_id]);
const { pools, can_edit } = await kortix.session(pid, sid).providerSecretPool.list();
// Passing null to set() resets the session to the project default.
const visibleSessions = await kortix.project(pid).sessions.list();
const projectInventory = await kortix
  .project(pid)
  .sessions.list({ scope: "project" }); // manager only; inaccessible rows omitted
const warm = await kortix.project(pid).sessions.ensureWarm(); // ordinary session, pre-created

// Sessions (id-bound handle)
const s = kortix.session(pid, sid);
const cost = await s.cost(); // reads finalized LLM + compute cost; no runtime start
await s.send("Build me a widget"); // provisions/resumes if needed, then prompts
await s.rewind(userMessageId); // stages a reversible rollback on this session
await s.restoreRewind(); // restores the removed path before the next prompt
await s.previews();
await s.reloadConfig({ refresh_repo: false });
await s.reloadConfigStream(
  { refresh_repo: false },
  (event) => event.type === "phase" && console.log(event.phase),
);

// Lower level: the typed OpenCode REST compatibility client for THIS sandbox.
// `.runtime` throws until the runtime is resolved, and the runtime is keyed by
// the OpenCode session id (NOT the Kortix `sid`) — resolve both via ensureReady.
const { opencodeSessionId } = await s.ensureReady();
await s.runtime.session.prompt({ sessionID: opencodeSessionId, parts });
```

React consumers use `useAccountSecretResources(accountId)` and
`useSessionProviderSecretPools(projectId, sessionId)` from `@kortix/sdk/react`.
The latter exposes `setPool.mutate({ providerId, secretIds })`. `null` restores
inheritance; `[]` disables that provider for the session. Empty configured pools
remain listed after their last resource is deleted. Successful writes refresh
both the pool list and the session's provider-specific query cache.

### Apps

`kortix.project(projectId).apps` deploys immutable App versions behind one stable URL. New Apps use `private` access. Apps is an experimental project feature, so API operations return `404` until a project manager enables it.

```ts
const apps = kortix.project(projectId).apps;
const app = await apps.create({ slug: 'docs', name: 'Docs' });
const artifact = await apps.artifacts.uploadArchive(tarGzBytes);
await apps.deployments.create(app.app_id, {
  artifact_id: artifact.artifact_id,
  source: { kind: 'static', spa: true },
});
await apps.access.update(app.app_id, {
  mode: 'restricted',
  member_ids: [memberId],
  group_ids: [groupId],
});
const browserSession = await apps.access.session(app.app_id);
```

Access modes are `private`, `project`, `restricted`, `public`, and `password`. An access session exchanges a five-minute URL for an eight-hour, host-only cookie. A stopped or idle App resumes on the same public request. Transient machine requests receive `202 app_starting` and `Retry-After: 3`.

For OpenCode REST sessions, `send()` reads the persisted session model and
agent before the first prompt on a handle. This prevents a snapshot-inherited
OpenCode session from reusing stale snapshot defaults. A per-call choice
overrides a `setModel()` or `setAgent()` choice. A handle choice overrides the
persisted session default.

### React runtime

`useSession(projectId, sessionId)` opens the OpenCode REST runtime returned by
`POST /start`. The hook owns messages, rewind and restore, cancellation,
commands, permissions, and questions. Hosts do not construct runtime routes.

A server-rendered host can seed a known OpenCode pin while `/start` runs:

```tsx
useSession(projectId, sessionId, {
  initialOpenCodeSessionId: persistedSession.opencode_session_id,
});
```

Use only a pin that the host authorized for the same `(projectId, sessionId)`.
The seed hydrates cached content. It does not choose the runtime identity.
The pin returned by `/start` always replaces a stale seed. The SDK also scopes
OpenCode query and synchronization controllers to the sandbox runtime. Two
sandboxes cannot share browser cache state when a snapshot exposes the same
OpenCode id during adoption.

Message retries keep the originating sandbox URL after navigation. A `404` or
`410` message read stops automatic retries and preserves the cached transcript.
An explicit reconciliation can recover the controller when the session returns.

## The facade surface

`createKortix(config)` returns one client. The table below is illustrative, not
exhaustive — see `API-MAP.md` for the full per-domain surface:

| namespace | what |
|---|---|
| `kortix.projects` | list · get · detail · create · provision · update · archive · llmCatalog · modelPicker · sandboxTemplates · sessions (+ more: `listForAccount`, `sandboxHealth`, `createSession`) |
| `kortix.accounts` | list · get · create · members · invites · `secretResources.{list,create,rotate,delete,grant,revoke,setAccess}` · `tokens.{list,create,revoke}` (account-scoped CLI PATs, `kortix_pat_…`) · `audit.{log,export,webhooks.*}` (filterable project/session reconstruction log) · `branding.{get,update,uploadAsset,removeAsset,reset}` (Enterprise organization branding: logo / icon / favicon, light + dark, product name) (+ more: `updateName`, `leave`, `invite`, `removeMember`, `updateMemberRole`) |
| `kortix.billing` | entitlement/usage reads: `accountState` · `accountStateMinimal` · `transactions` · `transactionsSummary` · `creditBreakdown` · `usageHistory` · `usageRollup` · `sessionCosts.{list,get}` · `tierConfigurations` — plus a curated mutation surface: `checkout.{createSession,confirmSession}` · `subscription.{createPortalSession,cancel,reactivate,scheduleDowngrade,cancelScheduledChange,prorationPreview}` · `credits.{purchase,autoTopupSettings,configureAutoTopup}` |
| `kortix.marketplace` | public marketplace catalog browse + sources (not project-scoped): `items` · `item` · `itemFile` · `marketplaces` · `featured` · `sources.{list,add,remove}` — distinct from the install-scoped `project(id).marketplace` |
| `kortix.github` | account-scoped GitHub App installs and repo linking: `getInstallation` · `listInstallations` · `listLinkableInstallations` (each entry carries `linked_to_other_accounts`, a count and never a tenant name) · `listRepositories` · `listRepositoryBranches` · `linkInstallation` · `saveInstallation` · `deleteInstallation` · `linkRepository` (`source: 'managed'` imports a repository the instance backend holds — self-host operator only, and mutually exclusive with `installation_id`) |
| `kortix.gitBackend` | the instance git backend ("Kortix managed", one per deployment, never an account connection): `get()` → `{configured, kind: 'app'|'pat'|null, owner}` (any authenticated user) · `repositories({search?, limit?})` (self-host operator only; 403 otherwise) |
| `kortix.validateToken()` | pasted-API-key validation helper — `GET /accounts/me`, never throws, resolves `{valid, identity?, error?}` |
| `kortix.connectors` | Connector data plane for an agent-minted session token: `catalog` · `tools` · `search` · `describe` · `call` · `uploadAttachment` |
| `kortix.project(id)` | id-bound handle: `.apps` (stable serverless App URLs, access, artifacts, deployments, logs, rollback, start/stop) · `.secrets` · `.access` · `.connectors` (data plane + configuration + Connections) · `.policies` · `.triggers` · `.files` · `.git` · `.changeRequests` (incl. `requestChanges`) · `.sessions` · `.tokens` (project-scoped CLI PATs — the `KORTIX_TOKEN` shape) · `.marketplace` / `.registry` (install/update/remove catalog items) · `.setupLinks.{requestSecret,requestConnector}` (agent-minted secret-entry / connector links) · `.validateManifest` · `.gitToken` · `.setDefaultAgent(name)` · `.session(sid)` (+ more namespaces: `.review`, `.approvals`, `.gateway` (incl. `.routing` and `.playground`), `.channels`, `.modelDefaults`, `.sandbox`) |
| `kortix.session(pid, sid)` | id-bound handle: lifecycle (`get`/`update`/`delete`/`start`/`restart`/`stop`/`reloadConfig`/`reloadConfigStream`/`setSharing`/`previews`/`commit`/`publicShares`/`ensureReady`) · `providerSecretPool.{list,get,set}` · finalized `cost()` · `send`/`abort`/`rewind`/`restoreRewind`/`setModel`/`setAgent` · `transcript()` · `.files` · runtime URL helpers (`health`/`previewUrl`/`proxyUrl`) · OpenCode REST compatibility escape hatches: `stream()` and `.runtime` |
| `kortix.runtime()` | the OpenCode v2 compatibility client for the active sandbox; use a session-scoped handle in multi-tenant code |

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
  runtime_context: { workspace_id: "org_123", locale: "de" },
});
```

Do not put credentials in this map. For a white-label/backend wrapper, create an
operator-managed connection, store its credential through the dedicated
credential endpoint, and pass only the non-secret connection id at session create:

```ts
const project = kortix.project(projectId);
const connection = await project.connectors.connections.reconcile({
  connector_alias: "customer-data",
  owner_type: "external",
  owner_id: wrapperUserId,
  label: "Customer data",
  metadata: { tenant_ref: wrapperTenantReference },
});

// Omit `auth` when creating to apply source-advertised authentication.
const auth = await project.connectors.auth.discover({
  slug: "hubspot",
  provider: "postman",
  spec: "https://github.com/HubSpot/HubSpot-public-api-spec-collection",
});
await project.connectors.connections.updateCredential(connection.connection_id, {
  value: shortLivedCapability,
  kind: "secret",
});
await project.sessions.create({
  runtime_context: { locale: "de" },
  connector_bindings: {
    "customer-data": { connection_id: connection.connection_id },
  },
});
```

For bring-your-own authorization, each logged-in member creates their own
connection without supplying an owner id; Kortix derives ownership from the bearer
token:

```ts
const connection = await project.connectors.connections.reconcileMember({
  connector_alias: "gmail",
  label: "My Gmail",
});
await project.connectors.connections.pipedreamConnect(connection.connection_id);
// Complete OAuth, then:
await project.connectors.connections.pipedreamFinalize(connection.connection_id);
await project.sessions.create({
  connector_bindings: { gmail: { connection_id: connection.connection_id } },
});
```

Member connections are owner-only even for project managers, and sessions using
one must remain private. Project defaults remain shared; external/agent/subject
connections remain operator-managed. Every connection is project/connector scoped
and resolved on every Connector request, so revocation takes effect without a
restart. Credentials are encrypted server-side and are never returned, placed
in `KORTIX_SESSION_CONTEXT`, or injected into the sandbox environment. Raw env
and MCP configuration are not session-create inputs.

For OpenCode REST sessions, `session.stream()` is a thin facade over the
framework-free `openEventStream`
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

`onGapRehydrate` fires after a reconnect, once the new subscription delivers
its first frame, when frames may have been lost: the dropped subscription
delivered content, or no content arrived for more than 5 s. `gapMs` is the
time since the last content frame (daemon keepalive, `server.connected`, and
`server.heartbeat` do not count), so it can be under 5 s. It fires at most
once per 5 s per stream. A call that comes due inside that window fires when
the window ends, on the live subscription, or on the next subscription's first
frame. `openEventStream` also passes a second argument, `{ contentLost }`: true
when the dropped subscription delivered content.

`session.stream()` emits OpenCode v2 events. Use `useSession()` in React.

`@kortix/sdk/react`'s `useOpenCodeEventStream` uses the exact same primitive
under the hood — it just also writes into the React Query cache.

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
import { createScopedKortix } from "@kortix/sdk/server";

// Express/Hono/Bun.serve — any per-request handler. One scoped client PER
// REQUEST; each end user's token stays isolated to that request's own async
// call tree, even across `await`s, even under concurrency.
app.get("/projects", async (req, res) => {
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
import { runWithKortix } from "@kortix/sdk/server";

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
UI: `classifyPart`/`classifyTurn` (framework-free, from the root entry)
normalize all twelve opencode part types (text, reasoning, tool, file,
subtask, patch, snapshot, agent, retry, compaction, step, + a forward-compat
`unknown`) into a typed `ClassifiedPart`, and normalize a failed assistant
turn's `info.error` into a `{ name, message }` `TurnError` — so "assistant
message with zero parts but an error" renders as a failure, not silence.
`renderParts` (`@kortix/sdk/react`, though it has no React import) requires a
renderer for **every** part kind at compile time, so a new part type is a
build error at your call site instead of a silent drop in production:

```tsx
import { renderParts, type PartRenderers } from "@kortix/sdk/react";
import { classifyTurn } from "@kortix/sdk";

const renderers: PartRenderers<React.ReactNode> = {
  text: (p) => <Markdown>{p.text}</Markdown>,
  reasoning: (p) => <Thinking text={p.text} />,
  tool: (p) => <ToolCard name={p.tool.name} status={p.tool.status} />,
  file: (p) => <Attachment name={p.filename ?? p.url} />,
  subtask: (p) => <Delegated agent={p.agent} />,
  patch: (p) => <DiffStat files={p.fileCount} />,
  retry: (p) => <Note>{`retrying (attempt ${p.attempt})`}</Note>,
  compaction: () => <Note>context compacted</Note>,
  snapshot: () => null, // internal checkpoint hash — nothing to show
  agent: () => null, // inline @mention, already in the sibling text
  step: () => null, // model-step bookkeeping
  unknown: () => null, // forward-compat: newer server than client
};

function Turn({ message }: { message: MessageWithParts }) {
  const { parts, error, isEmpty } = classifyTurn(message);
  if (isEmpty && !error) return null;
  return (
    <>
      {renderParts(parts, renderers)}
      {error && <TurnFailed {...error} />}
    </>
  );
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
opencode client, and `ensureReady()` all throw/return the same classes (from
the root barrel; `@kortix/sdk/react` re-exports them too). They're real classes: `instanceof` works across every host, and
`name`/shape are preserved for legacy `error.name === 'ApiError'` sniffers.

- `ApiError` — any failed request; branch on `.status` / `.code` (e.g.
  `'TIMEOUT'`, `'RUNTIME_UNAVAILABLE'`, `'ABORTED'`). Timeout errors carry
  `.url` / `.endpoint` / `.timeout`.
- `HeadlessAuthError extends ApiError` — `getToken()` returned null; the request was
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
import { ApiError, HeadlessAuthError, BillingError } from "@kortix/sdk";

try {
  await kortix.session(pid, sid).send(prompt);
} catch (err) {
  if (err instanceof BillingError) {
    // 402 — surface the upgrade/cost payload under YOUR billing story.
    return res.status(402).json({ reason: "quota", detail: err.detail });
  }
  if (err instanceof HeadlessAuthError)
    return res.status(401).json({ error: "not authenticated" });
  if (err instanceof ApiError)
    return res.status(err.status ?? 502).json({ error: err.message });
  throw err;
}
```

Every non-streaming request also carries a **30s default timeout** (the
long-lived SSE event stream is exempt), so a hung sandbox/daemon call can't
wedge a server-side handler forever — it surfaces as an `ApiError` with
`code: 'TIMEOUT'` instead.

Idempotent reads (`GET`/`HEAD`) also absorb transient gateway blips: `502`,
`503`, and `504` retry up to two times with 250ms → 500ms backoff before an
`ApiError` is surfaced. Mutations and HTTP `500` responses are never retried.

LLM session retries can carry the gateway's structured failure chain. Use
`getRetryInfo(status)`. Its optional `details` field contains the final
`provider`, gateway `code`, `requestId`, and ordered `attemptFailures`. Each
failure identifies the provider, route model, resolved model, stage, upstream
status when available, concrete code, and bounded message. Plain legacy retry
messages remain supported and return `details: undefined`. When OpenCode keeps
only the HTTP error message, `getRetryMessage(status)` still returns the full
gateway composite. That message includes the request ID and each candidate's
provider, resolved model, HTTP status, code, and bounded message.

## Entry points

**There are three, plus one internal.** Everything framework-free lives at the
root; the other two exist because each carries a dependency the root cannot.
That is the whole map — learn it once.

| import | when you use it | why it is separate |
| --- | --- | --- |
| `@kortix/sdk` | **almost always.** `createKortix`, `configureKortix`, the REST surface, `files`, session URLs + health, `classifyPart`/`classifyTurn`/`toolViewModel`, `openEventStream`, `narrowChatEvent`, the message queue, the error classes, and every domain type | — |
| `@kortix/sdk/react` | hooks and providers: `useSession`, every `useOpenCode*`, `useChatTurns`/`renderParts`, the domain hooks | `react` is an **optional peer dependency**. Putting these at the root would force React on a CLI, a worker, or a React Native host |
| `@kortix/sdk/server` | `runWithKortix`, `createScopedKortix`, `getScopedConfig` — per-request config isolation in a Node/Bun backend | imports `node:async_hooks`. Never let it into a browser bundle |
| `@kortix/sdk/internal/*` | nothing, in host code | apps/web's zustand stores. Browser-only, **outside semver**, and not on the `window.Kortix` global. Implementation detail that is regrettably visible |

The root really is canonical, and that is a test rather than a promise:
`src/root-canonical.test.ts` asserts that every name exported by every other
isomorphic subpath is also exported from `@kortix/sdk`. The only names it
permits to be missing are the browser-only stores above — `zustand` is a
forbidden import in the root's `isomorphic-core` tier, so they cannot live
there.

```ts
import { createKortix, classifyTurn, listFiles, openEventStream } from '@kortix/sdk';
import { useSession } from '@kortix/sdk/react';
```

### Legacy aliases — do not use in new code

`package.json` still declares about twenty more subpaths: `/turns`, `/files`,
`/session`, `/session/url`, `/auth`, `/config`, `/api-client`,
`/projects-client`, `/platform-client`, `/opencode-client`, `/opencode-errors`,
`/event-stream`, `/feature-flags`, `/fresh-sessions`, `/instance-routes`,
`/message-queue`, and the un-prefixed store aliases.

Every one of them is a one-line `export *` re-export under `src/deprecated/`,
kept alive only so an existing `npm install` does not break. **They add nothing
the root does not already export.** They are removed at the next major; new
code imports the root.

## Configuration

`configureKortix(config)` (called for you by `createKortix`) wires one seam:

```ts
interface KortixPlatformConfig {
  backendUrl: string;
  getToken: () => Promise<string | null>;
  clientSource?: 'api' | 'cli' | 'mobile' | 'web';
  getUserId?: () => Promise<string | null>;
  billingEnabled?: boolean;
  sandboxId?: string | null;
  onError?: (error: unknown, context?: unknown) => void;
  onToast?: (level, message, options?) => void;
  onNotify?: (event) => void;
  featureFlags?: KortixFeatureFlagOverrides; // per-flag overrides for non-Next.js hosts
}
```

Set `clientSource` when a non-web host needs its requests separated in the
centralized audit log. The SDK sends the validated value as request metadata.
Actor identity and permissions still come from the bearer token.

The SDK is host-agnostic: no Next.js / web coupling in the core. The host injects
its token getter and toast/notify sinks; the SDK does the rest. Today that's proven
in React DOM (`apps/web` and the `apps/whitelabel-demo` reference app are the
`configureKortix`/`@kortix/sdk/react` consumers).
The framework-free core — turn classification, session URLs and health, the
REST clients, file operations, transcript formatting — has no React or DOM
dependency and is usable from any JS host, all of it from the root entry;
`apps/mobile` imports `classifyTurn` from `@kortix/sdk` this way.
React Native does not use `@kortix/sdk/react`. Mobile now uses the framework-free
`createHttpSessionSyncController` for message history, status recovery, and older
pagination. Mobile keeps its platform-specific event transport because React
Native cannot consume the SDK's fetch-based SSE stream.
After a turn ends, the controller re-reads the tail until the last assistant
message completes, at most 5 reads. Those repair reads call `hydrate` with
`{ stampActivity: false }`: the page is not evidence that the runtime is
producing, so it must not restart the liveness clock.

## Rules of the road

- **No `@opencode-ai/sdk` in host code.** Import opencode types/client from
  `@kortix/sdk`. The SDK is the sole owner of that dependency.
  (Holds today — no host imports it.)
- **No raw `backendApi` / `authenticatedFetch` in host code.** Use the facade or a
  subpath module. (Aspirational: apps/web still calls `backendApi` via its
  `@/lib/api-client` re-export in ~30 files and keeps a parallel
  `authenticatedFetch` in `apps/web/src/lib/auth-token.ts` — migration pending.)
- **React data** comes from `@kortix/sdk/react` hooks; **imperative actions** from
  the `createKortix` facade.

## Auth

`Authorization: Bearer <token>` — a Supabase JWT (user sessions), a Kortix PAT
(`kortix_pat_…`) for server-side / automation use, or an OAuth access token
(`kortix_oat_…`) minted by "Sign in with Kortix" — supplied via `getToken`.

### Sign in with Kortix (your app, their Kortix account)

Make Kortix the identity provider for an app you run. Register the app once
(`kortix.iam.oauthClients.create`, or Account → Tokens → OAuth apps), then:

```ts
import { createKortixAuth } from '@kortix/sdk/server';

export const auth = createKortixAuth({
  backendUrl: 'https://api.kortix.com/v1',
  clientId: process.env.KORTIX_OAUTH_CLIENT_ID!,
  clientSecret: process.env.KORTIX_OAUTH_CLIENT_SECRET,   // omit for a public (PKCE-only) client
  redirectUri: 'https://app.example.com/api/kortix/auth/callback',
  cookieSecret: process.env.KORTIX_AUTH_COOKIE_SECRET!,   // ≥ 32 chars
});

// one catch-all route: /signin /callback /refresh /signout /me /proxy/*
export const GET = (req: Request) => auth.handler(req);
export const POST = GET;

// anywhere on the server
const gate = await auth.requireViewer(req);        // { viewer } | { response: 302 }
const kortix = await auth.kortix(req);             // acts as the viewer
// in the browser
const client = createKortix(auth.clientConfig());  // talks to Kortix through /proxy
```

`@kortix/sdk/react` adds `useKortixViewer()` and `<SignInWithKortix />`.
Full guide: `/docs/sdk/sign-in`. Example: `examples/11-sign-in-with-kortix.ts`.

### A Kortix-hosted App is already signed in

```ts
const kortix = createKortix({ backendUrl, getToken: kortixAppViewerToken() });  // browser
const viewer = await readAppViewer(request);                                    // server (@kortix/sdk/server)
const asViewer = await createAppViewerKortix(request, { backendUrl });          // act as them
```

The Apps gate authenticated the visitor before your App was served and signs
their identity into every request; `viewer_token_scope` on the App's access
policy decides whether the App also gets a token to act with. Guide:
`/docs/sdk/apps`.

### Headless sign-in (your users, straight through the API)

```ts
const session = kortix.auth.session({ storage });             // self-refreshing token store
const { session: s, user } = await kortix.auth.signInWithPassword({ email, password });
await session.set(s, user);
const asUser = createKortix({ backendUrl, getToken: session.getToken });
```

Also `signUp`, `sendMagicLink` + `verifyOtp`, `signInWithProvider` +
`exchangeCode` (PKCE), `resetPassword`, `updatePassword`, `user`, `signOut` —
all `/v1/auth/*`, no Supabase in the client. Guide: `/docs/sdk/auth`.

## Tests

```sh
pnpm --filter @kortix/sdk typecheck  # package + examples/ (examples/tsconfig.json)
pnpm --filter @kortix/sdk test   # facade, files, react hooks, turns, transcript, session url/health, projects-client domains
```

See **`API-MAP.md`** for the complete endpoint catalogue. It covers the Kortix
REST API and OpenCode REST runtime. See **`CHANGELOG.md`** for
per-release changes.


### Agent repository access

Agent configuration accepts `repository_access?: boolean` (default `true`).
Set `false` to run new sessions without the project repository or repository API access.
Git, secret, connector, and tool permissions remain separate. Existing sessions retain their saved policy.
`AgentConfigBlock.workspace` is deprecated. The SDK maps legacy `branch`/`runtime` to the boolean field.
A legacy `read` write requires an explicit `repository_access` choice; it does not enable read-only repository access.


### Project provider and model access

```ts
const policy = await kortix.projects.modelAccess(projectId);
await kortix.projects.setModelAccess(projectId, {
  target: 'provider', id: 'kortix', enabled: false,
});
await kortix.projects.setModelAccess(projectId, {
  target: 'model', id: 'openai/gpt-5.5', enabled: false,
});
```

`kortix` identifies Kortix Managed Models. Other provider IDs identify BYOK, Codex, or custom providers. Provider disable takes precedence over individual model choices. Each write changes one target and preserves credentials. Disabling the current project default or its provider returns `409 cannot_disable_default`; select another default first.

`useModelAccess(projectId)` from `@kortix/sdk/react` exposes the policy, write state, and `setEnabled(change)`. Successful writes refresh both picker caches. Rejected writes leave the displayed policy unchanged. The policy blocks gateway inference; legacy `setProjectModelEnablement` remains display-only. Native runtimes that bypass the gateway return `enforced: false`.

### Pooled ChatGPT connections

With the `pooled_provider_secrets` and `llm_gateway` project flags enabled, a
member can create a named ChatGPT OAuth account resource:

```ts
const challenge = await kortix.project(projectId).secrets.startProviderOAuth('openai', {
  resourceLabel: 'My ChatGPT account',
});
// Show challenge.verification_url and challenge.user_code, then poll the flow.
const result = await kortix.project(projectId).secrets.pollProviderOAuth('openai', challenge.flow_id);
```

Poll until `result.status` is `success`, `failed`, or `expired`. A successful
named flow returns `credential.secret_id`. It creates a separate project-scoped
account resource; reconnecting does not replace another account. Every project
member can use it by default. The owner can restrict access to selected members.
A session can select one or more available
ChatGPT resources through its provider secret pool (`providerId: 'codex'`).
Without an explicit session selection, the caller's newest personal ChatGPT
resource is used. The legacy project login remains the fallback when that
caller has no personal resource.

### ChatGPT subscription usage

`getSessionCost` and `getTurnCost` report zero LLM cost for ChatGPT/Codex
subscription messages. This also corrects historical runtime costs. Token
counts remain available. Mixed sessions retain paid API costs; OpenAI API
models remain billable. Subscription coverage does not include sandbox compute.

### Durable prompt placement

`createSessionPrompt` and `useSessionPrompts().enqueue` accept an optional
`placement: 'transcript' | 'composer'`. `transcript` (Quick Queue) runs before
every `composer` (Queue List) entry and ends the active response after its
current tool call. `composer` waits for the active response to finish. Each
placement keeps submission order. A row without placement keeps its submission
order ahead of `composer` entries and is presented as `composer`.

`SessionPrompt.full_text` preserves complete text for rendering after reload;
`text` remains the bounded preview. List responses expose attachment names and
MIME types without attachment bytes. Removal responses retain the complete
parts and captured model options for undo.

Queued work keeps `useSessionWorking().state` at `working` so it can be stopped.
`pendingDelivery: true` distinguishes a send waiting for runtime delivery from an
active agent response. The web app still shows one working indicator whenever the
session is `working`, so Stop is never the only sign of work.
A timed-out or skipped cancel does not acknowledge an abort receipt.

A worker claim only checks admission and keeps the prompt waiting. Delivery starts
after admission succeeds. A confirmed active turn clears the pending presentation
even if the previous inbox snapshot still lists that prompt. Runtime activity
preserves the active turn's message ID during this handoff.

Web calls Enter **Quick Queue** and Command/Ctrl+Enter **Queue List**. Both
advance automatically; Quick Queue entries run first. Queue List entries stay editable
until delivery begins. Stop pauses pending entries; Resume releases that hold.

Pass the inbox IDs, in queue order, as `pendingMessageIds` to
`groupMessagesIntoTurns(messages, { pendingMessageIds })`. Client-minted wire
IDs still represent waiting prompts. The renderer keeps them after delivered
turns until the inbox releases them.

Queue acceptance and runtime execution are separate states. Each distinct submission
appears immediately, including while a previous POST is pending. The working hook
updates `pendingDelivery` when the same turn becomes active, without waiting for
a different turn ID or timestamp.

### Queue row actions

`useSessionPrompts().remove` and `.retry` are one request per row intent,
shared by every mounted `useSessionPrompts` of the session. A second call of
the same action while the first is in flight returns that promise and sends
nothing. A call of the *other* action rejects without sending, with an `Error`
whose `code` is `prompt_action_pending`. A `remove` of a row this tab already
removed, inside the 15 s tombstone window, resolves that earlier
`RemovedSessionPrompt` and sends nothing.

`pendingActions` maps `prompt_id` to the action in flight (`'retry'` or
`'remove'`). A row with an entry must not offer another action — gate Retry,
Remove and Edit on it. Both actions resolve on their own request; the list
refetch that follows does not hold the caller.

`classifyPromptActionError(error)` turns any refusal into one of five
outcomes. Map the outcome to your own words; never show `error.message`.

| Outcome         | Cause                                                             |
| --------------- | ----------------------------------------------------------------- |
| `gone`          | 404 `prompt_not_found` — the row is no longer in the inbox.        |
| `already_sent`  | 409 `prompt_already_sent` — a model step already read it.          |
| `unreachable`   | 409 `prompt_cancel_unreachable`, a timeout, or no server answer.   |
| `pending`       | `prompt_action_pending` — the other action on this row is running. |
| `failed`        | Anything else.                                                    |

`retry` has no optimistic state: the row keeps its listed state until the
server answers, and `pendingActions` is what says it is being retried.
`retrySessionPrompt` answers `observed_at`, the server's clock after the write,
so a list read stamped before it cannot repaint the row `failed`. Delivery
re-mints the retried row's wire id; a delivery that already landed is not run
twice because the delivery idempotency key dedupes it, not because the id is
unchanged.

`SessionPrompt.failure_code` is why delivery gave up, as a stable code
(`last_error` stays the server's prose). It is `null` unless `state` is
`failed`, and a row failed before the server recorded codes reads `unknown`.
The vocabulary is `out_of_credits`, `model_unavailable`, `connector_required`,
`runtime_unreachable`, `not_landed`, `redelivery_exhausted`, `rewound`,
`session_gone`, `refused`, `unknown`. Treat any code you do not recognize as
`unknown`, so new codes stay additive.

Undo re-creates a removed row with `createSessionPrompt({ restore: true })`.
A restore does not release the session's hold, so Undo after Stop does not
resume the queue. `RemovedSessionPrompt.held` reports whether the removed row
was held; pass it back as `held` so the restored row keeps that hold. A restore
reaches the host `onError` sink only for a `402`.

### Server turn authority

`useSessionWorking().serverOpenTurnToken` is the `turn_token` the control plane
holds open in the freshest `/turn` read, deliberately age-free: it keeps the
transcript liveness poll running. A caller that HOLDS a control on that token —
Stop pinned by a retrying assistant, for example — reads
`serverOpenTurnFresh` instead. It is `true` only while the token is set AND the
read behind it is younger than the projection's observation bound.

`turnId` names a turn only from a `/turn` read issued after the current busy
phase began. Immediately after a busy frame it is `null` until that read lands,
which costs one round trip. A session-open bundle's `/turn` answer never names
a turn against a busy-phase stamp and never retires the inbox drain floor. A
queued send's receipt names the running turn only while that turn runs; the
wire idle frame, or a new busy phase, ends the association. A row leaving the
inbox list arms the drain floor when it was live work — `queued`, `delivering`,
or `waiting` for any reason except `held` — and this tab neither minted it
optimistically nor removed it.

`useSessionSync(sessionId, { openTurnTokens })` takes the `turn_token`s the
control plane currently holds open (`null` means unknown). When a token of the
last set is absent from the next one, the hook issues one `'turn-end'`
transcript read while the session stays busy, so a turn that ends into a queued
prompt still settles without an idle frame. `openTurnTokensEnded(previous,
next)` is that set comparison, exported for hosts that hold the list
themselves.
