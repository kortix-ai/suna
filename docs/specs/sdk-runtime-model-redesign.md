# SDK Runtime Model — first-principles redesign (per-session, no "active server")

> Status: **proposal** · 2026-06-27 · Follows `sdk-session-collapse.md` (which shipped
> `useSession`). This redesigns the layer *underneath* it — the client/server/store model —
> grounded in how OpenCode's own web app is built (`sst/opencode` `packages/app`).
>
> **North star:** a session binds to its sandbox's OpenCode runtime and gets its **own**
> client + SSE + store. There is **no global "active server."** "Current session" is a UI
> concern, not a runtime switch. The client side holds almost nothing — complexity lives in
> the SDK's per-session context and in the Kortix API.

---

## 0. The realization

We built an "active server" global (`server-store.activeServerId` + `getClient()` resolving
it + `setActiveServer` bumping `serverVersion` → resetting the client, nuking the connection
store, firing `registerClientResetter`/`registerConnSwitchReset` callbacks). We did this to
make our **many-OpenCode-servers** world (one per sandbox) behave like a **single-server**
world.

**OpenCode's own web app already solved this — and not with a global switch.** It keeps a
**cache of independent server contexts** and treats "active" as pure UI:

```ts
// sst/opencode  packages/app/src/context/global.tsx:37-53
const serverCtxs = new Map<ServerConnection.Key, { dispose; serverCtx }>()
const ensureServerCtx = (conn) => {                 // lazily create + retain per key
  const existing = serverCtxs.get(key); if (existing) return existing.serverCtx
  const root = createRoot((dispose) => ({ dispose, serverCtx: createServerCtx(conn, …) }))
  serverCtxs.set(key, root); return root.serverCtx  // disposed when the server is removed
}
```

Each context owns **one** persistent SSE stream (`client.global.event()`, 16ms-coalesced) and
**its own** store; switching the UI just renders a different context. We have the same
primitive already — `getClientForUrl(url)` with a per-URL cache — we just don't use it as the
model. **The redesign is: adopt OpenCode's pattern, keyed by session.**

---

## 1. The flow, from first principles

| Concept | What it is | Where it lives | SDK's job |
| --- | --- | --- | --- |
| **Project** | A repo + config | Kortix DB | plain REST CRUD — `kortix.projects` / `kortix.project(id)` |
| **Session** | One agent run; **always owns a sandbox** | Kortix DB + a provisioned sandbox | REST CRUD + **bring its runtime up** (`/start`) |
| **Sandbox** | The disposable box | provider (Daytona/…) | invisible — never named in the public surface |
| **Runtime** | The **OpenCode daemon** in the sandbox (port 8000) | inside the sandbox, reached via the Kortix API `/p/<sandbox>/8000` proxy | connect to it: one client + one SSE + one store, **per session** |

So the only runtime question is: *given `(projectId, sessionId)`, what's the OpenCode URL, and
talk to it.* The server already answers the first half (`/start` returns `runtime_url`). The
SDK's entire runtime responsibility is the second half — and it should be **one small
per-session context**, not a global machine.

---

## 2. What's wrong today (measured)

1. **Global active-server singleton** (`opencode/client.ts:getClient` + `server-store`).
   `getClient()` resolves ONE `activeServerId`. `setActiveServer` → `serverVersion++` →
   `resetSDKClient()` + `_connSwitchReset()` + the event-stream re-effect. This is the
   no-concurrency limit **and** a brittle reset-cascade **and** the reason for the
   `registerClientResetter`/`registerConnSwitchReset` manual-DI callbacks (added only to break
   the import cycle the singleton creates). ~57 `getClient()` + ~22 `getActiveOpenCodeUrl()`
   call sites hang off this.
2. **Store duplication** (`sync-store` vs `opencode-pending-store`). The SSE writes
   `permission`/`question` to **both** (`handle-event.ts` → pending-store; `sync-store.applyEvent`
   → sync-store). `useSessionSync` returns the sync-store copies (`use-session-sync.ts:411-416`)
   — **and nobody reads them** (verified). `useSession` reads the pending-store. The sync-store
   copies are dead.
3. **Aspirational internal boundary** — `react/opencode.ts` marks plumbing "internal" but still
   exports it; the boundary isn't enforced.

---

## 3. Target model

### 3a. The per-session runtime context (replaces "active server")

A session's runtime is a small cached context, keyed by session (mirrors OpenCode's
`serverCtxs`):

```
sessionRuntime(projectId, sessionId) → {
  url:    string            // `${backendUrl}/p/<sandbox>/8000`, from /start runtime_url
  client: OpencodeClient    // getClientForUrl(url) — already exists, per-URL cached
  events: SSE subscription  // one stream for THIS url, 16ms-coalesced (today's engine)
  // its store slice is the existing per-sessionId sync-store keys — no per-context store needed
  dispose()
}
```

- `getClient()` (global) → **deleted**. Every runtime call takes the session's client (or
  `getClientForUrl(url)`).
