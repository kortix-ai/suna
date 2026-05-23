# Executor — Handoff (for a fresh thread)

> **Read this first.** It is the complete, self-contained context for the Executor
> work. Pair it with the spec at `docs/specs/executor.md` (v4) +
> `docs/specs/executor-reference.md`. **Caveat:** those spec files currently live at
> the *parent* path `/Users/markokraemer/Projects/kortix/docs/specs/` (OUTSIDE the
> `suna/` repo). This handoff lives at `suna/docs/specs/executor-handoff.md` (tracked).
> Moving the spec into the repo is an open TODO.

Date of handoff: 2026-05-23 · Branch: `newer-kortix` · Repo root: `suna/`

## Post-handoff update — 2026-05-24

The "not yet e2e tested" items below were completed after this handoff was
written:

- CLI face: `executor connectors|discover|describe|call` tested against the
  gateway and inside a real Daytona sandbox.
- MCP face: `executor-mcp` stdio server added and tested with JSON-RPC
  `initialize`, `tools/list`, and `tools/call`.
- TS SDK: `packages/executor-sdk` added and typechecked; SDK calls covered by
  `e2e-executor-faces.test.ts`.
- Real sandbox-agent flow: a real OpenCode turn inside Daytona used `bash` to run
  `executor connectors` and `executor call httpbin get`.
- Provider coverage in the real sandbox: HTTP, HTTP bearer, OpenAPI, GraphQL,
  and MCP succeeded. Pipedream catalog/connect-url and auth-gating were verified;
  action execution still requires a connected OAuth account.

---

## 1. What the Executor is

One unified connector layer the agent uses to reach **every** configured
integration — **Pipedream, MCP, OpenAPI, GraphQL, raw HTTP** — exposed (intended)
as **CLI + MCP + TS SDK**. Modeled on RhysSullivan/executor (MIT) + executor.sh,
but **reimplemented on our Hono/Drizzle stack** (we did NOT adopt their
Effect/FumaDB packages, and we did NOT do an Effect-everywhere refactor).

### Architecture (locked)
- **Thin client in the sandbox → fat gateway in `apps/api`.** Credentials,
  execution, and policy all live server-side. The sandbox **never** sees a
  third-party secret.
- **kortix.toml-first.** Connectors are declared as `[[connectors]]` in the
  project's `kortix.toml` (mirrors `[[triggers]]` / `[[apps]]`). The manifest is
  the source of truth; a **sync** sweep materializes it into DB tables that the
  gateway + dashboard read (exactly like triggers).
- **Project-scoped.** No account-wide secrets. **Vault was explicitly killed.**
  Credentials are project secrets with `scope='connector'` (never injected into
  the sandbox env).
- **Credential is SPLIT from the connector** (critical design insight from Marko):
  multiple people may each hold their own credential. Each connector declares a
  **credential mode** (`shared` = one project credential, or `per_user` = each
  member connects their own) AND an **access/sharing scope** (who can use it).
  The UI **always asks the "who can use this?" question before connect/add** so it
  gets stored + scoped correctly.
- **Policies = executor's exact model** (Always run / Require approval / Block;
  top-to-bottom first-match-wins; glob patterns; blocked tools hidden from
  discovery + fail at invoke). Connector-scoped, declared in kortix.toml. Built
  LAST — core engine is allow-all first, then the policy layer flips on.

---

## 2. Current state (what's built / committed / tested)

### Git
- `d48439bcb` feat(executor): unified connector layer (Pipedream/MCP/OpenAPI/GraphQL/HTTP) — the big feature commit (~40 files)
- `34847e1a4` fix(executor): MCP SSE response parsing + relative OpenAPI server resolution — two e2e-discovered fixes
- Both are on `newer-kortix`, **not pushed**. (There was a rebase in between — the
  feature commit landed as `d48439bcb`; `1a02ffb2d "Fix post-rebase type and build
  issues"` sits between the two executor commits.)
- The 6 currently-dirty files (`app-header.tsx`, `user-menu.tsx`,
  `project-tab-bar.tsx`, `tab-bar.tsx`, `use-project-shell-shortcuts.ts`,
  `project-session-tabs-store.ts`) are **unrelated** web-layout changes — not part
  of the executor work. Leave them alone unless asked.

