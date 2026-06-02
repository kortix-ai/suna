# Managed Git: Kortix Git Proxy + Pluggable Backends

Status: **Proposed** · Owner: platform · Last updated: 2026-06-01

## 1. Why

Managed git currently runs on **Freestyle** (`apps/api/src/projects/freestyle-git.ts`). Freestyle's git API is flaky in production (live 502s from `git.freestyle.sh`, identity-token mint failures), and it's a single hardcoded provider with no abstraction. We want to:

1. **Stop depending on one third-party git host** — make the backend swappable, and let *multiple backends run at once* (different projects on different hosts).
2. **Never hand a real git-host credential to an untrusted client** (sandbox or the user's `kortix` CLI). The only secret a client holds is `KORTIX_TOKEN`.
3. **Keep the client contract stable forever** — origin is always Kortix, auth is always `KORTIX_TOKEN`. Swapping GitHub→Forgejo→Artifacts is a backend-only change with zero sandbox/CLI/web edits.

This is achieved with **two seams**:

- **Client-facing seam — the Kortix Git Proxy.** A git smart-HTTP reverse proxy on the API. Clients clone/push `https://<KORTIX_URL>/v1/git/<projectId>.git` with `KORTIX_TOKEN`; the API authenticates the token, resolves the project's backend, and streams the git protocol to the real upstream using a server-side credential.
- **Backend seam — the `GitHostBackend` registry.** A small interface (`createRepo`, `deleteRepo`, `resolveUpstream`, …) with one implementation per provider (GitHub managed org, Freestyle, Forgejo, Cloudflare Artifacts). The provider is stored per-project, so backends coexist.

```
 UNTRUSTED (holds only KORTIX_TOKEN)            TRUSTED (holds real host creds)
 ┌───────────────┐                            ┌──────────────────────────────┐
 │ sandbox daemon│  git over https            │  Kortix API                  │
 │  kortix CLI   │ ───────────────────────►   │  /v1/git/:projectId/*        │
 │ (human) git   │  Basic x-access-token:      │   ├─ authorizeGitProxy()     │
 └───────────────┘   KORTIX_TOKEN              │   ├─ getBackendForProject()  │
                                               │   └─ backend.resolveUpstream │──┐
                                               └──────────────────────────────┘  │
                                                          stream git smart-HTTP   ▼
                                            ┌──────────────────────────────────────────┐
                                            │ github.com/kortix-managed/<repo>.git       │
                                            │  OR git.freestyle.sh/<id>                  │
                                            │  OR forgejo.kortix.internal/<org>/<repo>   │
                                            │  OR <acct>.artifacts.cloudflare.net/git/…  │
                                            └──────────────────────────────────────────┘
```

## 2. Goals / Non-goals

**Goals**
- One stable, provider-agnostic client origin (`/v1/git/:projectId`), auth = `KORTIX_TOKEN`.
- A `GitHostBackend` interface + registry; ≥2 real backends (GitHub managed, Freestyle) shipped, Forgejo/Artifacts as drop-in proofs.
- Existing Freestyle projects migrate to the default backend (GitHub) without changing `repoUrl` semantics that clients see.
- Server-side git (mirror, session branches, CR merge) and the proxy both resolve upstream through the *same* backend seam.

**Non-goals (this spec)**
- Building/operating a Forgejo cluster (we define the backend; deployment is a follow-up).
- Changing the CR/merge model, session-branch model, or `kortix.toml`.
- A user-facing "invite me to the repo" UI (enabled by GitHub/Forgejo backends later; out of scope here).

## 3. Current state (grounded)

- **API server**: Hono on `Bun.serve` (`apps/api/src/index.ts:81`, export `:646`). Streaming proxy already proven in `apps/api/src/sandbox-proxy/routes/preview.ts` (`new Response(upstream.body, …)` `:331`, Bun `duplex:'half'` + `decompress:false` `:223`). Request bodies are currently *buffered* (`c.req.raw.clone().arrayBuffer()` `:423`) — the git proxy must stream `c.req.raw.body` instead.
- **Auth convergence**: every provider resolves to a token in `resolveProjectGitAuth()` (`apps/api/src/projects/index.ts:1033`), surfaced as `{username:'x-access-token', token, type:'basic'}` by `GET /v1/projects/:id/git/clone-credential` (`:3786`).
- **Data model**: `projectGitConnections` (provider, authMethod, repoUrl, repoOwner, repoName, externalRepoId, installationId, credentialRef, visibility, status, metadata) + `projectGitCredentials` (encrypted token) in `packages/db/src/schema/kortix.ts:274`.
- **Sandbox**: credential-helper flow in `apps/kortix-sandbox-agent-server/src/git.ts` — `resolveCloneToken()` (`:159`) GETs `clone-credential` with `Bearer KORTIX_TOKEN`; `runGitCredentialHelper` (`:334`) returns `username=x-access-token\npassword=<token>`; clones from `cfg.repoUrl` = `KORTIX_REPO_URL`.
- **CLI**: `ship.ts` mints a push token (`POST /:id/git-token` `:498`) and pushes with `http.extraHeader` basic auth (`:611`); managed detection at `:475`.
- **GitHub primitives already exist**: `createRepo` (org-aware: `/orgs/{org}/repos` vs `/user/repos`, `github.ts:310`), `createInstallationToken` (1h, `:252`), `commitFile`/`createBranchRef`/`getBranchCommitSha`, `parseGitHubRepoUrl`. **No provider abstraction exists** — all hardcoded branches.

## 4. The `GitHostBackend` interface

New module `apps/api/src/projects/git-backends/` with `types.ts`, `registry.ts`, and one file per provider.

```ts
// git-backends/types.ts
export type GitScope = 'read' | 'write';

/** Provider-neutral handle persisted in projectGitConnections. */
export interface GitConnectionRef {
  provider: string;          // 'github' | 'freestyle' | 'forgejo' | 'artifacts'
  externalRepoId: string | null;
  repoOwner: string | null;  // org/namespace
  repoName: string | null;
  installationId: string | null;
  credentialRef: string | null;
  upstreamUrl: string;       // real git URL on the host (NEVER sent to clients)
  defaultBranch: string;
  metadata: Record<string, unknown>;
}

/** What the proxy and server-side git both need to talk to the real host. */
export interface UpstreamGit {
  url: string;                         // e.g. https://github.com/kortix-managed/foo.git
  headers: Record<string, string>;     // e.g. { Authorization: 'Basic <b64 x-access-token:token>' }
}

export interface ProvisionInput {
  accountId: string;
  projectId: string;
  slug: string;              // repo name
  defaultBranch: string;
  isPrivate: boolean;
}

export interface ProvisionedRepo {
  ref: GitConnectionRef;     // persisted as the project's git connection
}

export interface GitHostBackend {
  readonly id: string;                 // provider key, matches projectGitConnections.provider
  isConfigured(): Promise<boolean>;

  /** Create an empty managed repo on this host. */
  createRepo(input: ProvisionInput): Promise<ProvisionedRepo>;

  /** Best-effort teardown (project delete / provision rollback). */
  deleteRepo(ref: GitConnectionRef): Promise<void>;

  /**
   * Resolve a real upstream git endpoint + short-lived auth headers, scoped
   * read|write. Used by BOTH the proxy (forwards client bytes) and server-side
   * git (mirror, session branch, CR). Implementations cache host tokens.
   */
  resolveUpstream(ref: GitConnectionRef, scope: GitScope): Promise<UpstreamGit>;

  /** Optional, host-native fast paths (else the generic git-over-http path is used). */
  seedFiles?(ref: GitConnectionRef, files: Array<{ path: string; content: string }>, opts: { branch: string; message: string }): Promise<void>;
  inviteCollaborator?(ref: GitConnectionRef, externalUserId: string, scope: GitScope): Promise<void>;
}
```

```ts
// git-backends/registry.ts
const backends = new Map<string, GitHostBackend>([
  ['github',   githubBackend],
  ['freestyle', freestyleBackend],
  // ['forgejo', forgejoBackend],   // drop-in later
  // ['artifacts', artifactsBackend],
]);

export function getBackend(provider: string): GitHostBackend {
  const b = backends.get(provider);
  if (!b) throw new Error(`No git backend for provider "${provider}"`);
  return b;
}

/** Backend that NEW managed projects are provisioned on. */
export function getDefaultManagedBackend(): GitHostBackend {
  return getBackend(config.MANAGED_GIT_PROVIDER || 'github');
}
```

`resolveProjectGitAuth()` is **refactored to delegate**: build a `GitConnectionRef` from `getProjectGitRemote()` + connection, then `getBackend(ref.provider).resolveUpstream(ref, scope)`. The existing per-provider branches move into the backends. The clone-credential endpoint and `git.ts` callers consume `UpstreamGit` instead of a bare token.

## 5. The proxy

New module `apps/api/src/git-proxy/` mounted in `index.ts`.

### Routes (git smart-HTTP)
Git appends fixed suffixes to the remote, so the remote `https://<KORTIX_URL>/v1/git/<projectId>.git` yields:

| Route | Method | git phase | Scope |
|---|---|---|---|
| `/v1/git/:project/info/refs?service=git-upload-pack` | GET | clone/fetch discovery | read |
| `/v1/git/:project/info/refs?service=git-receive-pack` | GET | push discovery | write |
| `/v1/git/:project/git-upload-pack` | POST | clone/fetch data | read |
| `/v1/git/:project/git-receive-pack` | POST | push data | write |

`:project` tolerates an optional trailing `.git`. Scope is derived from `?service=` (GET) or the path suffix (POST): `git-receive-pack` ⇒ **write**, `git-upload-pack` ⇒ **read**.

### Auth — `authorizeGitProxy(c, projectId, scope)`
Accept either `Authorization: Basic base64(x-access-token:TOKEN)` (what the sandbox credential helper + CLI already emit) or `Authorization: Bearer TOKEN`. Extract `TOKEN`, then unify the existing token types:
- **sandbox API key** (type `sandbox`) → must be scoped to a `session_sandboxes` row for `projectId` and `active|provisioning`; grants read+write (same gate as `clone-credential` `:3815`).
- **project-scoped PAT** (`authType==='pat'`, `tokenProjectId===projectId`) → read; write requires the token's role to satisfy project write (reuse `loadProjectForUser(c, id, 'write')`).
- **user PAT / CLI token** → resolve account, `loadProjectForUser(c, id, scope==='write'?'write':'read')`.

On 401, return git's expected `WWW-Authenticate: Basic realm="Kortix Git"` so git prompts/uses the helper. Reject browser/Supabase-JWT principals (same posture as clone-credential).

### Forwarding (streaming, no buffering)
```ts
const ref  = await getConnectionRef(projectId);          // from projectGitConnections
const up   = await getBackend(ref.provider).resolveUpstream(ref, scope);
const target = `${up.url.replace(/\.git$/, '')}${gitSuffix}${c.req.url.includes('?') ? '?' + qs : ''}`;

const upstream = await fetch(target, {
  method: c.req.method,
  headers: {
    ...passThrough(c.req.raw.headers, ['content-type','accept','accept-encoding','content-encoding','git-protocol','user-agent']),
    ...up.headers,                                        // server-side credential
  },
  body: c.req.method === 'GET' ? undefined : c.req.raw.body,  // STREAM (ReadableStream)
  // @ts-ignore Bun extensions
  duplex: 'half', decompress: false, redirect: 'manual',
});

return new Response(upstream.body, {
  status: upstream.status,
  headers: stripHopByHop(upstream.headers),              // keep content-type, content-encoding
});
```
Notes: must forward the `Git-Protocol: version=2` header (protocol v2), keep gzip bodies opaque (`decompress:false`), no `maxBuffer`, generous/none timeout for `git-receive-pack`. Hop-by-hop headers (`transfer-encoding`, `connection`, …) stripped.

## 6. The `repoUrl` / origin model

**Decision: the proxy is the UNIVERSAL client-facing origin for every git-backed project — managed *and* BYO (GitHub App, PAT, Freestyle, anything). The real upstream lives only in the connection and is resolved server-side. A real host credential NEVER reaches a runtime client, even for a user's own repo.**

| Field | Value (every git-backed project, managed or BYO) | Consumed by |
|---|---|---|
| `projects.repoUrl` | `https://<KORTIX_URL>/v1/git/<projectId>.git` (proxy) | runtime clients (sandbox `KORTIX_REPO_URL`, CLI-in-sandbox, web) |
| `projectGitConnections.upstreamUrl` (**new column**) | real host URL — `github.com/kortix-managed/<slug>.git` (managed) **or** `github.com/<user>/<repo>.git` (BYO) **or** `git.freestyle.sh/<id>` | server-side git + proxy only |
| `projectGitConnections.{provider,repoOwner,repoName,externalRepoId,installationId,credentialRef}` | real host coordinates | backend `resolveUpstream` |

Consequences:
- **The agent runtime only ever knows Kortix.** No real GitHub/Freestyle/Forgejo token is ever injected into a sandbox — for managed repos *or* for a user's own connected repo. The backend mints the real upstream credential (managed installation token, the user's own App installation token, or their PAT) inside the API at proxy time.
- **Provider migration & BYO are identical to the client.** `repoUrl` (proxy) is stable; only `upstreamUrl`+coordinates differ. Connecting your own repo, swapping GitHub→Forgejo, and provisioning a managed repo all look the same downstream.
- **Trusted vs untrusted split.** The API (trusted) talks to `upstreamUrl` directly — it does **not** loop back through its own proxy. Untrusted clients only ever see the proxy URL + `KORTIX_TOKEN`.
- **Sandbox**: inject `KORTIX_REPO_URL = repoUrl` (proxy). The credential helper returns `KORTIX_TOKEN` as the password (no per-op token mint; the proxy resolves the real cred). `deriveAuthHost(repoUrl)` now yields the Kortix host — correct.
- **CLI `ship`**: origin = proxy URL; push with `KORTIX_TOKEN` via `http.extraHeader`; `/git-token` mint is dropped. This holds for BYO too — `ship` no longer needs the user's own git creds to push *through Kortix*; the backend authenticates upstream.
- **Scope still differentiates managed vs BYO** for *authorization* (who may write), and `connection.managed` still drives *provisioning* (whether Kortix creates the repo) — but **not** routing. Routing is universal.
- **Out of scope:** a human operating their *own local checkout* of a BYO repo on their laptop keeps whatever remotes they already have (their machine, their repo, their creds). The universal proxy governs Kortix-runtime git, not a developer's personal clone.

