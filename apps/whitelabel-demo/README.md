# Lumen — white-label reference app

A complete, production-shaped agent client built **100% on `@kortix/sdk`**. It
is the golden reference for using Kortix as your backend: projects, sessions,
and **real, token-by-token streaming agent chat** — with zero raw `fetch`, zero
`@opencode-ai/sdk` imports, and no transport code in the app itself (see
"Two modes" below for the one deliberate, documented exception).

Rebrand `src/config/brand.ts`, point `NEXT_PUBLIC_KORTIX_API_URL` at your Kortix
backend, and you have a white-label coding agent.

## Two modes: use Kortix as your backend, behind your own backend

Lumen runs in either of two modes, picked up from the server environment —
`GET /api/mode` — with no rebuild needed to switch:

- **Direct mode** (default, no server env required). The browser holds a pasted
  Kortix API key (`kortix_pat_…`) in `localStorage` and the SDK talks straight
  to `NEXT_PUBLIC_KORTIX_API_URL`. See "Auth" below.
- **Wrapper mode** — the headline capability this reference demonstrates:
  running Kortix *behind your own backend*. Set `KORTIX_API_KEY` on the server
  and Lumen flips into a BFF:
  - End users log in through Lumen's **own** demo auth (`/api/auth/*`) — signed
    HMAC session tokens (`src/server/auth.ts`), not a Kortix credential.
  - Every SDK call is re-pointed at the same-origin proxy `/api/kortix/[...path]`
    (`src/lib/kortix.ts#configureWrapperMode`), which injects the real
    `KORTIX_API_KEY` server-side — end users and their browsers never see it.
  - The proxy enforces **per-user project isolation** (`src/server/users.ts`) and
    an explicit allow/deny **route policy** (`src/server/policy.ts`, deny-by-default)
    before forwarding, plus a per-user **rate limiter** (`src/server/rate-limit.ts`).
  - Preview iframes can't go through that proxy — a Next.js route handler can't
    forward a WebSocket upgrade, and a live dev server's HMR socket needs one —
    so `/api/preview-token` mints a short-lived, **project-scoped** Kortix PAT
    for the iframe to use directly against the upstream.
  - `/usage` shows per-session LLM + compute cost pulled straight from the
    gateway, with a `COST_MARKUP` multiplier applied — the re-billing surface a
    real wrapper would charge its own users.
  - `.env.example` documents every variable for both modes.

See `AGENTS.md` for the one rule change this adds: `src/server/**` and
`src/app/api/**` are server-only transport code and are exempt from the
SDK-only rule, the same way raw `fetch` is correct *inside* `@kortix/sdk` itself.

## What it demonstrates

| Route | SDK surface |
| --- | --- |
| `/` | projects dashboard + create (`projects.list`, `projects.provision`) |
| `/account` | accounts + members + invites (`accounts.*`, `projects.listForAccount`) |
| `/projects/[id]` | new-session onboarding (`sessions.create`, `sandboxTemplates`, `onboardingComplete`) |
| `/projects/[id]/sessions/[sessionId]` | chat · Files · Changes · Preview tabs + session actions |
| `/projects/[id]/settings` | General · Capabilities · Secrets · Members · Connectors · Triggers · Policies |
| `/usage` | wrapper-mode only — per-session LLM + compute cost, marked up (`/api/usage`) |

### Facade coverage

This reference exercises **the core `@kortix/sdk` facade a chat-first product
needs** — every method listed below has a real UI surface (a deliberate goal
so nothing in this list is left undemonstrated). Newer platform-admin surfaces
— Review Center, Approvals, Gateway observability, Slack/email/Meet channels,
project apps/deployments — aren't part of this lightweight reference; they live
in `apps/web`:

- **accounts** (`/account`): `list/get/create/updateName/leave/members/invite/removeMember/updateMemberRole/invites`
- **projects**: `list/listForAccount/provision/get/detail/update/archive/llmCatalog/sandboxHealth/sandboxTemplates`
- **project(id)**: `onboardingComplete` · `secrets.{list,upsert,remove,setPersonal,removePersonal,setGitCredential}` · `access.{list,invite,update,revoke,requests,approveRequest,rejectRequest,pendingInvites,resendInvite,revokeInvite,groupGrants}` · `connectors.{list,config,create,remove,sync}` · `policies.{list,set}` · `triggers.{list,create,update,remove,fire,setActivation}` · `files.{list,read,search,history,archive}` · `git.{commits,commit,commitDiff,branches,versionDiff}` · `changeRequests.{list,get,diff,mergePreview,open,merge,close,reopen}`
- **session(pid,sid)**: `get/update/delete/start/restart/setSharing/previews/commit · publicShares.{list,create,revoke} · health/previewUrl/proxyUrl/setModel/send/abort/stream` (`stream` is the framework-free SSE facade for non-React hosts — a server-side wrapper, worker, or CLI; React hosts get the same events through `useSession`)
- **react** (`@kortix/sdk/react`): `useSession(projectId, sessionId)` — the one hook powering the workbench (start/switch/SSE/canonical id/messages/send/abort/questions/permissions/models/agents/picks), see "The chat runtime" below — plus `useProjectModels`/`useVisibleAgents`/`useProjectConfig`/`writeStartStash` (new-session onboarding, `/projects/[id]`) and `answerQuestion`/`answerPermission` (interactive-prompt replies, called directly by `question-prompt.tsx`/`permission-prompt.tsx`)

