# code.storage (Pierre) managed git backend — spec

Status: **proposed** · Owner: marko · Date: 2026-06-15

Add **code.storage** (by [Pierre](https://pierre.co), package `@pierre/storage`) as a
`GitHostBackend` so Kortix-provisioned ("managed") repos live on code.storage instead of
the `managed-kortix` GitHub org. This is a drop-in alongside the existing `github` backend —
the registry, proxy, sandbox, CLI, and DB schema are already provider-agnostic.

---

## 1. What code.storage is (investigation summary)

A **managed git infrastructure layer**: real git repos with standard semantics, exposed via
an HTTP API + SDKs (TS `@pierre/storage`, Python, Go) **and** smart-HTTP git transport over
HTTPS. It's built for exactly our use case — programmatic repo creation and agent/sandbox
workflows — and the docs ship first-class **Daytona / E2B / Modal sandbox** examples.

Key properties that matter to us:

- **Repos**: created via API/SDK with a custom id that may be namespaced with `/`
  (e.g. `kortix/<projectId>`). `createRepo({ id })` → `{ repo_id, http_url }`.
- **Auth = customer-signed JWT.** *We* hold the private key; code.storage verifies with the
  public key we register in the Pierre Admin Panel. Algorithm **ES256** (our key is EC P-256)
  or RS256. No OAuth, no installation tokens, no per-request network round-trip to mint creds.
  - JWT claims: `iss` (org), `sub` (agent identity, for audit), `repo` (target repo; omitted
    only for `org:read`), `scopes` (array), `iat`, `exp` (TTL, default 1y, set short for us).
  - Scopes: `git:read` (clone/fetch/pull), `git:write` (push, includes read),
    `repo:write` (create repos), `org:read` (list repos, org-wide).
- **Git transport**: `https://t:<JWT>@<org>.code.storage/<repoId>.git` — basic auth, username
  literal `t`, password = the signed JWT. Standard `git clone/fetch/push`.
- **HTTP API base**: `https://api.<org>.code.storage/api`, `Authorization: Bearer <JWT>`,
  cursor pagination, error `{ "error": "..." }` (branch on status, not message). `409` =
  "repository sync in progress, retry shortly" during initial sync.
- **Ephemeral branches**: first-class temporary namespace + `getEphemeralRemoteURL()` +
  `promoteEphemeralBranch({ baseBranch, targetBranch })`. **This maps 1:1 onto Kortix
  sessions** (a session = an ephemeral branch promoted into a change-request branch).
- **Forking**: `createRepo({ baseRepo: { id, ref?|sha?, operation: 'fork' } })` — independent
  copy at a point in time. Useful for warm-snapshot / template provisioning.
- **GitHub integration (optional)**: code.storage can *sync bidirectionally* with a GitHub
  repo via a GitHub App you configure in its dashboard (App ID + private key + webhook secret —
  the "Integrations" screen). `createRepo({ baseRepo: { provider:'github', owner, name,
  operation:'sync' } })` + `pullUpstream()`. GitHub stays authoritative; pushes to code.storage
  are proxied through to GitHub. **This is how we keep a github.com/managed-kortix mirror if we
  want one — but it is optional and a later phase, not required.**
- **Imports**: migrate an existing repo (history + tags) by pushing to a `<repoId>+import.git`
  remote (`getImportRemoteURL()`), then it's cold-archived to S3.
- **Webhooks**: `push`, `repo.sync.{started,succeeded,failed}`. HMAC-SHA256 over
  `timestamp + "." + payload`, header `X-Pierre-Signature: t=<ts>,sha256=<sig>`,
  `X-Pierre-Event: <type>`. SDK `validateWebhook()`.
- **MCP / docs**: `claude mcp add --transport http code-storage https://code.storage/docs/mcp`
  (docs search only — not an action surface).

Full doc index: `https://code.storage/docs/llms.txt`.

---

## 2. Architecture decision

**Recommended: Model A — code.storage *is* the managed host.** New managed repos are created on
code.storage; sandboxes clone/push code.storage; GitHub `managed-kortix` is no longer in the
provisioning path. Optional Model-B GitHub mirroring (code.storage→GitHub sync) is a later,
additive phase that does not change the core integration.

Why A:

- **Clean fit.** The whole point of the `GitHostBackend` interface + Kortix git proxy is
  provider independence. code.storage slots in with **zero changes** to the proxy, sandbox
  daemon, sessions, CLI, or DB schema.
- **Removes the recent failure mode.** Managed GitHub provisioning has bitten us twice (502s
  from quoted private keys / installation-token + org-PAT capability gaps — see
  `project_provision_502_managed_git`). code.storage `buildUpstream` **self-signs a JWT
  locally** — no network call, no installation/PAT dance, no external token store.
- **Ephemeral branches = sessions.** code.storage's ephemeral-branch + promote model is exactly
  Kortix's session→change-request model. Strong long-term lever.
- **Forking** is first-class → cheaper warm-snapshot / templated project provisioning.

Trade-offs / risks to accept:

- New external dependency on code.storage availability for provisioning + git transport. The
  proxy already centralizes this, so failures are observable in one place.
- `409 sync in progress` on first create — needs retry/poll (only relevant if we use Model-B
  GitHub-backed repos; pure code.storage repos create immediately).
- Public-key registration is a **manual, out-of-band step** in the Pierre Admin Panel.

---

## 3. Integration design

### 3.1 New file: `apps/api/src/projects/git-backends/code-storage.ts`

Implements `GitHostBackend` (`id: 'codestorage'`). Self-contained: a tiny ES256 JWT signer +
raw `fetch` HTTP client, matching house style (the GitHub backend hand-rolls RS256 + `ghFetch`,
no Octokit). No `@pierre/storage` dependency required (see §3.6 for the SDK alternative).

```ts
// env helpers
function csOrg(): string | null            // MANAGED_GIT_CODESTORAGE_ORG  (e.g. "kortix")
function csPrivateKey(): string | null     // MANAGED_GIT_CODESTORAGE_PRIVATE_KEY (PEM, EC P-256)
function csApiBase(): string               // MANAGED_GIT_CODESTORAGE_API_URL ?? `https://api.${org}.code.storage`
function csGitHost(): string               // MANAGED_GIT_CODESTORAGE_GIT_HOST ?? `${org}.code.storage`

// ES256 JWT — NOTE the dsaEncoding gotcha (§3.3)
function signCsJwt(claims: { sub?: string; repo?: string; scopes: string[]; ttlSec: number }): string

const codeStorageBackend: GitHostBackend = {
  id: 'codestorage',

  async isConfigured() { return Boolean(csOrg() && csPrivateKey()); },

  // POST {apiBase}/repos  Bearer <org JWT scopes:['repo:write']>
  // body: { id: `kortix/${input.projectId}`, default_branch: input.defaultBranch }
  // → { repo_id, http_url }
  async createRepo(input) {
    const repoId = `kortix/${input.projectId}`;
    const res = await csFetch('/repos', { method:'POST', body:{ id: repoId, default_branch: input.defaultBranch } },
                              signCsJwt({ scopes:['repo:write'], ttlSec: 120 }));
    return {
      provider: 'codestorage',
      upstreamUrl: `https://${csGitHost()}/${repoId}.git`,   // canonical https git url (no creds)
      externalRepoId: res.repo_id,
      repoOwner: csOrg(), repoName: repoId,
      installationId: null, credentialRef: null,
      defaultBranch: input.defaultBranch, initialToken: null,
    };
  },

  // DELETE {apiBase}/repos/{repoId}
  async deleteRepo(ref) { /* signCsJwt repo-scoped repo:write, DELETE */ },

  // The seam the proxy consumes. SELF-SIGNS a short-TTL repo+scope JWT and returns
  // basic-auth headers. `token` arg is ignored (resolveProjectGitAuth returns 'none' for us).
  buildUpstream(ref, _token, scope) {
    const jwt = signCsJwt({
      repo: ref.repoName ?? repoIdFromUrl(ref.upstreamUrl),
      scopes: scope === 'write' ? ['git:read','git:write'] : ['git:read'],
      ttlSec: 300,
    });
    const basic = Buffer.from(`t:${jwt}`).toString('base64');
    return { url: ref.upstreamUrl, headers: { Authorization: `Basic ${basic}` } };
  },

  // Reuse seedRepoViaGitPush (it just does an https git push with header auth) —
  // pass it a self-signed write JWT instead of a GitHub token.
  async seedFiles(ref, _token, files, opts) {
    const jwt = signCsJwt({ repo: ref.repoName, scopes:['git:read','git:write'], ttlSec: 300 });
    await seedRepoViaGitPush({ upstreamUrl: ref.upstreamUrl, token: jwt, /* username 't' */ ... });
  },

  // authedPushUrl: `https://t:${jwt}@${gitHost}/${repoId}.git`  (for legacy/external push)
  // inviteCollaborator: N/A for code.storage (no per-user github accounts) — omit.
};
```

### 3.2 Register it — `registry.ts`

```ts
import { codeStorageBackend } from './code-storage';
const backends = new Map<string, GitHostBackend>([
  [githubBackend.id, githubBackend],
  [codeStorageBackend.id, codeStorageBackend],   // <-- add
]);
```

Set `MANAGED_GIT_PROVIDER=codestorage` to make NEW projects provision on code.storage.
Existing GitHub-managed projects keep resolving through the `github` backend because
`provider` is stored per-row in `project_git_connections` — **both run simultaneously**.

### 3.3 The ES256 JWT gotcha (must-fix footgun)

Node's `crypto.sign` for EC keys emits a **DER-encoded** signature, but JOSE/ES256 requires the
**raw `R||S`** form (64 bytes). Use `dsaEncoding: 'ieee-p1363'`:

```ts
const sig = crypto.sign('sha256', Buffer.from(`${b64(header)}.${b64(payload)}`),
                        { key: privateKey, dsaEncoding: 'ieee-p1363' });
// header: { alg: 'ES256', typ: 'JWT' }   payload: { iss: org, sub, repo, scopes, iat, exp }
```

Alternatively depend on `jose` (`new SignJWT(...).setProtectedHeader({alg:'ES256'}).sign(key)`),
which handles this correctly — preferred if we don't want to hand-roll. (Check whether `jose`
is already in the api workspace before adding.)

### 3.4 Config / env — `apps/api/src/config.ts`

Add to the env schema (~line 108) and the export (~line 485), mirroring the `MANAGED_GIT_GITHUB_*` block:

| Var | Meaning | Example |
|---|---|---|
| `MANAGED_GIT_PROVIDER` | switch default managed backend | `codestorage` |
| `MANAGED_GIT_CODESTORAGE_ORG` | code.storage org slug (the `iss` + subdomain) | `kortix` |
| `MANAGED_GIT_CODESTORAGE_PRIVATE_KEY` | EC P-256 PEM, signs JWTs | *(stored, encrypted)* |
| `MANAGED_GIT_CODESTORAGE_API_URL` | optional API base override | `https://api.kortix.code.storage` |
| `MANAGED_GIT_CODESTORAGE_GIT_HOST` | optional git host override | `kortix.code.storage` |

**Already done:** `MANAGED_GIT_CODESTORAGE_PRIVATE_KEY` is stored (dotenvx-encrypted) in
`apps/api/.env` and `.env.dev`. Prod = AWS Secrets Manager (not yet set). The registered
**public key** is in §6.

### 3.5 No changes needed in proxy / sandbox / sessions / DB

Verified read-through of the live code:

- **Proxy** (`git-proxy/index.ts`) calls `resolveProjectUpstream` → `getBackend(ref.provider)`
  → `buildUpstream`. Provider-neutral. ✔
- **`resolveProjectUpstream`** (`lib/git.ts:513`) already calls `getBackend(ref.provider)`. It
  calls `resolveProjectGitAuth` first; for `codestorage` that returns `{ authSource:'none' }`
  (token `null`) — fine, because our `buildUpstream` self-signs. ✔
- **Sandbox** (`sessions.ts:200`, daemon `git.ts`) uses proxy mode (`KORTIX_GIT_PROXY=true`):
  `KORTIX_REPO_URL = <api>/v1/git/<projectId>.git`, auth = `KORTIX_TOKEN`. The real code.storage
  JWT never enters the sandbox. **Zero sandbox changes** when proxy mode is on. ✔
  - The proxy forwards to code.storage with `fetch` (not a `git` subprocess) using
    `buildUpstream`'s `Authorization: Basic <base64('t:'+jwt)>` header. **Validated live**:
    code.storage's `info/refs` + upload-pack/receive-pack return `200` to header auth via fetch
    (see §10). The sandbox's `git` only ever speaks to the Kortix proxy with `KORTIX_TOKEN`.
- **DB** (`project_git_connections`, `projects.metadata.git`) stores `provider`, `managed`,
  `upstreamUrl`, `externalRepoId`, `repoOwner`, `repoName`, `authMethod`. All provider-opaque —
  **no migration**. Managed code.storage rows: `provider:'codestorage'`, `managed:true`,
  `authMethod:'managed'`, `upstreamUrl: https://kortix.code.storage/<projectId>.git`
  (bare projectId — the org is the subdomain; no path namespace). ✔

### 3.6 SDK alternative (`@pierre/storage`)

Instead of hand-rolling, depend on `@pierre/storage` and back the methods with
`new GitStorage({ name: org, key: privateKey })`: `store.createRepo({ id })`,
`repo.getRemoteURL({ permissions, ttl })`, `repo.getEphemeralRemoteURL(...)`,
`repo.promoteEphemeralBranch(...)`, `validateWebhook(...)`. Pros: handles ES256 + 409 retries +
URL building. Cons: new dep, async `buildUpstream` (interface is sync today — would need the URL
pre-minted or the method made async). **Recommendation:** hand-roll the 2 hot paths
(`buildUpstream` sign + `createRepo` POST) to keep `buildUpstream` synchronous and dependency-free,
and optionally pull the SDK in later for ephemeral/promote/webhook helpers.

---

## 4. Direct-mode clone credential (only if `KORTIX_GIT_PROXY=false`)

Today only managed GitHub returns a token from `resolveProjectGitAuth`. If we ever run sandboxes
in direct mode (no proxy), add a `codestorage` branch to `resolveProjectGitAuth` (and the
`/projects/:id/git/clone-credential` endpoint) that returns a self-signed repo-scoped
`git:read[,git:write]` JWT. **Not needed for proxy mode**, which is the default.

⚠️ **Direct-mode `git` gotcha (validated):** code.storage works with a real `git clone/push`
**only with creds embedded in the URL** (`https://t:<jwt>@kortix.code.storage/<id>.git`), so
libcurl answers the `401 Basic realm="Git Repository"` challenge natively. The daemon's current
`http.extraheader` scheme (`buildGitAuthArgs`, lowercase `basic`) does **not** satisfy that
challenge and `git` stalls/then asks for a password. So a future direct-mode codestorage path must
use creds-in-URL (which `authedPushUrl` already produces), not extraheader. The proxy path is
unaffected — it uses `fetch`, and header auth (capital `Basic`) returns `200`.

### 4.1 Host-side mirror (`projects/git/mirror.ts`) — FIXED for code.storage

`mirror.ts` keeps a host-side bare clone per project (used by the **template prebuild** AND the
**file/version/checkpoint viewer**). It authenticated with `http.extraheader` — which code.storage
rejects (401 Basic challenge), and it *prompted* via an inherited `GIT_ASKPASS` (VS Code/Cursor).

- **Defensive:** `runGit`/`runGitCapture` force `GIT_ASKPASS=''`+`SSH_ASKPASS=''` (+ existing
  `GIT_TERMINAL_PROMPT=0`) — server-side git can never prompt.
- **Functional (done):** the mirror now clones/fetches code.storage via **creds-in-URL** (username
  `t`, password = a freshly-minted repo-scoped JWT) instead of extraheader. The JWT comes from
  `resolveProjectGitAuth`'s new `codestorage` branch (`mintCodeStorageGitToken`, fresh per call);
  the bare clone uses the creds-URL then `set-url origin` back to the clean URL (token never
  persisted), and refresh fetches by explicit creds-URL + refspec. **Verified live:** bare-clone of
  a real seeded repo returned `[.gitignore, .kortix, README.md, kortix.toml]`. GitHub repos are
  unchanged (still extraheader).

### 4.2 Clone-URL surfaced to users (web "Develop on your own machine") — FIXED

The dev-view (`apps/web/.../sections/dev-view.tsx`) showed the raw upstream (`repo_url`) — useless
for code.storage (users can't auth against it). Now: for proxy-backed managed projects
(`git_origin_url` contains `/v1/git/`) it shows the **Kortix proxy URL** with a token —
`git clone https://x-access-token:<KORTIX_TOKEN>@<api>/v1/git/<projectId>.git <dir>` — skips the
GitHub-collaborator step, and notes the token stays in `origin` so push/CR work. `KortixProject`
gained `git_origin_url`. GitHub/BYO projects keep their existing flow.

---

## 5. Migration of existing managed-kortix GitHub repos

New projects go to code.storage immediately once `MANAGED_GIT_PROVIDER=codestorage`. Existing
GitHub-managed projects keep working unchanged (per-row `provider`). To move them:

1. `createRepo({ id: '<projectId>' })` on code.storage.
2. Mirror history via the import remote: clone the GitHub repo `--mirror`, add
   `https://t:<jwt>@kortix.code.storage/<projectId>+import.git`, `git push import --all && --tags`
   (creds-in-URL, per §4).
3. Flip the `project_git_connections` row: `provider→codestorage`, `upstreamUrl→…`, `managed→true`,
   `authMethod→managed`, null out `installationId`. Update `projects.metadata.git` to match.

A one-off backfill script under `apps/api/scripts/` (dev first). Decide whether to migrate at all
or only forward-provision new projects (open question §7).

---

## 6. Public key to register in the Pierre Admin Panel

Derived from the stored private key (`openssl pkey -pubout`):

```
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFDBTES98d1mim8WoRyLhwcPa5heN
hyx2/O46P4aKTtwn1SZdWGbOZxzhRDu20vZjdokXGoWwqMTu4ZmUKPrd7g==
-----END PUBLIC KEY-----
```

**Status: registered ✓** — verified live: an `org:read` JWT signed with this key is accepted by
`https://api.kortix.code.storage` (`200`). No `kid` is required (the JWT header is `alg`+`typ` only).

---

## 7. Decisions (all resolved 2026-06-15)

1. **Org slug** = `kortix` (from the dashboard `new GitStorage({ name: 'kortix' })`). Set in
   `MANAGED_GIT_CODESTORAGE_ORG`. ✔
2. **Public key** = registered in the Pierre Admin Panel (verified, §6). ✔
3. **Model A** (pure code.storage host). ✔
4. **Forward-only** — existing managed-kortix GitHub projects stay on the `github` backend. ✔
5. **Hand-rolled JWT** (no `@pierre/storage` dep) — keeps `buildUpstream` synchronous; validated
   live. ✔

---

## 8. Phased plan

- **P0 — backend + provisioning (core). ✅ BUILT + VALIDATED LIVE (§10).** `code-storage.ts`
  (`isConfigured`, `createRepo`, `buildUpstream`, `deleteRepo`, `seedFiles` via commit-pack,
  `authedPushUrl`), registered in `registry.ts`, config env added. **Remaining to go live:** set
  `MANAGED_GIT_PROVIDER=codestorage` on the target env (deployed dev = ECS/Secrets Manager, not
  `.env.dev`), then a real provision → session boots → clone/push through the proxy → CR. ke2e.
- **P1 — sessions on ephemeral branches.** Map session create → `getEphemeralRemoteURL` namespace;
  CR merge → `promoteEphemeralBranch`. (Optimization; proxy already works without it.)
- **P2 — GitHub mirror (optional, Model B).** Configure code.storage→GitHub sync + the GitHub
  App; provision with `baseRepo` sync; handle `409`/sync webhooks.
- **P3 — migrate existing managed repos** (if decided) via the import-remote backfill.

## 9. Testing

Black-box ke2e (live API, no mocks) per the ke2e suite: provision → repo exists → clone via proxy
→ push → CR. Run on dev with `MANAGED_GIT_PROVIDER=codestorage`. Keep the GitHub provisioning flow
green in parallel (both backends registered). Per repo rule, update `spec/end-to-end.md` + route
manifest if any route shape changes (it should not — provisioning is provider-param'd already).

---

## 10. Validation log (2026-06-15, live against org `kortix`)

Exercised the real backend module (and raw probes) against `api.kortix.code.storage`:

| Fact | Result |
|---|---|
| ES256 sign→verify with the stored key | ✓ 64-byte raw R||S (`dsaEncoding:'ieee-p1363'`), verifies vs derived pubkey |
| Public key registered (org:read accepted) | ✓ `200` |
| API base | `https://api.kortix.code.storage/api` (NOT `/repos` at root → 404) |
| Git host | `kortix.code.storage` (`git.code.storage` does NOT resolve) |
| Repo id / clone url | bare id, `https://kortix.code.storage/<id>.git`; **no** path namespace |
| Repos addressed by | the human `url` id (what we send as `id`), NOT the opaque `repo_id` |
| `createRepo` (`POST /api/repos`) | ✓ `201` — needs scope `repo:write` **+ `repo` claim = the new id** (org-wide token → 403) |
| `commit-pack` seed (`POST /api/repos/{id}/commit-pack`, NDJSON, base64 blobs) | ✓ `201`, `main` then advertised — this is the FIRST-commit path |
| `info/refs` read/write advertisement via fetch + `Basic` header | ✓ `200` (with or without `Git-Protocol: version=2`) |
| Raw upload-pack POST via curl + `Basic` header | ✓ `200` in ~0.4s |
| `deleteRepo` (`DELETE /api/repos/{id}`, `repo:write`+claim) | ✓ `200`; post-delete `info/refs` → `404` |
| `git clone/push` with creds-in-URL (`t:<jwt>@…`) | ✓ OK (v0 and v2) |
| `git clone/push` with `http.extraheader` (lowercase `basic`) | ✗ stalls — 401 challenge unsatisfiable (see §4) — **not used by the proxy** |

Net: the entire P0 path (provision → seed → proxy read/write → delete) works with `fetch`-based
header auth and the commit-pack API. The only thing that doesn't is a *direct* `git` subprocess
using extraheader — which the proxy architecture never does.

### 10.1 Full-stack local e2e (2026-06-15) — PASSED

Ran the **real Kortix stack** (`pnpm dev`, local Supabase, `MANAGED_GIT_PROVIDER=codestorage`)
and drove the actual route + proxy with a synth account (ke2e fixtures, flow-registry bypassed):

```
POST /v1/projects/provision {seed_starter:true}  → 201, project on https://kortix.code.storage/<projectId>.git
  (backend.createRepo → commit-pack seed of the starter)
git clone <api>/v1/git/<projectId>.git  (via Kortix proxy, PAT auth)  → OK: [.kortix, kortix.toml, README.md, .gitignore]
git push origin HEAD:main  (via Kortix proxy)                          → OK
```

This caught + fixed **two real bugs** (both in `code-storage.ts`, validated):
1. **PEM normalization** — `dev-local.sh` loads env via `dotenvx get --format eval` + shell `eval`,
   which delivers the key with **literal `\n`**; Bun's BoringSSL then throws `BAD_END_LINE`.
   `csPrivateKey()` now `.replace(/\\n/g,'\n')` + strips CR + ensures a trailing newline (mirrors
   `normalizeGitHubPrivateKey`). Also covers AWS Secrets Manager single-line PEMs.
2. **Seeding `initialToken`** — the provision route requires a non-null push credential before
   seeding (`pushToken = provisioned.initialToken ?? resolveProjectGitAuth(...)`); both were null
   for codestorage. `createRepo` now returns a real repo-scoped `git:write` JWT as `initialToken`
   (1h TTL), which also serves the response's `push_token` (CLI first push / prebuild clone).

**Still not run:** a real **Daytona session boot + CR** — but that exercises the *same* proxy-git
data path (proven above) plus Daytona/opencode/funding, none of which is code.storage-specific.