## 7. Data model changes

`projectGitConnections` (migration, additive):
- add `upstreamUrl text` — real host git URL (null for legacy until backfilled).
- add `managed boolean default false` — true for Kortix-provisioned repos (drives proxy-origin + provisioning).
- `provider` gains values `'forgejo'`, `'artifacts'` (varchar already permits).
- `metadata` jsonb carries per-backend extras (e.g. Artifacts namespace, Forgejo org).

`getProjectGitRemote()` extends `ProjectGitRemote` with `upstreamUrl` + `managed`. Legacy fallback: a freestyle `metadata.freestyle` project ⇒ `provider:'freestyle', managed:true, upstreamUrl = https://git.freestyle.sh/<repo_id>`.

## 8. Config / env

`apps/api/src/config.ts` (follow `optStr`/`optUrl` pattern, see `:96`):
```
MANAGED_GIT_PROVIDER          optStr            # 'github' (default) | 'freestyle' | 'forgejo' | 'artifacts'
# GitHub managed backend
MANAGED_GIT_GITHUB_OWNER      optStr            # org that holds managed repos, e.g. 'kortix-managed'
MANAGED_GIT_GITHUB_INSTALL_ID optStr            # the Kortix App installation id on that org
# (reuses existing KORTIX_GITHUB_APP_ID / _PRIVATE_KEY / _SLUG)
# Freestyle backend (existing): FREESTYLE_API_KEY / FREESTYLE_API_URL
# Forgejo backend (later)
FORGEJO_BASE_URL              optUrl('')
FORGEJO_ADMIN_TOKEN           optStr
FORGEJO_ORG                   optStr
# Artifacts backend (later)
ARTIFACTS_ACCOUNT_ID          optStr
ARTIFACTS_API_TOKEN           optStr
ARTIFACTS_NAMESPACE           optStr
```
Each backend's `isConfigured()` checks its own env, so unconfigured backends are inert.

