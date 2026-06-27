# Lumen — white-label reference app

A complete, production-shaped agent client built **100% on `@kortix/sdk`**. It
is the golden reference for using Kortix as your backend: projects, sessions,
and **real, token-by-token streaming agent chat** — with zero raw `fetch`, zero
`@opencode-ai/sdk` imports, and no transport code in the app itself.

Rebrand `src/config/brand.ts`, point `NEXT_PUBLIC_KORTIX_API_URL` at your Kortix
backend, and you have a white-label coding agent.

## What it demonstrates

| Route | SDK surface |
| --- | --- |
| `/` | `kortix.projects.list()` behind an API-key gate |
| `/projects/[id]` | `kortix.project(id).get()` · `.sessions.list()` · `.sessions.create()` |
| `/projects/[id]/sessions/[sessionId]` | the full reactive chat stack (below) |

Every Kortix call goes through the one client created in `src/lib/kortix.ts`:

```ts
import { createKortix } from '@kortix/sdk';

export const kortix = createKortix({
  backendUrl: BRAND.apiUrl,            // e.g. https://api.kortix.com/v1
  getToken: async () => getApiKey(),   // your auth — here, a pasted API key
});
```

## Auth: one API key

The whole auth story is `getToken`. Lumen stores a single Kortix **API key**
(`kortix_pat_…`) in `localStorage` and hands it to the SDK. Create one in the
Kortix dashboard under **Settings → API keys** (account-wide, or scoped to a
single project). No Supabase, no sessions table, no cookies. See
`src/components/api-key-gate.tsx` and `src/lib/kortix.ts`.

## The reactive chat stack

Opening a session is the only non-trivial flow. The SDK owns every moving part;
the app just composes them in order (`sessions/[sessionId]/page.tsx`):

1. **Start** — poll `kortix.session(pid, sid).start(15_000)` until
   `stage === 'ready'`. The server long-polls, so "ready" arrives the instant the
   sandbox + OpenCode runtime are up. It returns the sandbox row and the
   canonical OpenCode session id (`opencode_session_id`).
2. **Switch** — `switchToSessionSandboxAsync(pid, sid, sandbox)` (from
   `@kortix/sdk/server-store`) points the SDK's active runtime at this session's
   sandbox. After this, every react hook talks to it.
3. **Connect** — `<SessionRuntime>` (`src/lib/runtime.tsx`) mounts
   `useSandboxConnection()` (polls `/kortix/health`, flips the connection store to
   `healthy`) and `<OpenCodeEventStreamProvider />` (opens the live SSE stream).
4. **Resolve** — `useCanonicalOpenCodeSession({ projectId, sessionId, pinFromStart })`
   yields the OpenCode root session id to bind the chat to.
5. **Sync + send** — `useSessionSync(rootId)` returns live `messages` / `status`
   (fed by SSE, gated on `healthy`); `useSendOpenCodeMessage()` sends a prompt;
   `useAbortOpenCodeSession()` stops a run.

```
start() ─ready─▶ switchToSessionSandboxAsync
                          │
              ┌───────────┴───────────┐
   useSandboxConnection()   OpenCodeEventStreamProvider   (SessionRuntime)
              │                        │
              └─ healthy=true ─▶ useSessionSync(rootId) ◀─ SSE events
                                       │
                       useSendOpenCodeMessage / useAbortOpenCodeSession
```

Sending omits the model, so the agent uses the session's configured default —
pass `options.model: { providerID, modelID }` to `useSendOpenCodeMessage` to
override per message.

## Run it

```bash
pnpm install
NEXT_PUBLIC_KORTIX_API_URL=https://api.kortix.com/v1 \
  WHITELABEL_PORT=3010 pnpm --filter @kortix/whitelabel-demo dev
```

Point `NEXT_PUBLIC_KORTIX_API_URL` at a local stack (`http://localhost:8008/v1`)
to develop against it. Then open the app, paste an API key, and go.

## Make it yours

- **Brand** — `src/config/brand.ts` (name, tagline, accent, API URL).
- **Theme** — `src/app/globals.css` (`@theme` tokens).
- **Auth** — swap the API-key gate in `src/lib/kortix.ts`'s `getToken` for your
  own (OAuth, session cookie, server-minted token — anything that returns a
  string).

Nothing else couples to Kortix. The SDK is the only backend dependency.