Every Kortix call goes through the one client created in `src/lib/kortix.ts`:

```ts
import { createKortix } from '@kortix/sdk';

export const kortix = createKortix({
  backendUrl: BRAND.apiUrl,            // e.g. https://api.kortix.com/v1
  getToken: async () => getApiKey(),   // your auth — here, a pasted API key
});
```

## Auth

The whole auth story is `getToken` — the SDK doesn't care where the token
comes from, only that `getToken()` returns one.

- **Direct mode.** Lumen stores a single Kortix **API key** (`kortix_pat_…`) in
  `localStorage` and hands it to the SDK. Create one in the Kortix dashboard
  under **Settings → API keys** (account-wide, or scoped to a single project).
  No Supabase, no sessions table, no cookies. See `src/components/api-key-gate.tsx`
  and `src/lib/kortix.ts`.
- **Wrapper mode.** `getToken` instead returns Lumen's own signed session token
  (`src/lib/session.ts`, minted by `POST /api/auth/login` — see `src/server/auth.ts`
  and `src/components/login-gate.tsx`). The Kortix API key never reaches the
  browser at all; it's read only by `src/app/api/**` route handlers.

## The chat runtime

Opening a session is the only non-trivial flow, and it's collapsed into **one
hook**: `useSession(projectId, sessionId)` from `@kortix/sdk/react`. The host
(`src/app/projects/[id]/sessions/[sessionId]/page.tsx`) calls it once, reads
`session.phase`, and renders — nothing sandbox-shaped leaks into the component:

```tsx
const session = useSession(projectId, sessionId);

return session.phase !== 'ready'
  ? <BootScreen stage={session.stage} reason={session.reason} onRetry={session.retry} />
  : <WorkbenchTabs session={session} projectId={projectId} sessionId={sessionId} />;
```

Internally the hook drives, in order: `/start` (server long-poll until
`stage === 'ready'`, returning the sandbox row + canonical
`opencode_session_id`) → pointing the SDK's active runtime at that sandbox →
the live SSE event stream → resolving the canonical OpenCode root session id →
message sync (`messages`/`status`/`diffs`/`todos`) → the interactive
questions/permissions store → server-side capabilities (`models`, `agents`,
`commands`) → per-session model/agent picks → the `send`/`cancel`/`runCommand`
mutations. The host never imports a sandbox switcher, a health poller, or an
event-stream provider — `useSession` is the whole contract. See
`packages/sdk/src/react/use-session.ts` for the implementation and
`src/components/workbench/workbench-tabs.tsx` for how the chat thread consumes
the result (`session.messages`, `session.send`, `session.isBusy`,
`session.questions`/`.permissions`, `session.runtimePhase` for reconnect UI).
The transcript itself scrolls via a plain `scrollRef` + `scrollTo` effect
(`workbench-tabs.tsx`) — there's no dedicated scroll-container primitive.

**Model selection** is server-side and pre-runtime, so it works before a
sandbox exists and shares one source of truth between the new-session screen
and the in-session picker: `useProjectModels(projectId)` reads the project's
gateway catalog (`GET /projects/:id/llm-catalog`) and flattens it to
`FlatModel[]`, sidestepping mixed gateway/BYOK key formats and per-family
"latest" resolution. `useSession` exposes this as `session.models` and the pick
as `session.picks.model` / `session.picks.setModel`; `ModelPicker` is a plain
controlled component over that. Omit a model on `send` and the agent uses its
configured default. See `src/components/chat/model-picker.tsx` and
`packages/sdk/src/react/use-project-models.ts`.

## Run it

```bash
pnpm install
NEXT_PUBLIC_KORTIX_API_URL=https://api.kortix.com/v1 \
  WHITELABEL_PORT=3010 pnpm --filter @kortix/whitelabel-demo dev
```

Point `NEXT_PUBLIC_KORTIX_API_URL` at a local stack (`http://localhost:8008/v1`)
to develop against it. Then open the app, paste an API key, and go — that's
direct mode.

To try **wrapper mode** instead, set the variables `.env.example` documents
under "Wrapper mode" (`KORTIX_API_KEY`, `KORTIX_UPSTREAM`, `SESSION_SECRET`, and
optionally `DEMO_PASSWORD`/`COST_MARKUP`/`RATE_LIMIT_PER_MIN`), restart the
server, and log in through the app's own demo login instead of pasting a key.

## Make it yours

- **Brand** — `src/config/brand.ts` (name, tagline, accent, API URL).
- **Theme** — `src/app/globals.css` (`@theme` tokens).
- **Auth** — in direct mode, swap the API-key gate in `src/lib/kortix.ts`'s
  `getToken` for your own (OAuth, session cookie, server-minted token —
  anything that returns a string). In wrapper mode, swap the demo credential
  check in `src/server/auth.ts#checkDemoCredentials` for your real user
  directory — the session-signing and BFF-proxy plumbing around it stays as-is.

Nothing else couples to Kortix. The SDK is the only backend dependency.