### Test status
- **Full unit/contract suite green** (126 tests last run). Executor unit tests:
  `unit-executor-{execute,gateway,materialize,normalize,policy,share}.test.ts` +
  `e2e-executor.test.ts` (drives the real Hono router with in-memory fakes at the
  db/upstream boundary).
- **Live gateway e2e done for all 5 providers** through
  `POST http://localhost:8008/v1/executor/call` with a real account token, on a
  real project, making real outbound calls, writing real audit rows:
  - OpenAPI — petstore `getPetById(1)` → real "doggie" ✅
  - GraphQL — countries `country(US)` → real data ✅
  - HTTP — httpbin `/get` → real echo ✅
  - MCP — deepwiki `read_wiki_structure(facebook/react)` → real wiki (SSE parsing) ✅
  - HTTP+bearer — httpbin `/bearer` → `{"authenticated":true,"token":"demo_token_PROOF_99"}`
    proving the credential is attached **server-side** ✅
  - (petstore `findByStatus`/`inventory` return upstream 500s — confirmed demo-server
    flakiness, audited as errors correctly.)

> ⚠️ **Gotcha:** Bun's `mock.module` leaks across files, so running multiple e2e
> files together pollutes each other. **Run e2e files individually.**

### ⚠️ What was NOT yet e2e tested (this is the next task — see §8)
The live e2e above hit the **gateway HTTP endpoint directly**. We did **not** yet
exercise the three "faces" the reference project ships, nor the real
sandbox-agent loop:
1. **CLI** (`executor connectors|discover|describe|call`) — *built* but never run
   end-to-end as a CLI (only the gateway it calls was tested).
2. **MCP face** (Executor exposed *as* an MCP server so any MCP client can use all
   connectors as tools) — **NOT built.** Note: we consume MCP *as a provider*
   (tested); we do not yet *expose* Executor as MCP.
3. **TS SDK** (programmatic `import`) — **NOT built** as a package; the only TS
   surface today is the CLI's private `gateway()` fetch helper.
4. **Full sandbox-agent flow** (an agent inside a real Daytona sandbox invoking the
   `executor` CLI against the live gateway, with `KORTIX_EXECUTOR_TOKEN` injected at
   provision) — **NOT e2e tested end-to-end.**

---

## 3. File map

### API — `apps/api/src/executor/`
| File | Purpose |
|---|---|
| `types.ts` | `NormalizedAction`, `ActionBinding` (openapi/graphql/mcp/http/pipedream), `Risk`, `HttpRouteSpec`, `McpToolLike`, `PipedreamActionLike` |
| `normalize.ts` | `normalize{OpenApi,Graphql,Mcp,Http,Pipedream}` + `riskForMethod` → one catalog with risk (GET=read / DELETE=destructive / mutation=write / destructiveHint) |
| `execute.ts` | Execution layer. `applyAuth` (bearer/basic/custom/none), `buildHttpRequest`/`buildMcpRequest`/`buildGraphqlRequest`, `parseResponseBody` (JSON → SSE `data:` lines → raw), `performRequest`, `executeCall` (dispatch by binding kind). Pure builders + injectable `fetchImpl`. **Creds attached HERE, server-side.** |
| `share.ts` | Pure sharing logic: `isSecretUsableBy`/`intentToScope`/`scopeToIntent`/`resolveShareSubject`. Three UI options → one mechanism (project / restricted+grants). Marko's rule: empty allow-list = whole project. (Some secret-DB helpers here are now near-dead — credentials.ts is the live path.) |
| `policy.ts` | `globToRegex`, `resolvePolicyAction` (first-match-wins), `isVisible`. Always-run/require-approval/block. |
| `gateway.ts` | `handleCall` — the core request flow (see §5). `connectorUsable`. `GatewayDeps.resolveCredential(connectorId, userId\|null)`. `executePipedream` takes userId. |
| `credentials.ts` | `loadConnectorGrants`/`loadGrantsForMany`/`setConnectorSharingDb`/`resolveCredentialValue`/`credentialExists`/`upsertCredential` (encrypted with the project key via projects/secrets). |
| `pipedream.ts` | `PipedreamProvider` (createConnectToken w/ `&app=`, listAccounts, listActions, listApps, runAction). `externalUserId(proj,slug,userId?)`, `pipedreamConnectUrl`/`finalizePipedreamConnection`/`runPipedreamAction`/`browsePipedreamApps`/`pipedreamCatalog`/`verifyWebhookSig`/`pipedreamConfigured`. |
| `sync.ts` | `syncProjectConnectors` — read `[[connectors]]`, fetch+normalize each catalog, upsert connectors/actions/policies. Best-effort per connector (unreachable → status='error', 0 actions, never fails the sweep). Resolves relative OpenAPI servers against the spec URL origin; uses `parseResponseBody` for MCP SSE. |
| `materialize.ts` | `connectorConfig`, `toPolicyRows` — spec → DB row shapes. |
| `db-deps.ts` | Production wiring of `ExecutorRouterDeps` / `GatewayDeps` (DB-backed). |
| `router.ts` | The Hono router (two faces: gateway + admin). See §4. Built against injected `ExecutorRouterDeps` so the e2e drives the real HTTP layer with fakes at the boundary. |
| `manifest-crud.ts` | `upsertConnectorInManifest`/`deleteConnectorFromManifest`/`setConnectorCredentialShared` — edit kortix.toml. |
| `index.ts` | `executorApp` — mounts the router with prod deps. |