## 9. Provisioning refactor

`POST /v1/projects/provision` (`index.ts:2652`) — replace direct Freestyle calls:
```ts
const backend = getDefaultManagedBackend();
if (!(await backend.isConfigured())) return c.json({ error: 'Managed git not configured' }, 503);
const { ref } = await backend.createRepo({ accountId, projectId, slug, defaultBranch, isPrivate: true });
const proxyUrl = `${config.KORTIX_URL}/v1/git/${projectId}.git`;
await upsertProjectGitConnection({ /* provider: ref.provider, managed:true, upstreamUrl: ref.upstreamUrl, repoUrl: proxyUrl, repoOwner, repoName, externalRepoId, installationId, credentialRef, defaultBranch, authMethod: backend-native */ });
// projects.repoUrl = proxyUrl; metadata.git.provider = ref.provider; metadata.git.managed = true
if (body.seed_starter) {
  await backend.seedFiles?.(ref, starterFiles, { branch: defaultBranch, message: 'chore: scaffold Kortix project' })
    ?? serverSideGitSeed(ref, starterFiles);     // generic fallback: local git push to upstreamUrl via resolveUpstream
}
```
`POST /:id/git-token` is no longer needed for clients (they auth with `KORTIX_TOKEN`); keep it returning `{ origin_url: proxyUrl }` for back-compat or delete after CLI ships.

