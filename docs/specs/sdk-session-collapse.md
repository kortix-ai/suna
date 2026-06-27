# SDK: Collapse the session runtime into `useSession` — Spec

> Status: **proposal** · 2026-06-27 · Folds into PR #3825 (the `@kortix/sdk` + white-label
> branch — one big merge).
>
> **North star:** a host should never touch the sandbox. Opening a session and streaming a
> chat must be **one hook** — `useSession(projectId, sessionId)` — with start, readiness,
> SSE, id-resolution and the per-session client all **inside** the SDK. The host imports
> `createKortix`, `useSession`, and nothing sandbox-shaped. The server hands the client a
> ready, stable per-session URL so there is **no client-side health poller at all.**

---

## 0. Decision

**Delete the host-orchestrated runtime dance. Replace it with one SDK hook + a server-owned
per-session runtime URL.**

- **One public hook** — `useSession(projectId, sessionId)` returns
  `{ messages, status, phase, isBusy, send, abort, questions, permissions, models, agents, picks, preview }`.
  Internally it does start → resolve runtime → open SSE + sync messages. The host writes
  **zero** plumbing.
- **No client health poller.** `/start` already proves OpenCode is ready server-side
  (`ensureOpencodeSessionPin` runs before it returns `stage:'ready'`). The client trusts
  that. **This removes the entire bug class** behind the first-load stream failure — there
  is no poller left to halt.
- **Server-owned per-session URL.** `/start` returns a stable `runtime_url`
  (`/projects/:id/sessions/:sid/runtime/*`) that the API proxies to the right box
  internally. The client never sees `sandboxId`, `external_id`, the `/p/` scheme, or "the
  active server."
- **Per-session clients, not one global.** Key the OpenCode client by URL
  (`getClientForUrl`, already present) instead of a single global `activeServerId`. Two
  sessions can be live at once; switching one no longer nukes the other's stream.

Why: today the host choreographs **7–12 steps** and the `healthy` gate leaks into **31
locations** in `apps/web`. The runtime plumbing is **duplicated** (the SDK has a poller +
server-store + connection-store; `apps/web` has its *own* parallel copies) — which is
exactly why the first-load bug had to be fixed in two files. All of it is liability that
opencode + the API already make unnecessary.

---

## 1. The problem today (what leaked)

### 1a. The dance — what a host does to open ONE session

From `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx`:

1. `POST /start`, poll until `stage:'ready'`.
2. Read `activeInstanceId` out of the SDK's `server-store` (subscribe + array lookup).
3. `switchToSessionSandboxAsync(projectId, sandboxId, row)` — point the **global** active
   server at this session's box (idempotent, but re-asserted in a loop until it matches).
4. Seed the connection store (`markProvisioningVerified` / `markRuntimeReadyVerified`) so
   the poller starts optimistic.
5. Gate the chat mount on `activeInstanceId === sandbox.sandbox_id`.
6. Mount `useSandboxConnection()` (the health poller) **and** `OpenCodeEventStreamProvider`
   (the SSE) in the right tree position.
7. `useCanonicalOpenCodeSession({ pinFromStart })` to resolve the opencode root id, then
   gate the chat on `runtimeReady` (`status==='connected' && healthy===true`).

The white-label demo already compresses this (one `<SessionRuntime>` wrapper), but **still**
leaks the switch + the id-resolution. The target erases all of it.

### 1b. The concepts the host is forced to know (should all be SDK-internal)

`activeServerId` · `activeInstanceId` · `sandboxId` / `external_id` · the
kortix-session-id ↔ opencode-session-id split · `server-store` (global singleton) ·
`switchToSessionSandboxAsync` · `useSandboxConnection` · `OpenCodeEventStreamProvider`
placement · `useCanonicalOpenCodeSession` · the `/p/:sandboxId/:port` proxy scheme · the
`healthy` flag (**31 gate sites** across `apps/web`: session chat, file tree, terminal,
git-status, browser, connect screen, …).

### 1c. The bug-as-symptom

The first-load stream failure (`use-sandbox-connection.ts`: a 503 "still booting" branch
returned before re-scheduling → poller halts → `healthy` never flips → `useSessionSync` +
SSE never subscribe) is a **direct consequence** of the host owning readiness. It was
patched in **two** copies (SDK `f23a8c583`, web `f33396bbf`). With no client poller — the
server is the source of truth for "ready" — this failure mode cannot exist.

### 1d. The design smell — one global active server