- `server-store`'s `activeServerId` / `serverVersion` / `urlVersion` / `setActiveServer` /
  `switchToSessionSandboxAsync` / the reset-cascade → **deleted**. A `servers[]` registry may
  survive ONLY for non-session UI (the instance sidebar), with no "active" runtime meaning.
- `registerClientResetter` / `registerConnSwitchReset` / `resetForServerSwitch` /
  `resetClient` / `cachedClient`/`cachedUrl` → **deleted** (nothing to reset; each url has its
  own cached client).
- "Current session" = which session the UI renders. Two sessions in two tabs = two contexts,
  two SSE streams, two URL-keyed clients — concurrently, for free (the OpenCode model).

### 3b. The store set (one source of truth each)

| Store | Owns | Keyed | Verdict |
| --- | --- | --- | --- |
| **sync-store** | messages, parts, sessionStatus, diffs, todos | sessionID | **KEEP** — but **drop** its `permissions`/`questions` (dead) |
| **opencode-pending-store** | questions, permissions, `resolvedQuestionIds` | request id | **KEEP** — the authority for interactive prompts (a refinement over OpenCode, which keeps them sessionID-keyed in the directory store; request-id keying + the resurrection guard is better for modal UIs) |
| **sandbox-connection-store** | connection/health phase | (per session) | **KEEP** — but it stops being reset by a global switch; it becomes per-session readiness |
| **diagnostics / compaction / session-status** | LSP / compaction / status UI | file / sessionID | **KEEP** — single-concern |
| **server-store** | sandbox registry for non-session UI | serverId | **SHRINK** to a registry; remove all "active" runtime semantics |
| **tab-store** | UI tab state | tabId | **KEEP** (UI only); decouple from server-store's "active" |

Net: the runtime data a host sees is `sync-store` (history) + `pending-store` (prompts) +
`connection` (phase) — all per-session, all behind `useSession`.

### 3c. Thin client + server leverage

- **SDK = HTTP + SSE only**, exactly like OpenCode: TanStack Query for pull, SSE for push, the
  per-session context owns the stream + dispose. No bespoke client state machine.
- **Push to the Kortix API** (we own it):
  - `runtime_url` (shipped) — server owns the proxy scheme; client treats it opaquely.
  - *Next:* a **stable per-session runtime route** `/projects/:id/sessions/:sid/runtime/*` so
    the client never sees `sandbox`/`external_id`/`/p/` at all.
  - *Next:* fold "runtime ready" into the start response / an event so the client never probes.
  - This is the same principle as the original collapse: every concept we can resolve
    server-side is one less thing the client models.

---

## 4. Migration (safe first → full)

1. **Dead-store cut (zero risk, now).** Delete `sync-store`'s `permissions`/`questions`
   (fields, init, the `applyEvent` cases, the `useSessionSync` selectors/returns). Nobody reads
   them; the pending-store is unaffected. (~60 lines out of `sync-store`.)
2. **Singleton → factory (low risk).** `getClient()` → `return getClientForUrl(getActiveOpenCodeUrl())`;
   delete `cachedClient`/`cachedUrl`/`resetClient`/`registerClientResetter`; remove the
   `resetClient()` calls from the event stream's serverVersion branch. Behavior-preserving for
   single-session; deletes the singleton + half the reset-cascade. **Needs an SSE-reconnect
   runtime check on :13100.**
3. **Per-session context (the real refactor).** Introduce `sessionRuntime(pid,sid)` and route
   `useSession`'s client/SSE/sync/send through the session's URL; thread the URL (context) to
   the web's file/terminal/git hooks; delete `activeServerId`/`setActiveServer`/`serverVersion`/
   `switchToSessionSandboxAsync` + the connection-store reset. This is the ~50-file web change —
   its own tested PR, and it's what unlocks concurrent live sessions.
4. **Server route.** Add the stable `/sessions/:sid/runtime/*` proxy; drop `/p/` from the client.
5. **Enforce the boundary.** Move the genuinely-internal exports behind `@kortix/sdk/internal`.

Steps 1–2 are this branch's cleanup. Steps 3–5 are the redesign proper (sequenced PRs).

---

## 5. What gets deleted (the bold list)

`getClient` singleton (`cachedClient`/`cachedUrl`/`resetClient`) · `activeServerId` ·
`serverVersion` · `urlVersion` · `setActiveServer` · `switchToSessionSandboxAsync` ·
`switchToInstanceAsync` (→ fetch-only) · `registerClientResetter` · `registerConnSwitchReset` ·
`resetForServerSwitch` · the event-stream `serverVersion` reset branch · `sync-store`'s
`permissions`/`questions` + their `applyEvent` cases + `useSessionSync` returns · the lying
comment in `react/opencode.ts` about `useSessionSync` not surfacing prompts.

The end state: `useSession(pid, sid)` → a per-session context (url → client → SSE → store) with
nothing global in between. The SDK stops *managing* runtime and just *connects* to it — which
is all it was ever supposed to do.