## 10. Server-side git unification

`apps/api/src/projects/git.ts` `runGit` callers (mirror refresh, `createRemoteSessionBranch`, `deleteRemoteSessionBranch`, CR `commitFileToBranch`) switch from `(project.repoUrl, token, authHost)` to:
```ts
const up = await getBackend(ref.provider).resolveUpstream(ref, scope);
await runGitWithUpstream(args, cwd, up);   // injects up.headers via GIT_CONFIG_* against up.url's host
```
This deletes the GitHub-vs-Freestyle conditionals in those paths. (GitHub's CR path may keep using the Contents API `commitFile` as a fast path — backend decides.)

## 11. Backend implementations

### 11.1 GitHub (default managed)
- **createRepo**: `createRepo({ name: slug, owner: MANAGED_GIT_GITHUB_OWNER, isPrivate:true, autoInit:false, auth: installationAuth })` → `/orgs/{org}/repos`. Store `repoOwner=org, repoName=slug, externalRepoId=repo.id, installationId=MANAGED_GIT_GITHUB_INSTALL_ID, upstreamUrl=repo.clone_url`.
- **resolveUpstream**: `createInstallationToken(installationId)` (cache ~50m), `headers = { Authorization: 'Basic ' + b64('x-access-token:'+token) }`, `url = upstreamUrl`. Scope is advisory (installation perms already bound); push allowed iff `managed || project write`.
- **seedFiles**: prefer Contents API (`commitFile`) or generic git push.
- **deleteRepo**: `DELETE /repos/{org}/{repo}`.
- **inviteCollaborator** (later): `PUT /repos/{org}/{repo}/collaborators/{login}`.
- One-time setup: create `kortix-managed` org, install the existing Kortix App on it with **Administration: write** + **Contents: write**; set `MANAGED_GIT_GITHUB_OWNER`/`_INSTALL_ID`. Ceiling: 100k repos/org → shard orgs past that (registry can pick org by hash).

### 11.2 Freestyle (wrap existing, keep working)
- Move `freestyle-git.ts` calls behind the interface: `createRepo`→`createManagedRepo`+`mintRepoPushToken` (identity), `resolveUpstream`→`mintRepoPushToken`→`{url:git.freestyle.sh/<id>, headers:Basic x-access-token:<token>}`, `deleteRepo`→`deleteManagedRepo`, `seedFiles`→`seedRepoWithFiles`. Existing projects keep working when Freestyle is up; new projects default to GitHub.

### 11.3 Forgejo (drop-in proof, optional)
- `createRepo`: `POST {FORGEJO_BASE_URL}/api/v1/orgs/{FORGEJO_ORG}/repos` with admin token → repo; `upstreamUrl = {base}/{org}/{slug}.git`.
- `resolveUpstream`: mint a repo-scoped token (`POST /api/v1/users/{user}/tokens` or per-repo token) or use the admin token directly; `headers = Basic <user>:<token>`. (Forgejo accepts token in the password slot.)
- Deployment is a follow-up (single Go binary + Postgres on the existing AWS VPS footprint; see capacity notes in the design discussion — one instance hosts tens of thousands of small repos).

### 11.4 Cloudflare Artifacts (stub, when beta access lands)
- `createRepo`: `POST /accounts/{acct}/artifacts/namespaces/{ns}/repos` → `{remote, token}`; `upstreamUrl = remote`.
- `resolveUpstream`: `POST /…/tokens {repo, scope, ttl}` → `headers = { Authorization: 'Bearer '+plaintext }` (Artifacts uses Bearer, not x-access-token). No identities/collaborators.

## 12. Migration: Freestyle → GitHub

Admin/maintenance job (idempotent, opportunistic — Freestyle is flaky):
1. Select managed `provider='freestyle'` connections.
2. For each: `githubBackend.createRepo({slug})` under the managed org.
3. **Content move**: server-side `git clone --mirror` the Freestyle upstream (via freestyle `resolveUpstream`) → `git push --mirror` to the GitHub upstream. If the Freestyle source is unreachable (502) → fall back to seeding the starter (log it; content for those is reproducible from the starter, otherwise flagged for manual recovery).
4. Update the connection: `provider='github', upstreamUrl=<gh>, repoOwner/repoName/externalRepoId/installationId`, `managed=true`. **`repoUrl` (proxy) is unchanged** → live sessions/CLI keep working across the swap.
5. Leave the Freestyle repo intact for a grace window, then `freestyleBackend.deleteRepo`.

Because clients only ever see the proxy URL, migration is invisible to them. Run in batches; `--dry-run` first; emit a report of moved/seeded/failed.

## 13. Phasing

- **M1 — Proxy + backend seam (no behavior change).** Add `GitHostBackend`/registry; wrap Freestyle + GitHub behind it; refactor `resolveProjectGitAuth` + `git.ts` to consume `resolveUpstream`. Add the proxy routes. Add `upstreamUrl`/`managed` columns. New managed projects still default to Freestyle. Ship dark.
- **M2 — Flip default to GitHub + universal proxy origin.** Set `MANAGED_GIT_PROVIDER=github`, stand up `kortix-managed` org + App install. New projects provision on GitHub; **every git-backed project (managed AND BYO) gets `repoUrl` = proxy**, sandbox `KORTIX_REPO_URL` = proxy, CLI origin = proxy. Backfill `upstreamUrl` for existing BYO connections so they route through the proxy too. e2e a full create→boot→edit→CR→ship loop for both a managed and a BYO (App + PAT) project.
- **M3 — Migrate existing Freestyle projects** (batched), then retire the Freestyle default. Keep the backend for any stragglers.
- **M4 — Prove pluggability.** Land the Forgejo backend behind a flag and point a test project at it (zero client change). Artifacts stub when beta access arrives.

## 14. Testing

- **Unit**: backend registry resolution; `resolveUpstream` per backend (mock host APIs); scope derivation; proxy auth matrix (sandbox/PAT/user/anon × read/write).
- **Proxy integration**: real `git clone`/`git push` against a local API instance pointed at a throwaway GitHub managed repo — assert streaming (large pack), protocol v2, gzip, push gated by write scope. New harness `apps/api/scripts/e2e-git-proxy.sh`.
- **End-to-end**: create project (GitHub backend) → boot session (clone via proxy with `KORTIX_TOKEN`) → edit → session branch on real upstream → CR merge → `kortix ship`. Extend existing provision e2e (`__tests__/e2e-projects-provision.test.ts`).
- **Migration**: dry-run report correctness; content-equality after mirror push; unreachable-source fallback.

## 15. Risks / open questions

- **Bandwidth through the API.** All managed git transits Kortix. Mitigate: stream (never buffer), blobless clones already in use, keep the API instance adequately sized; consider a future edge/CDN for read packs.
- **Installation-token caching correctness.** Cache per-installation ~50m; refresh lazily; never persist. A stale token must hard-refresh on 401 from upstream.
- **Write authorization for the human CLI.** `ship` currently uses a user PAT; the proxy must map that to project write. Confirm role mapping (`loadProjectForUser(...,'write')`).
- **BYO via proxy = decided YES (universal).** Every git-backed project routes through the proxy; this adds one hop for user-owned repos but guarantees no real token ever lands in a sandbox. The cost is the bandwidth/latency note above; acceptable.
- **GitHub org ceiling (100k repos)** and secondary write limits on burst provisioning → shard orgs by hash; backoff on repo-create.
- **Freestyle reachability during migration** — some content may be unrecoverable while Freestyle 502s; fallback = re-seed + flag.
- **Server-side must not proxy itself** — ensure `git.ts` uses `upstreamUrl`, not `repoUrl`, to avoid an API→API loop.

## 16. File-by-file change list (impl checklist)

- `apps/api/src/projects/git-backends/{types,registry,github,freestyle}.ts` — new.
- `apps/api/src/git-proxy/{routes,auth,forward}.ts` — new; mount in `index.ts`.
- `apps/api/src/projects/index.ts` — refactor `resolveProjectGitAuth` to delegate; `getProjectGitRemote` adds `upstreamUrl`/`managed`; `provision` uses `getDefaultManagedBackend`; `clone-credential` consumes `resolveUpstream`; deprecate `git-token`.
- `apps/api/src/projects/git.ts` — `runGitWithUpstream`; callers use `resolveUpstream`.
- `apps/api/src/projects/freestyle-git.ts` — kept, now called only by the Freestyle backend.
- `packages/db/src/schema/kortix.ts` + migration — `upstreamUrl`, `managed`.
- `apps/api/src/config.ts` — `MANAGED_GIT_*`, backend env.
- `apps/kortix-sandbox-agent-server/src/git.ts` — credential helper returns `KORTIX_TOKEN`; `KORTIX_REPO_URL` = proxy URL (set by API at sandbox create).
- `apps/cli/src/commands/ship.ts` — managed detection via connection; origin = proxy; push with `KORTIX_TOKEN`; drop `/git-token`.
- Tests + e2e harnesses as in §14.