`opencode/client.ts:getClient()` resolves a single `activeServerId`; `setActiveServer`
bumps `serverVersion`, which `resetSDKClient()`s and resets the connection store. So:
- **No concurrent sessions** — switching to session B aborts A's SSE, resets A's health,
  reloads A's messages. Tabs / split views are impossible.
- The module-level `messageCache` in `use-session-sync.ts` assumes one active session.
- `getClientForUrl(url)` **already exists** (per-URL client map) and is unused on the main
  path. The singleton is a choice, not a constraint.

---

## 2. Target architecture

```
HOST (any white-label)
  const s = useSession(projectId, sessionId)
  → s.messages · s.send · s.abort · s.status · s.phase
    s.questions · s.permissions · s.models · s.agents · s.picks · s.preview
  (imports: createKortix, useSession. NOTHING sandbox-shaped.)
        │
        ▼
@kortix/sdk  (useSession — all plumbing INTERNAL)
  start() ──▶ POST /projects/:id/sessions/:sid/start?wait_ms=30000
                 └─▶ { stage:'ready', opencode_session_id, runtime_url }   ← one response, go-live
  getClientForUrl(runtime_url)         ← per-session client, no global switch
  SSE + useSessionSync(opencode id)    ← subscribe immediately; no health poll
  derive phase: 'starting' | 'ready' | 'error'
        │
        ▼
KORTIX API
  /projects/:id/sessions/:sid/start    ← already resolves readiness + pin server-side
  /projects/:id/sessions/:sid/runtime/* ← NEW stable proxy → forwards to the right box
                                          (reuses forwardToSandbox; client never sees /p/)
```

- **Readiness is server-truth.** `/start` (long-poll via `?wait_ms`) returns `stage:'ready'`
  only after `ensureOpencodeSessionPin` confirms the daemon answers. The client does not
  re-verify.
- **One stable URL per session.** The API owns the sandbox→URL mapping; the client uses the
  same `runtime_url` for messages, prompt, events, config, providers.
- **Per-session client.** Keyed by `runtime_url`. Concurrent sessions are independent.

---

## 3. The public surface (`useSession`)

```ts
export function useSession(projectId: string, sessionId: string): UseSession;

interface UseSession {
  // data (live)
  messages: MessageWithParts[];
  status: SessionStatus;                       // opencode session status
  questions: QuestionRequest[];                // this session's interactive prompts
  permissions: PermissionRequest[];
  diffs: FileDiff[];
  todos: Todo[];

  // lifecycle (one derived enum replaces the 31 healthy-gates)
  phase: 'starting' | 'ready' | 'error';
  isBusy: boolean;                             // agent is generating
  isLoading: boolean;                          // first hydrate
  error: unknown;

  // actions
  send(text: string, opts?: { model?: ModelKey; agent?: string }): void;
  abort(): void;
  runCommand(command: string, args: string): void;

  // server-side capabilities (pre-runtime; already server hooks today)
  models: ModelOption[];                       // useProjectModels
  agents: AgentOption[];                        // useVisibleAgents
  picks: SessionPicks;                          // per-session model/agent selection
  defaultAgent: string | null;
  commands: CommandSpec[];

  // runtime-derived UI affordances
  preview: URL | null;                          // session preview (port 3000+), SDK-built
}
```

**Host import surface after the collapse:** `createKortix`, `kortix.project(id)`,
`kortix.session(pid,sid)` (REST), `useSession(pid,sid)`. **Removed from host code:**
`server-store`, `switchToSessionSandboxAsync`, `useSandboxConnection`,
`OpenCodeEventStreamProvider`, `useCanonicalOpenCodeSession`, `useSessionSync` (now internal),
the `sandbox-connection-store`, every `healthy` read.

`useSession` is a thin composition over today's hooks — `useProjectModels` /
`useVisibleAgents` / `useProjectConfig` (unchanged, server-side) + the now-internal runtime
trio. The white-label's `useChat` (optimistic send, stash replay, unified cancel) folds in
as the reference behavior.

---

## 4. What moves INTO the SDK (internal)

- **Runtime lifecycle** — `start()` + runtime-URL resolution + per-session
  `getClientForUrl`. No host switch call; `useSession` owns it on mount, keyed by
  `(projectId, sessionId)`.
- **Readiness** — derived from `/start` `stage`, **not** a poll. `phase:'starting'` until
  `stage:'ready'`; `'error'` on terminal `retriable:false`. (Keep a *single* lightweight
  liveness re-check on SSE disconnect, not a steady-state poll.)
