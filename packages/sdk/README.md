# @kortix/sdk

The **single, opinionated data layer** for the Kortix agent platform. One typed
client wraps both the **Kortix REST API** and the **OpenCode v2 runtime** so a
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

## Quick start

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: 'https://api.kortix.ai/v1',
  getToken: () => supabase.auth.getSession().then(s => s.data.session?.access_token ?? null),
});

// Projects
const projects = await kortix.projects.list();
const detail   = await kortix.project(pid).detail();
await kortix.project(pid).secrets.upsert({ name: 'ANTHROPIC_API_KEY', value });

// Sessions (id-bound handle)
const s = kortix.session(pid, sid);
await s.send('Build me a widget');   // provisions/resumes if needed, then prompts
await s.previews();

// Lower level: the typed opencode client for THIS session's runtime.
// `.runtime` throws until the runtime is resolved, and the runtime is keyed by
// the OpenCode session id (NOT the Kortix `sid`) — resolve both via ensureReady.
const { opencodeSessionId } = await s.ensureReady();
await s.runtime.session.prompt({ sessionID: opencodeSessionId, parts });
```

## The facade surface

`createKortix(config)` returns one client. The table below is illustrative, not
exhaustive — see `API-MAP.md` for the full per-domain surface:

| namespace | what |
|---|---|
| `kortix.projects` | list · get · detail · create · provision · update · archive · llmCatalog · sandboxTemplates · sessions (+ more: `listForAccount`, `sandboxHealth`, `createSession`) |
| `kortix.accounts` | list · get · create · members · invites (+ more: `updateName`, `leave`, `invite`, `removeMember`, `updateMemberRole`) |
| `kortix.project(id)` | id-bound handle: `.secrets` · `.access` · `.connectors` · `.policies` · `.triggers` · `.files` · `.git` · `.changeRequests` · `.sessions` · `.session(sid)` (+ more namespaces: `.review`, `.approvals`, `.gateway`, `.channels`, `.apps`, `.modelDefaults`, `.sandbox`) |
| `kortix.session(pid, sid)` | id-bound handle: lifecycle (`get`/`update`/`delete`/`start`/`restart`/`stop`/`setSharing`/`previews`/`commit`/`publicShares`/`ensureReady`) · `send`/`abort`/`setModel`/`setAgent` (opinionated prompt wrappers, already shipped) · **its own runtime** (`health`/`previewUrl`/`proxyUrl` — sandbox resolved for you) + `.runtime` (the typed opencode client) |
| `kortix.runtime()` | the opencode v2 client for the active sandbox (escape hatch) |

> `session.stream()` (server-owned restart/refresh per the gateway resource API)
> is the one piece still pending the §11 server contract — `send()`/`abort()`
> above are already live. Until `stream()` lands, reactive data comes from the
> `@kortix/sdk/react` hooks.

## Subpath modules

Stable, tree-shakeable surfaces (also reachable via the facade). Not exhaustive
— see `package.json`'s `exports` field for the complete list (it also includes
`./config`, `./api-client`, `./feature-flags`, `./fresh-sessions`,
`./instance-routes`, `./opencode-errors`, `./platform-client`, `./event-stream`,
`./sandbox-connection-store`, `./opencode-pending-store`, `./session/url`,
`./turns`, `./idb-sync-cache`):

| import | provides |
|---|---|
| `@kortix/sdk` | `createKortix`, `configureKortix`, `files`, all file types |
| `@kortix/sdk/react` | every `useOpenCode*` hook + providers (reactive data) |
| `@kortix/sdk/files` | workspace file ops (daemon `/file` + `/find`): `listFiles`, `readFile`, `readBlob`, `getFileStatus`, `findFiles`, `findText`, `uploadFile`, `deleteFile`, `mkdir`, `renameFile`, … |
| `@kortix/sdk/session` | a session's runtime surface — `getSessionHealth`/`isRuntimeReady` + proxy/preview URL builders (`rewriteLocalhostUrl`, `proxyLocalhostUrl`, `detectLocalhostUrls`, …) + preview-auth helpers. **No "sandbox" in the public surface** — a session owns its runtime |
| `@kortix/sdk/opencode-client` | `getClient`, `getClientForUrl` + the **full opencode v2 type surface** (`Event`, `Part`, `Message`, `Session`, `Pty`, `Config`, …) |
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
React Native adoption of the full client/hooks is planned but not done — mobile
currently ships its own parallel data layer (`apps/mobile/lib/opencode/`) rather
than `@kortix/sdk/react`.

## Rules of the road

- **No `@opencode-ai/sdk` in host code.** Import opencode types/client from
  `@kortix/sdk/opencode-client`. The SDK is the sole owner of that dependency.
  (Holds today — no host imports it.)
- **No raw `backendApi` / `authenticatedFetch` in host code.** Use the facade or a
  subpath module. (Aspirational: apps/web still calls `backendApi` via its
  `@/lib/api-client` re-export in ~40 files and keeps a parallel
  `authenticatedFetch` in `apps/web/src/lib/auth-token.ts` — migration pending.)
- **React data** comes from `@kortix/sdk/react` hooks; **imperative actions** from
  the `createKortix` facade.

## Auth

`Authorization: Bearer <token>` — a Supabase JWT (user sessions) or a Kortix PAT
(`kortix_pat_…`) for server-side / automation use, supplied via `getToken`.

## Tests

```sh
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/sdk test   # facade, files, react hooks, turns, transcript, session url/health, projects-client domains
```

See **`API-MAP.md`** for the complete endpoint catalogue (REST + opencode runtime)
and per-domain SDK coverage status.
