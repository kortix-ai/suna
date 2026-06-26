# @kortix/sdk

The **single, opinionated data layer** for the Kortix agent platform. One typed
client wraps both the **Kortix REST API** and the **OpenCode v2 runtime** so a
host app — web, mobile, reference — imports **only `@kortix/sdk`** and never the
raw API, `authenticatedFetch`, or `@opencode-ai/sdk` directly.

> Philosophy: **one Kortix token, one client, every action a method.** Keys never
> leave the server; mutations own their side-effects there; the host states intent.

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
await s.start();
await s.previews();
s.runtime.session.prompt({ sessionID: sid, parts });   // typed opencode, via the SDK
```

## The facade surface

`createKortix(config)` returns one client:

| namespace | what |
|---|---|
| `kortix.projects` | list · get · detail · create · provision · update · archive · llmCatalog · sandboxes · sessions |
| `kortix.accounts` | list · get · create · members · invites |
| `kortix.project(id)` | id-bound handle: `.secrets` · `.access` · `.connectors` · `.policies` · `.triggers` · `.files` · `.git` · `.changeRequests` · `.sessions` · `.session(sid)` |
| `kortix.session(pid, sid)` | id-bound handle: lifecycle (`get`/`update`/`delete`/`start`/`restart`/`setSharing`/`previews`/`commit`/`publicShares`) + `.runtime` (the typed opencode client) |
| `kortix.runtime()` | the opencode v2 client for the active sandbox (escape hatch) |

> Higher-level ergonomic methods (`session.send()` / `session.stream()` with
> server-owned restart/refresh per the gateway resource API) layer on top of this
> as the §11 server contract lands. Until then, reactive data comes from the
> `@kortix/sdk/react` hooks.

## Subpath modules

Stable, tree-shakeable surfaces (also reachable via the facade):

| import | provides |
|---|---|
| `@kortix/sdk` | `createKortix`, `configureKortix`, `files`, all file types |
| `@kortix/sdk/react` | every `useOpenCode*` hook + providers (reactive data) |
| `@kortix/sdk/files` | workspace file ops (daemon `/file` + `/find`): `listFiles`, `readFile`, `readBlob`, `getFileStatus`, `findFiles`, `findText`, `uploadFile`, `deleteFile`, `mkdir`, `renameFile`, … |
| `@kortix/sdk/opencode-client` | `getClient`, `getClientForUrl` + the **full opencode v2 type surface** (`Event`, `Part`, `Message`, `Session`, `Pty`, `Config`, …) |
| `@kortix/sdk/projects-client` | the raw REST functions (the facade wraps these) |
| `@kortix/sdk/auth` | `authenticatedFetch`, token accessors |
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
}
```

The SDK is host-agnostic: no Next.js / web coupling in the core. The host injects
its token getter and toast/notify sinks; the SDK does the rest. Works in React DOM
and React Native (fetch-based; the few DOM helpers stay in the host).

## Rules of the road

- **No `@opencode-ai/sdk` in host code.** Import opencode types/client from
  `@kortix/sdk/opencode-client`. The SDK is the sole owner of that dependency.
- **No raw `backendApi` / `authenticatedFetch` in host code.** Use the facade or a
  subpath module.
- **React data** comes from `@kortix/sdk/react` hooks; **imperative actions** from
  the `createKortix` facade.

## Auth

`Authorization: Bearer <token>` — a Supabase JWT (user sessions) or a Kortix PAT
(`kortix_pat_…`) for server-side / automation use, supplied via `getToken`.

## Tests

```sh
pnpm --filter @kortix/sdk typecheck   # 0 errors
pnpm --filter @kortix/sdk test        # facade + files routing tests
```

See **`API-MAP.md`** for the complete endpoint catalogue (REST + opencode runtime)
and per-domain SDK coverage status.