- **SSE + message sync** — `OpenCodeEventStreamProvider` + `useSessionSync` mount internally
  once `runtime_url` is known; no host placement, no `healthy` gate.
- **Id resolution** — `useCanonicalOpenCodeSession` becomes internal; prefer the
  `opencode_session_id` already returned by `/start` (no fallback fetch in the common path).

---

## 5. Server-side changes (move hops server-side)

1. **`runtime_url` on `/start`.** Add `runtime_url: string` to `SessionStartResult`
   (`apps/api/src/projects/routes/shared.ts`). A stable per-session path the SDK uses
   verbatim.
2. **Session runtime proxy.** New route `ALL /projects/:id/sessions/:sid/runtime/*` that
   resolves the session's current sandbox and forwards to `/<box>/8000/*` internally
   (reuse `forwardToSandbox` from the preview proxy). The client never constructs `/p/`
   URLs or learns `external_id`. (Ports 3000+ for user previews still resolve directly —
   `preview` URL — that model is correct and stays.)
3. **Always long-poll.** SDK calls `/start?wait_ms=30000` so go-live latency is a single
   round-trip, not ~800ms poll cycles.
4. **Delete the client health poller.** Remove `useSandboxConnection` from both the SDK and
   `apps/web`; remove the `sandbox-connection-store`. Readiness comes from `/start`.
5. *(Optional, later)* push a `runtime.ready` event over the existing SSE so even the
   `starting → ready` transition needs no extra call. Not required for v1.

No breaking change to existing `/start` consumers — `runtime_url` is additive; legacy `/p/`
proxy stays until the migration completes.

---

## 6. The design fix — kill the global active-server singleton

- Route the main path through `getClientForUrl(runtime_url)` (already implemented in
  `opencode/client.ts`); retire `getClient()`/`activeServerId`/`setActiveServer`/
  `serverVersion` from the session path.
- Key `messageCache` (and the pending/SSE stores) by `(runtime_url | opencode session id)`
  so two live sessions don't collide.
- `server-store` shrinks to (at most) a registry of known boxes for non-session tooling;
  the session path no longer mutates a global.

---

## 7. What to rip out / keep