### Connector parsing — `apps/api/src/projects/`
- `connectors.ts` — `[[connectors]]` parser. `ConnectorSpec` has `credentialMode`
  (`'shared'`/`'per_user'`, default: pipedream→per_user else shared); `auth.secret`
  is OPTIONAL. `extractConnectors`/`connectorSpecToTomlEntry`/`manifestHashForConnector`.
- `index.ts` — exports `withProjectGitAuth`, `commitManifest`, `loadManifestForEdit`
  (one-directional, avoids circular imports).
- `secrets.ts` — excludes `scope='connector'` from sandbox injection.

### DB — `packages/db/src/schema/kortix.ts` + `supabase/migrations/00000000000062_executor.sql`
Enums: `secretShareScopeEnum`, `projectSecretScopeEnum`, `secretGrantPrincipalEnum`,
`executorConnectorProviderEnum`/`StatusEnum`/`PolicyActionEnum`/`RiskEnum`/`ExecutionStatusEnum`,
`CredentialModeEnum`. Tables: `executorConnectors` (+shareScope/credentialMode),
`executorConnectorGrants`, `executorCredentials`, `executorConnectorActions`/`Policies`/`Executions`,
`projectSecretGrants`; `project_secrets` gained `scope` + `shareScope`. Migration is
idempotent (DO blocks / IF NOT EXISTS) and **already applied live**.

### Sandbox CLI — `apps/sandbox/agent-cli/connectors/executor.ts`
The thin client. Commands: `connectors`/`ls`, `discover`/`search`, `describe
<connector>.<action>`, `call <connector> <action> '<json>'`. Auth via
`KORTIX_EXECUTOR_TOKEN` + `KORTIX_API_URL`. Everything routes through the gateway;
holds no secret. Depends on `apps/sandbox/agent-cli/lib` (`parseArgs`, `out`,
`handleError`, `CliError`, `requireEnv`, `getEnv`).

### Token minting — `apps/api/src/platform/services/session-sandbox.ts`
Mints `KORTIX_EXECUTOR_TOKEN` via `createAccountToken` (project-scoped, acts as the
launching user) and injects it + `KORTIX_API_URL` into the sandbox env at provision.