**DELETE**
- `apps/web/src/hooks/platform/use-sandbox-connection.ts` + `apps/web/src/stores/sandbox-connection-store.ts`
  (the web's parallel poller + store).
- `packages/sdk/src/react/use-sandbox-connection.ts` + the SDK `sandbox-connection-store`.
- Host orchestration in the web session page (steps 2–7 of §1a): the switch effect, the
  `activeInstanceId` gate, the connection-store seeding, the explicit provider mounts.
- The 31 `healthy`/`runtimeReady` gate sites → read `s.phase` from `useSession`.
- `ProjectSessionRuntimeConnection` / `SessionRuntime` wrappers (absorbed by `useSession`).

**KEEP / move internal**
- `useSessionSync`, `OpenCodeEventStreamProvider`, `useCanonicalOpenCodeSession`,
  `getClientForUrl`, the pending store — kept, but **internal** to `useSession` (no longer
  host-facing exports).
- `useProjectModels` / `useVisibleAgents` / `useProjectConfig` — unchanged (already
  server-side, pre-runtime).
- `/start`'s server-side pin resolution (`ensureOpencodeSessionPin`) — it's the foundation
  this leans on.
- The preview-URL builder for ports 3000+ (direct browser access) — correct as-is.

---

## 8. Phases

0. **Spec sign-off** (this doc).
1. **Server: `runtime_url` + session runtime proxy.** Add the field + the
   `/sessions/:sid/runtime/*` route; verify messages/prompt/events flow through it. (No
   client change yet.)
2. **SDK: `useSession`.** Compose start → `getClientForUrl(runtime_url)` → SSE + sync → one
   `phase`. Ship behind the existing hooks (don't delete yet). Wire the **white-label demo**
   to `useSession` first (smallest surface) and verify a fresh session streams turn-1 with
   no poller.
3. **Kill the poller.** Delete `useSandboxConnection` + the connection store (SDK + web);
   `phase` comes from `/start`. Verify first-load stream + reconnect-after-idle.
4. **Migrate `apps/web`.** Replace the 7-step mount + 31 gates with `useSession`/`s.phase`;
   delete the web's parallel `server-store`/`sandbox-connection-store`.
5. **Per-session client.** Retire the global `activeServerId` from the session path; key
   caches by URL. Verify two sessions live at once (two tabs) don't cross-nuke.
6. **Verify e2e** (fresh session, reload mid-turn, switch sessions, questions/permissions,
   preview) + remove dead exports from the SDK's public surface.

---

## 9. Open questions / risks

- **Reconnect without a poller.** Steady-state readiness is server-truth, but a box can die
  mid-session. Plan: rely on SSE disconnect + a **single** liveness re-check (not a loop),
  surfaced as `phase:'error'` with a retry; confirm this covers the "sandbox recycled while
  idle" case the poller handled.
- **`runtime_url` auth.** The session runtime proxy must enforce the same project/account
  authorization the `/p/` proxy does today — verify no broadened access.
- **Migration ordering.** White-label → `useSession` first (low risk), `apps/web` last (it
  has the most gate sites). Keep the legacy exports until step 4 lands so nothing breaks
  mid-migration.
- **Scope vs. #3825.** This is folded into the one big merge — it grows the PR
  meaningfully. The poller deletion + `useSession` are the load-bearing wins; the
  per-session-client refactor (§6) can be the last commit and is the most isolated to defer
  if the merge needs to ship sooner.

---

## 10. The wider centralization map (investigation 2026-06-27)

The same "host owns what it shouldn't" pattern recurs beyond the session runtime. **Bolded**
items fold into THIS merge (cheap SDK primitives + the core collapse); the rest are sequenced
follow-ups recorded here so this doc stays the complete source of truth.

### 10a. Cheap SDK primitives the white-label reimplements → move into `@kortix/sdk` (fold in)

| Primitive | Reimplemented in | New SDK shape |
| --- | --- | --- |
| **Per-session model/agent picks** | `apps/whitelabel-demo/src/lib/session-picks.ts` | `useSessionPicks(sessionId)` (`/react`) |
| **Runtime phase** | `apps/whitelabel-demo/src/lib/runtime.tsx` | `useRuntimePhase(sessionId)` — the public face of readiness; replaces every `healthy` read |
| **Start-stash** (new-session → workbench hand-off) | `apps/whitelabel-demo/src/lib/session-start.ts` | `stashSessionStart` / `readSessionStartStash` / `clearSessionStartStash` |
| **Session-id (uuid) with non-secure fallback** | `apps/whitelabel-demo/src/lib/uuid.ts` | `generateSessionId()` |
| **Query-key factory** | `apps/whitelabel-demo/src/lib/query-keys.ts` | `queryKeys()` |
| **Make-internal** | exports leaked from SDK | drop `server-store`, `getClient*`/`resetClient`, `OpenCodeEventStreamProvider`, `useSandboxConnection`, `useCanonicalOpenCodeSession`, raw `sandbox-connection`/`sync` stores from the public surface |

### 10b. Server consolidations (sequenced follow-ups — heavier, mostly server-side)

| Consolidation | Current | Target | Saves |
| --- | --- | --- | --- |
| **Project bootstrap** (cheap — candidate to fold in) | `GET /detail` + `GET /llm-catalog` (detail already loads config; catalog already fetched alongside) | one `GET /projects/:id/bootstrap` | 1 hop / project load |
| **Provider list + secrets** | list providers → `listProjectSecrets` → merge client-side | `GET /projects/:id/providers` with embedded `connected`/`secret_set` | 1 hop (BYOK) |
| **First-project onboarding** | 3–4 client calls (exists? + marketplace defaults + provision) | one `/projects/ensure-first` | 2–3 hops / signup |
| **File commit diffs** | parallel `/commits/:sha` + `/diffs/:sha?path=` | one `/files/:path/commit-diff/:sha` | 1 hop / diff view |
| **Provisioning monitor** | `apps/web/.../use-sandbox-poller.ts` (~450 lines: SSE + HTTP fallback + interpolated progress) | folds into `useSession`'s `phase` (the `starting` sub-states) | a whole second poller |
| **Server-pushed lists (SSE)** | 5s/10s `refetchInterval` (session list, change-request counts, provider state, sandbox health) | `GET /projects/:id/events` SSE | 12–30 req/min/user — highest continuous cost, heaviest lift |
| **Billing + project-setup aggregation** | `use-account-state.ts` (~545 lines, refetch dedup) + `use-project-setup.ts` (5-query aggregate) | SDK hooks / server-cached `/setup-status` | separate domain |

This keeps the merge focused — the **core collapse (§2–§7) + 10a's cheap primitives** — while
recording the full path. The SSE-lists + billing work are their own future PRs.