### Web — `apps/web/src/app/projects/[id]/(customize)/connectors/page.tsx`
`ConnectorsView` (exported, used by `CustomizeView`), `AppCatalogue` (grid +
`useInfiniteQuery` pagination, copied from main's catalogue), `ConfigureAppDialog` +
`ConnectorSetupFields` (asks credential mode + access **up front**),
`CustomConnectorForm`, source/schema viewer, sharing dialog. "Easy-connect apps"
forward-facing name (never "Pipedream"). In-page overlay via
`createFrontendClient({externalUserId, tokenCallback}).connectAccount()`. Modal is
`sm:max-w-4xl`, body `max-h-[58vh] overflow-y-auto`.
- Client: `apps/web/src/lib/projects-client.ts` — `listConnectors`/`syncConnectors`/
  `setConnectorSharing`/`createConnector`/`deleteConnector`/`setConnectorCredential`/
  `listPipedreamApps`/`pipedreamConnect`/`pipedreamFinalize`; `AdminConnector`
  (+credentialMode), `ConnectorDraftInput` (+credential, +sharing).
- Wired into: `customize-nav.tsx`, `customize/customize-rail.tsx`,
  `customize/customize-view.tsx`, `lib/customize-sections.ts`, `lib/menu-registry.ts`.

---

## 4. HTTP surface (`router.ts`, mounted at `/v1/executor`)

**Gateway (sandbox-facing, `KORTIX_EXECUTOR_TOKEN`):**
- `GET /v1/executor/connectors` → catalog this session can use (sharing-filtered, blocked hidden)
- `POST /v1/executor/call` → `{ connector, action, args }` → run. Returns `ok`/`pending_approval`(202)/`denied`(403/404)/`error`(502).

**Admin (dashboard-facing, user auth + project access):**
- `GET /v1/executor/projects/:projectId/connectors` — list + status
- `POST /v1/executor/projects/:projectId/connectors` — add/update (writes kortix.toml)
- `DELETE …/connectors/:slug` — remove
- `PUT …/connectors/:slug/credential` — set credential value
- `PUT …/connectors/:slug/sharing` — set who-can-use
- `POST …/connectors/sync` — re-materialize from kortix.toml
- `GET …/pipedream/apps` — browse catalogue (search + paginate)
- `POST …/connectors/:slug/connect` + `…/connect/finalize` — Pipedream 1-click
- `POST /v1/executor/webhook/pipedream` — HMAC-signed, no user auth

---

## 5. Request flow (`gateway.ts handleCall`)

token → principal → loadConnector → **access check** (`isSecretUsableBy` over the
connector's grants for this subject) → **resolveCredential** by mode (shared row, or
this user's own row for per_user) → **policy** (resolvePolicyAction: block→denied,
require-approval→pending_approval, else run) → **execute** (server-side outbound) →
**audit** (executor_executions row: ok/error). Blocked tools are also hidden from
`/connectors`.

---

## 6. Config / env (`apps/api/src/config.ts`)
`INTEGRATION_AUTH_PROVIDER=pipedream`, `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_SECRET`,
`PIPEDREAM_PROJECT_ID`, `PIPEDREAM_ENVIRONMENT`, `PIPEDREAM_WEBHOOK_SECRET` (all
optional; present in Marko's `.env`). Sandbox gets `KORTIX_EXECUTOR_TOKEN` +
`KORTIX_API_URL` at provision.

`external_user_id` format: `${proj}:${slug}` or `${proj}:${slug}:${userId}`.
Pipedream SDK: `@pipedream/sdk@2.3.7`.

---

## 7. Live e2e fixtures (reuse these)
- API: `http://localhost:8008` (gateway base `http://localhost:8008/v1/executor`)
- Test project **Nbghjk**: `0e96d960-42ff-4f71-a65a-7026848c1d1d`
- Account token (acts-as-user, project-scoped): `kortix_pat_FY8TAOAsiCeIyql0TCU4BBjkqEPnkwAw`
  - ⚠️ This is a live local token — rotate/re-mint as needed; don't commit it. Mint
    new ones via the account-token path (see `e2e-mint-cli-token.ts`).
- Public test upstreams used: petstore3.swagger.io (OpenAPI, flaky on some ops),
  countries.trevorblades.com (GraphQL), httpbin.org (HTTP / bearer),
  mcp.deepwiki.com (MCP, SSE-framed).

---

## 8. ⭐ NEXT TASK (Marko's explicit ask)

> "did u e2e test using it as a CLI / MCP / TS — did u try all the methods?
> https://github.com/RhysSullivan/executor — NEXT UP WE HAVE TO IN DEPTH TEST AND
> ENSURE IT ALL WORKS flawlessly, I want same for CLI/MCP/TS & same way for an AGENT
> in Sandbox to work with our executor and that flow also has to be e2e tested &
> ensured that it works properly."

**Honest status: NO — only the gateway HTTP endpoint was e2e'd directly.** The four
items in §2 ("What was NOT yet e2e tested") are the work. Proposed plan:

1. **CLI face — e2e against the live gateway.** Run the real `executor` binary/script
   (`apps/sandbox/agent-cli/connectors/executor.ts`) with `KORTIX_EXECUTOR_TOKEN` +
   `KORTIX_API_URL` set, against all 5 providers: `connectors`, `discover "<intent>"`,
   `describe <slug>.<action>`, `call <slug> <action> '<json>'`. Assert real results +
   audit rows. Confirm error/denied/pending paths surface cleanly through `CliError`.
   Check how it's installed in-sandbox (`apps/sandbox/agent-cli/install-shims.sh`).
2. **MCP face — decide + build, then e2e.** The reference exposes Executor *as* an MCP
   server (every connector tool becomes an MCP tool). We don't have this yet. Decide
   scope with Marko (is this required for v1, or is CLI enough for the sandbox agent?).
   If built: stand it up, point an MCP client at it, list tools, call one per provider,
   verify gateway audit.
3. **TS SDK face — decide + build, then e2e.** A small typed client
   (`connectors()/discover()/describe()/call()`) wrapping the gateway, usable via
   `import`. Likely factor out the CLI's `gateway()` into a shared SDK the CLI re-uses.
   Test programmatically against all 5 providers.
4. **Full sandbox-agent flow — the real loop, e2e.** Provision a real Daytona sandbox,
   confirm `KORTIX_EXECUTOR_TOKEN`/`KORTIX_API_URL` are injected, have the in-sandbox
   agent actually `discover` → `describe` → `call` a connector and use the result.
   This is the flow that matters most — prove an agent can do real work through the
   Executor with zero secrets in the sandbox.

**Before starting:** confirm the gateway is running (`http://localhost:8008`), the
test project + token are still valid (re-mint if not), and run e2e files individually.
**Ask Marko for real creds whenever a provider needs them** (he offered). Keep using
the public upstreams in §7 where no auth is needed.

---

## 9. Locked decisions / constraints (don't relitigate)
- Reimplement on Hono/Drizzle — **no** Effect-everywhere refactor; **no** adopting
  their Effect/FumaDB packages.
- **Vault is dead.** Project secrets only; `scope='connector'` never injected.
- Credential **split** from connector; per-app `credentialMode` (shared|per_user) +
  always ask access/scoping ("who can use this?") before setup.
- Policies = executor's model, connector-scoped, in kortix.toml, **built last**.
- Pipedream stays the primary 1-click onboarding but is **"Easy-connect apps"**
  forward-facing — never call it Pipedream in the UI.
- `kortix.toml` is the source of truth; DB is a materialized view (sync, like triggers).
- No account-wide secrets; everything is a project concern.

## 10. Gotchas
- Bun `mock.module` leaks across files → run e2e files individually.
- Spec docs live OUTSIDE the repo (parent `kortix/docs/specs/`) → move into `suna/docs/specs/` (TODO).
- `.kortix/` is gitignored → the kortix-executor SKILL.md is not committed (TODO: add to `packages/starter/templates`).
- petstore demo server returns 500s on some ops (findByStatus/inventory) — upstream flakiness, not our bug.
- Generated `.next/types` route TS2344 errors on `*View` exports are pre-existing noise across ALL customize pages — not unique to connectors.
- Commits must have **no** `Co-Authored-By: Claude` trailer (Marko's standing rule).

## 11. How to run
```bash
# from suna/
bun test apps/api/src/__tests__/unit-executor-*.test.ts   # executor units
bun test apps/api/src/__tests__/e2e-executor.test.ts       # router e2e (run alone)
# live gateway (API must be up on :8008):
curl -s http://localhost:8008/v1/executor/connectors -H "Authorization: Bearer <token>"
curl -s -X POST http://localhost:8008/v1/executor/call -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"connector":"<slug>","action":"<action>","args":{}}'
# CLI (next task): set KORTIX_EXECUTOR_TOKEN + KORTIX_API_URL, then
bun apps/sandbox/agent-cli/connectors/executor.ts connectors
```
Web UI to test by hand: project → Customize → **Connectors** (Easy-connect apps).
