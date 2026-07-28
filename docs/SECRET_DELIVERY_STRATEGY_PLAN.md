# Secret Delivery Strategy (SDS) — design and implementation plan

> **Provenance.** Produced by a multi-agent design pass: 8 parallel code-survey
> agents established ground truth, 4 independent architectures were proposed,
> 4 independent judges scored them on security / compatibility / buildability /
> product, and the winner was synthesised with grafts from the runners-up.
> Every file:line reference below came from an agent that read the code.
>
> **Two claims in the "Parallel track" section were checked by hand and one is
> WRONG — see the correction note at the end of this file before acting on it.**

# Secret Delivery Strategy (SDS) — Implementation Plan

## 1. Decision: what we build, and what we took from each runner-up

**Winner: `hybrid-strategy` (per-secret `strategy` axis), with the `broker-api` chokepoint grafted in as a first-class backend.**

The reason hybrid wins is that it is the only design where **the security property and the network infrastructure are decoupled by construction**. `denied` and `broker` need no CA, no netfilter, no new deployable — they are enforced by *absence*, in one SQL predicate, identically on Daytona, Platinum, E2B and local-docker. `egress` (the founder's literal ask — transparent wire rewrite) then layers on top for the cases that need unmodified third-party code to keep working.

Its one real weakness, correctly identified by the buildability judge, is that hybrid's `broker` only points at *existing* named backends (LLM gateway, Executor, git proxy), so an arbitrary vendor API has no usable path until the very expensive `egress` stage lands. **That is exactly what `broker-api` solves.** So we graft `broker-api`'s generic `POST /v1/broker/fetch` + localhost base-URL shim in as `backend: 'kortix_fetch'`, which arrives in Stage 2 — weeks before any CA exists.

### Grafts, by source

**From `broker-api` (design 3):**
- The Property A / Property B split, made explicit in the docs: *"the value is not in your box"* is one predicate and ships first; *"you can only reach the upstream through us"* is separate, staged, per-provider, and optional.
- The generic `POST /v1/broker/fetch` chokepoint + `base_url_env` SDK hook + `createBrokeredFetch` SDK export + localhost shim. This is what makes `broker` universal.
- **Null agent grant ⇒ DENY for non-`runtime` rows.** `agentMayUseEnv` fails open (`agent-scope.ts:87`, verified). Nothing legacy depends on the new classes, so we close the fail-open exactly where it matters at zero back-compat cost.
- The **self-describing placeholder** so a stray SDK's 401 lands remediation text in the model's own context.

**From `placeholder-token` (design 2):**
- **Format-shaped placeholders** (`handle_prefix: "sk-ant-api03-"`), whole string `[A-Za-z0-9_-]` so it survives `shellQuote` in `agent-env.sh`, JSON bodies, headers and query params. Vendor SDKs that regex-validate key shape keep constructing.
- The **HMAC tag**, verified statelessly *before* any DB lookup — so the tripwire cannot be DoS'd by an agent spraying tokens, and FORGED (bad tag) is distinguishable from STOLEN (valid tag, wrong session). Kortix has zero exfiltration detection today; this is nearly free on top of a placeholder we are minting anyway.
- The **nine-disposition table** as the broker's normative behaviour spec.
- Stage-1's gateway trick: for `backend: 'llm_gateway'`, inject a **real session-scoped gateway key wearing the provider's key shape** plus `ANTHROPIC_BASE_URL`, so unmodified SDK code keeps working while the real provider key leaves the box.

**From `mitm-proxy` (design 1):**
- **Per-sandbox ephemeral CA** (24h, private key never in a guest, only the leaf cert travels) instead of a fleet-wide baked root. Tampering degrades to self-DoS.
- **SNI/CONNECT-authority vs inner `Host`/`:authority` mismatch rejection** — the obvious bypass of host-keyed injection that designs 2/3/4 never mention.
- **`supportsEgressEnforcement` provider capability flag** that *refuses* session creation rather than silently downgrading.
- The full CA-trust env battery (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CARGO_HTTP_CAINFO`, `DENO_CERT`, `AWS_CA_BUNDLE`, `SSL_CERT_DIR`) — Python's `certifi` is the #1 rollout footgun.

**Kept from hybrid itself:** the four-value strategy axis, the strictness lattice with max-composition, safe-by-default per project origin, `observe` mode, transparent DNAT on Platinum, and the secrets-table Delivery column with one plain sentence per row.

---

## 2. The model

```
strategy ∈ ('runtime', 'egress', 'broker', 'denied')     default 'runtime'
rank:        0          1         2         3            composition = MAX
```

| strategy | what lands in the sandbox env | who attaches the credential | unmodified vendor SDK works? |
|---|---|---|---|
| `runtime` | **the plaintext value** | nobody — the agent holds it | yes (today's behaviour) |
| `egress` | a format-shaped **handle** | the Kortix egress proxy, outside the guest, per host+method+path | yes |
| `broker` | a self-describing **handle** (or a real session-scoped gateway key for `llm_gateway`) | a named Kortix chokepoint: `llm_gateway` \| `executor` \| `git_proxy` \| `kortix_fetch` | only via `base_url_env` / custom fetch / `kortix fetch` |
| `denied` | **nothing** — name not emitted at all | nobody, no path exists | n/a |

`scope` (`runtime`\|`connector`) is untouched and keeps meaning *which subsystem owns the row*. Adding a third `scope` value would silently change semantics for the live `scope='connector'` rows the channels install store writes (`channels/install-store.ts:714`). `strategy` is the orthogonal *how does the value reach the wire* axis.

**Composition** is `max(DB row, manifest [env] entry, agent grant entry, session allowlist entry)` — but **only explicit declarations participate**. A bare string in `[env].required` (today's form) contributes *no opinion*, not rank 0. That single rule is what makes the change back-compat-safe. A manifest that explicitly declares a **weaker** strategy than the DB row is a **validation error**, not a silent downgrade — necessary because a KaaB agent can write its own repo and `sandbox.on_boot` runs `bash -lc` with the daemon's full env on every boot (`main.ts:266`).

### The one chokepoint

Verified: `listProjectSecretsSnapshotForUser` (`apps/api/src/projects/secrets.ts:445`) is called by **exactly two production sites** — boot (`sessions.ts:412`) and the per-prompt hot push (`sandbox-env-sync.ts:100`). Everything else in the grep is a test mock. `listProjectSecretsSnapshot` (no user) is names-only for the LLM gateway model picker and **must not change**.

So the entire delivery decision goes inside that one function. Both call sites need **zero changes for correctness** — boot spreads `runtimeSecrets.env`, the hot push takes `.env` and re-sanitizes. Placeholders flow through untouched. This is why Stage 1 is small, and it is the same discipline `secret-grant.ts` established after the "THE CLOBBER FIX" regression (`sandbox-env-sync.ts:95`).

### Handle format

```
<handle_prefix>KXS1<20ch base32: 96-bit lookup_id><16ch base32: 80-bit tag>
tag = HMAC-SHA256(handleKey, "kxs.v1|" || lookup_id)[0..10]
handleKey = hkdfSync('sha256', config.API_KEY_SECRET, salt='kortix-secret-handle', info='kxs-v1', 32)
```
- `handle_prefix` default `kortix_brokered__use_kortix_fetch__` (self-describing, for `broker`); per-secret override for format shaping (`sk-ant-api03-`, `sk_live_`) when an SDK validates key shape.
- Whole string is `[A-Za-z0-9_-]`.
- Handles are **per (session, secret)**, minted once at boot and **reused on every hot push** so the value in the box is stable for the session's life. `revision` exists on the row for per-prompt rotation in Stage 6.
- The DB stores `lookup_id` (indexed) and `sha256(full handle)` — never the handle plaintext.
- Deriving `handleKey` from `API_KEY_SECRET` means **no new required deploy secret**. Blast radius is honestly the same single static key the whole secret store already has (`secrets.ts:50`).

---

## 3. Default for existing projects, and why it is safe

**`project_secrets.strategy` defaults to `'runtime'`. `projects.secret_default_strategy` defaults to `'runtime'`.**

On the day the migration lands: every existing row resolves exactly as today; `buildSessionSandboxEnvVars` returns a byte-identical map; the provider create call, `/kortix/env`, `agent-env.sh` and every shell hook are unchanged. **There is no backfill and no flag day.** A project changes behaviour only when someone explicitly flips a secret, merges a manifest that declares one, or turns on the per-project auto-upgrade.

Two additional stickiness rules protect a project that *has* opted in:
- `strategy` is **set on INSERT only, never on conflict-update** — mirroring how `writeSharedProjectSecret` already treats `scope` (`secrets.ts:104`). A re-entered value via a setup link or `kortix env push` can never silently downgrade a brokered secret to plaintext.
- Changing strategy requires the dedicated `PUT .../strategy` route, a new admin-tier IAM leaf, and is **hard-denied for sandbox-kind API keys and for any principal folded through an agent grant**. Today `POST /secrets` is gated on `PROJECT_SECRET_WRITE` through the agent grant (`r3.ts:521`) and a project with no manifest yields an *unrestricted* grant — so without this, an agent denied a value would simply flip the row back and reboot.

---

## 4. Stages

Every stage leaves `main` green and shippable on its own.

---

### Stage 1 — "the value stops entering the box" (~1 week)

**This is the slice that makes a real secret genuinely unreadable from inside a sandbox.** No CA, no proxy, no netfilter, no new deployable, all four providers.

#### Schema

`packages/db/src/schema/kortix.ts`:

```ts
export const projectSecretStrategyEnum = kortixSchema.enum('project_secret_strategy', [
  'runtime', 'egress', 'broker', 'denied',
]);

// on projectSecrets:
strategy:      projectSecretStrategyEnum('strategy').default('runtime').notNull(),
egressPolicy:  jsonb('egress_policy').$type<SecretEgressPolicy>(),  // null unless strategy != 'runtime'
handlePrefix:  varchar('handle_prefix', { length: 48 }),
description:   text('description'),          // setup-links.ts:88 already collects this and discards it
rotatedAt:     timestamp('rotated_at', { withTimezone: true }),
strategyLocked: boolean('strategy_locked').default(false).notNull(),

// on projects:
secretDefaultStrategy: projectSecretStrategyEnum('secret_default_strategy')
  .default('runtime').notNull(),
```

New table `kortix.project_session_secret_handles`:
```ts
handleId, projectId, sessionId (fk → project_sessions, cascade),
secretId (fk → project_secrets, cascade), identifier varchar(128), envName varchar(64),
lookupId varchar(32) notNull, handleHash char(64) notNull,
revision integer default 1 notNull,
policySnapshot jsonb notNull,          // frozen at mint — a live handle can lose validity, never gain a host
status: handleStatusEnum('active'|'superseded'|'revoked') default 'active',
issuedAt, expiresAt, revokedAt
```

**Migrations (house rules):**
1. `bun scripts/generate.ts secret_delivery_strategy` from `packages/db` → drizzle emits the enum + columns + table into `packages/db/migrations/<ts>_secret_delivery_strategy.sql`. House-style the SQL. Commit the updated `drizzle/` snapshot.
2. **Strip every `create index` drizzle emits for the new table** and do *not* declare those indexes in `kortix.ts` (follow the documented pattern at `packages/db/migrations/20260727113441903_*.concurrent.ts:12` — "intentionally not declared in the drizzle schema so `db:generate` won't fight it"). Add `packages/db/migrations/<ts>_secret_handle_indexes.concurrent.ts` with `pgm.noTransaction()`, `set lock_timeout = '2s'` in its own `pgm.sql()`, then separate calls for:
   - `create unique index concurrently if not exists idx_secret_handles_lookup on kortix.project_session_secret_handles (lookup_id)`
   - `create index concurrently if not exists idx_secret_handles_session on ... (session_id)`
   - `create unique index concurrently if not exists idx_secret_handles_session_secret_rev on ... (session_id, secret_id, revision)`
   - `create index concurrently if not exists idx_project_secrets_project_strategy on kortix.project_secrets (project_id, strategy) where strategy <> 'runtime'`
   
   `export const down = false;` per the established convention.

#### Files

**New — `apps/api/src/secrets/strategy.ts`** (pure, DB-free, fully unit-testable — the analogue of `resolveGrantedSecretEnv`):
- `STRATEGY_RANK`, `maxStrategy(...)` — the lattice.
- `parseEgressPolicy(json)` — the single grammar, shared by the REST route, the manifest validator and the CLI.
- `matchRule(policy, {host, method, path})` — exact host **or one leading `*.` suffix, never regex**; methods (`[]` = any); path exact or one trailing `/*`; first match wins; **no match ⇒ deny**.
- `mintHandle({ lookupId, prefix })` / `verifyHandleTag(handle)` — stateless HMAC.

**`apps/api/src/projects/secrets.ts`**
- `listResolvedProjectSecrets` — add `secretId`, `strategy`, `egressPolicy`, `handlePrefix` to the select. **Do not touch** the `eq(scope,'runtime')` predicate.
- `resolveGrantedSecretEnv` — carry `{ key, value, strategy, secretId, identifier, handlePrefix, egress }` per winning row instead of a bare value. Identifier/ambiguity semantics unchanged.
- `listProjectSecretsSnapshotForUser(projectId, userId, grantEnv, sessionId?)` — new 4th param. This is where delivery is materialized:
  - `runtime` → plaintext, as today.
  - `denied` → **omit from both `env` and `names`.**
  - `broker` / `egress` → mint-or-reuse a handle for `(sessionId, secretId)` and emit `KEY=<handle>` plus the name.
  - `broker` with `backend: 'llm_gateway'` → emit a real session-scoped gateway key from `createGatewayKey` (verified present, `llm-gateway/gateway-keys.ts:13`) wearing the provider's shape, **plus** the policy's `base_url_env` (e.g. `ANTHROPIC_BASE_URL`) so unmodified SDK code routes to the gateway, which already resolves the real BYOK key server-side (`resolve-candidates.ts:127`).
  - **`sessionId == null` ⇒ every non-`runtime` row is omitted** (fail-closed; there is no handle to mint).
  - Grant check: for non-`runtime` rows a **null agent grant is treated as `[]`, not `'all'`**.

**`apps/api/src/projects/lib/sessions.ts`**
- Pass `input.sessionId` through to the snapshot call (line 412).
- Move `KORTIX_PROJECT_SECRET_NAMES` (line 463) to be computed **after** the `SLACK_*` / reserved-name deletes, matching what the hot push already does correctly at `sandbox-env-names.ts:35`. Rule: *a name appears in `KORTIX_PROJECT_SECRET_NAMES` iff a value (real or handle) is emitted for it.*
- Delete the dead `freshSession` / `baseSha` params (declared line 366, passed at 1300-1301, never read) so the new strategy plumbing is not mistaken for more of the same.

**`apps/api/src/projects/lib/sandbox-env-sync.ts`** — pass `sessionId` into the snapshot call (line 100). One-line change; parity is then structural.

**`apps/kortix-sandbox-agent-server/src/routes/pty.ts:122`** — replace `{ ...process.env, ... }` with `mergeProjectEnv(process.env, projectEnv)`. This must ship here regardless of strategy: terminals currently serve boot-time (including revoked) plaintext forever.

**`apps/kortix-sandbox-agent-server/src/main.ts`** — immediately **after** `createProjectEnvStore()` at lines 136, 550 and 676 (the store seeds itself *from* `process.env`, verified `project-env.ts:48`), `delete process.env[name]` for every name in the store's `knownNames`. Closes `/proc/<daemon-pid>/environ`, which is a same-uid read.

**`apps/api/src/projects/routes/r3.ts`** — `POST /secrets` accepts optional `strategy` / `egress` / `handle_prefix` / `description` (sticky on upsert; 403 `secret_strategy_sandbox_write_forbidden` for sandbox-kind keys and agent-grant-folded principals). New `PUT /v1/projects/:projectId/secrets/:identifier/strategy` gated on the new `project.secret.strategy.write` IAM leaf (`iam/actions.ts` + `role-perms.ts`, admin tier), returning `{ requires_new_sandbox: true, affected_sessions: [...] }`. New `POST .../secrets/:identifier/rotate`. Add `recordAuditEvent` on secret create/update/delete/strategy — `r3.ts` has **zero** today.

**`packages/api-contract/src/index.ts` + `apps/api/src/projects/lib/serializers.ts`** — `SecretSchema` gains `strategy`, `scope`, `egress_summary` (hosts + injection slot, never a value), `strategy_locked`, `rotated_at`, `description`; `can_rotate` stops being `isGitAuth`-only (`serializers.ts:308`). Side benefit: `GET /secrets` filters only `!item.system` (`r3.ts:479`), so `SLACK_BOT_TOKEN` renders today as an ordinary injected secret — exposing `scope` + `strategy` fixes that.

**`apps/cli/src/commands/secrets.ts`** — `--strategy`, a `DELIVERY` column on `ls`, and `kortix secrets strategy <id> <strategy>`.

**Data-driven cleanup:** convert `NEVER_IN_SANDBOX = {SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN}` (`sandbox-env-names.ts:12`) and the mirrored `delete` statements at `sessions.ts:432,438` into `strategy='broker', backend='executor'` rows. The two-file hardcoded policy — and its drift class — disappears into data.

#### Tests

- **Unit** `apps/api/src/secrets/__tests__/strategy.test.ts` — lattice max-composition; "absent ≠ runtime"; host matcher rejects regex and `evil-api.anthropic.com.attacker.tld`; path prefix matching; handle tag verify/reject.
- **Integration** `apps/api/src/__tests__/integration-secret-strategy.test.ts` — extends the existing `integration-session-env-grants.test.ts` harness. Asserts: `denied` appears in neither `env` nor `names`; `broker` appears in both with a handle; `sessionId=null` omits every non-`runtime` row; **null agent grant denies a `broker` row but still allows a `runtime` row**.
- **Parity (the regression class that already cost us twice)** — `apps/api/src/__tests__/integration-secret-strategy-parity.test.ts`: boot and hot push, given the same session, produce identical `env`/`names`; the hot push cannot re-add a brokered value.
- **ADVERSARIAL — API side** `apps/api/src/__tests__/adversarial-secret-absence.test.ts`: spy on `provider.create` and on the `/kortix/env` POST body; boot a session with a `broker` secret whose value is a unique canary; assert the canary string appears in **zero** of: `buildSessionSandboxEnvVars`' return, `CreateSandboxOpts.envVars`, the hot-push payload, `KORTIX_PROJECT_SECRET_NAMES`' values.
- **ADVERSARIAL — daemon side** `apps/kortix-sandbox-agent-server/src/__tests__/secret-absence.test.ts`: given a boot env holding only a handle, assert `renderShellEnv` emits the handle (not a real value), `mergeProjectEnv` never yields one, and after the new scrub `process.env` contains no managed name.
- **ADVERSARIAL — in-box, real** new ke2e flow `tests/src/flows/secret-strategy.flow.ts` (`SDS-1`): create a project with a `broker` secret set to a canary, boot a session, then via the sandbox run and assert the canary is absent from **all** of:
  ```
  env | grep -c CANARY
  cat /dev/shm/kortix/agent-env.sh
  sudo cat /proc/1/environ | tr '\0' '\n'
  sudo cat /etc/pt-env 2>/dev/null          # Platinum
  sudo cat /etc/kortix/runtime-env.json     # E2B
  cat ~/.config/kortix-opencode.json
  ```
  and a PTY session's `env`. **The `sudo` calls are the point** — the agent has `NOPASSWD:ALL` (`Dockerfile:96`), so the test must exercise root.

#### Docs / demo
- `docs/specs/2026-07-26-secret-delivery-policy.md` → supersede with `docs/specs/secret-delivery-strategy.md`. **Correct the Daytona `domainAllowList` claim at line 108** — the pinned SDK is CIDR-only (`networkBlockAll` + `networkAllowList`); there is no domain matcher and no 5-CIDR cap in the typings.
- **Correct `apps/api/src/llm-gateway/README.md:37`**, which claims provider env names are "withheld from opencode so the gateway is the only LLM path". Verified false: the opencode strip touches only the child's env (`opencode.ts:955` says so verbatim), and `BASH_ENV` re-injects the same keys into every `bash -c`.
- **Delete `apps/api/src/platform/sandbox-env.ts`** or wire it. Verified: `isForbiddenSandboxEnv` has **zero callers** and the file reads like the policy engine. Recommend deleting and replacing its doc comment with a pointer to `strategy.ts`.
- Add the Delivery section to the KaaB guide.

---

### Stage 2 — `broker(kortix_fetch)`: a universal path, still no CA (~2 weeks)

Makes `broker` work for *any* HTTP vendor API, not just the four existing named backends.

**New `apps/api/src/broker/`** — deliberately shaped like `apps/api/src/executor/` (thin `router.ts` + one-function `gateway.ts` core + injected deps, so it is testable with fakes):

`POST /v1/broker/fetch` `{ secret, method, url, headers?, body?, stream? }`, in order:
1. `resolvePrincipal` from `executor/db-deps.ts:750` **verbatim** (validates the token, lifts `{userId, accountId, projectId, sessionId, agentGrant}`, applies `resolveTokenBoundSessionId`).
2. Grant ∩ session allowlist; **null grant ⇒ deny** for non-`runtime` rows.
3. Load the row by identifier; 404 unless `strategy != 'runtime'`.
4. `matchRule` on **host + method + path** — never host alone. Plus the **SNI/Host-mismatch check** grafted from design 1.
5. `assertSafeEgressUrl` (`shared/ssrf-guard.ts:83`) with per-redirect-hop revalidation. The broker fetches an agent-influenced URL while holding a real credential — it is a confused-deputy SSRF primitive by construction. Note `executor/db-deps.ts:458` uses a bare `fetch`; that is only safe there because the destination is server-pinned. Do not copy it.
6. **Strip the injection slot unconditionally** from the caller's headers before attaching — the `applyConnectorHeaders` precedence rule (`execute.ts:244`), which is load-bearing here because the caller is the agent. Also drop hop-by-hop headers.
7. `applyAuth` — **extract `applyAuth` and `reservedAuthHeader` from `apps/api/src/executor/execute.ts` (lines 55 and 100; verified currently private) into `apps/api/src/executor/auth-inject.ts`** and import from both. `ExecutorAuth` (`execute.ts:15`) is already exported and *is* the strategy-per-secret vocabulary.
8. `redirect: 'manual'` (from `llm-proxy.ts:121`) — a 3xx returns as a 3xx, credential never re-attached; the follow-up must re-enter and re-match.
9. Stream with a **connect-phase-only** AbortController cleared the moment `fetch` resolves (`preview.ts:855-879` documents the regression where a whole-lifecycle `AbortSignal.timeout` severed every SSE body at 15s), `idleTimeout: 0`, `Accept-Encoding: identity` / `decompress:false`. Response scrub for the literal credential → 502 rather than echo it back.
10. Policy/approval: reuse `executor/policy.ts:170` unchanged (it matches arbitrary strings, so `stripe.POST:api.stripe.com/v1/charges` is as matchable as `stripe.charges.create`) and the 45s approval hold from `executor/gateway.ts:471`.
11. Audit to `executor_executions` with one added nullable `secret_id` column — best-effort, never fails the call (`gateway.ts:798`).
12. Rate/spend limit keyed on **`sessionId` and `origin_ref`**, not account. `KORTIX_BACKEND_PER_END_USER_SPEND_LIMIT_USD` (`config.ts:573`) already establishes `origin_ref` as a first-class metering key.

**Three sandbox-facing faces** (none is a boundary — all authenticate with a token the agent already holds; the security comes entirely from Stage 1):
- `kortix fetch` (`apps/cli/src/commands/fetch.ts`, curl-shaped) — already on PATH.
- A `fetch` meta-tool appended to `META_TOOLS` in `apps/cli/src/executor/mcp.ts` — zero registration work, `kortix-executor` is already wired into the opencode config (`opencode.ts:159-183`).
- **The localhost base-URL shim** at `127.0.0.1:4321` in the daemon, modelled on `llm-proxy.ts:65-166` but **holding no secret** — it forwards to `/v1/broker/fetch`. This is the adoption story: `ANTHROPIC_BASE_URL=http://127.0.0.1:4321/b/anthropic-prod` makes `new Anthropic()` work unmodified. It 400s on `placeholder_mismatch` if a *different* identifier's handle appears. **Its port must be added to `blockedPorts` in `proxy.ts:190`** — today only 8000 is blocked, which is why 4319/4320 are reachable from outside via `/v1/p/<id>/8000/proxy/4319/…`.
- `@kortix/sdk` exports `createBrokeredFetch(identifier)`.

**Also in Stage 2:** the UI. `apps/web/src/features/workspace/customize/sections/view/secrets-view.tsx` gains a **Delivery** column with one plain sentence per row ("Readable by the agent and by anything it runs" vs "Injected at `api.stripe.com` only. Never in the sandbox."), a rule builder running the *same* validator as the manifest and CLI, and a project banner counting `runtime` secrets with one-click migration seeded from the `router/config/proxy-services.ts:59-257` presets. Manifest `[env]` object form in `validateEnv` (`packages/manifest-schema/src/index.ts:498`) — accept string **or** object, backwards compatible.

**Tests:** broker unit tests for each disposition; SSRF/redirect/host-mismatch adversarial tests; `tests/src/flows/secret-strategy.flow.ts` `SDS-2` proving an in-box `kortix fetch` succeeds while a direct `curl` with the handle 401s at the vendor; a shim test proving cross-identifier handle reuse is refused.

---

### Stage 3 — `egress`: the broker + enforcement, proven on local-docker (~3 weeks)

The first stage where the founder's literal ask exists.

- **New deployable `apps/kortix-egress-broker/`** (Bun, own entrypoint): `listener.ts` (CONNECT + absolute-form), `tls.ts` (per-sandbox ephemeral CA, leaf minted per SNI, `tls: 'tunnel'` hosts get a blind pipe), `policy.ts` (Redis-cached compiled policy keyed on revision, bounded ≤5min staleness then fail-closed), `inject.ts` (the extracted `applyAuth` + `json_body_field`), `guard.ts`, `stream.ts`, `audit.ts`.
- **Sandbox identity:** a **new** `KORTIX_EGRESS_TOKEN`, never `KORTIX_SANDBOX_TOKEN`/`KORTIX_CLI_TOKEN`/`KORTIX_EXECUTOR_TOKEN` — those are deliberately written into every shell (`agent-env-file.ts:39-48`) and the sandbox token is also the daemon's HMAC key (`kortix-user-context.ts:49`). Source-IP pinned where the provider gives an authoritative one.
- **Broker control vars ride `buildSessionRuntimeEnv`** (`session-runtime-env.ts:24`) — exempt from the `KORTIX_`/`OPENCODE_` strip that would otherwise drop them twice — and are added to `SERVER_OWNED_ENV_NAMES` (`session-runtime-context.ts:25`) so Slack/Teams/Email `extraEnvVars` callers cannot forge or erase them.
- **Enforcement on local-docker:** `ensureNetwork` (`local-docker.ts:148`) creates a second network with `Internal: true`; HostConfig (`local-docker.ts:285`) gets `NetworkMode: 'kortix-egress'` + **`CapDrop: ['NET_ADMIN','NET_RAW']`** (today it sets none) + `Dns: [brokerIp]`. The broker container bridges. Genuinely non-bypassable: Docker's default cap set excludes `NET_ADMIN`.
- **CA:** public cert only, delivered as `KORTIX_EGRESS_CA_PEM` via `buildSessionRuntimeEnv`; installed in `apps/sandbox/entrypoint.sh`'s **pre-`setpriv` root window** (before line 39) via `update-ca-certificates`, plus the full trust-env battery. Base-image bump + snapshot re-bake.
- **`CreateSandboxOpts.egress`** + `SandboxProvider.sandboxFacingBrokerOrigin?()` mirroring `sandboxFacingApiOrigin?()` (`providers/index.ts:148`), **recomputed on every hot push** from the owning provider — a hoisted constant silently re-breaks same-machine providers on the next prompt (`sandbox-env-sync.ts:31` documents this exact bug for the gateway URL).
- **`supportsEgressEnforcement` capability flag** — session creation on a provider without it under `egress_mode: 'enforce'` is **refused**, never silently downgraded.
- **`observe` mode:** the broker accepts CONNECT for undeclared hosts, tunnels without injection, audits `decision='tunneled'` — so a project discovers its real egress footprint before flipping `on_no_match: deny`.
- New table `kortix.secret_egress_events` (`accountId, projectId, sessionId, endUserRef, secretId, identifier, strategy, backend, host, method, pathTemplate, matchedRuleIndex, decision, severity, upstreamStatus, bytes, latencyMs`) — the first real audit trail secrets have ever had. `GET /v1/projects/:id/secret-usage?identifier=&end_user_ref=`.

**Adversarial tests:** the nine dispositions as explicit cases; `unset HTTPS_PROXY && curl https://api.anthropic.com` from inside a local-docker box must yield a connection failure, **not** an uncredentialed request; `sudo iptables -F` then retry must still fail; CONNECT to an allowed host with a forged inner `Host` must 403; a handle from session A presented on session B's connection must 403 and page.

---

### Stage 4 — Daytona (~2-3 weeks)

`networkAllowList` + `networkBlockAll` at `daytona.create()` (`daytona.ts:219`), re-applied live via `sandbox.updateNetworkSettings()` on every hot push (verified in the pinned `@daytonaio/sdk`; the runner applies iptables **outside** the container). Broker gets **stable dedicated EIPs behind an NLB, off the Cloudflare path** — CONNECT and TLS re-origination do not survive the `api-router` Worker, and the allowlist is CIDR-only.

**Allowlist only the broker's `/32`s.** Route both Kortix hostnames — `${KORTIX_URL}` *and* the separately-hosted `LLM_GATEWAY_BASE_URL` (`gateway-dev.kortix.com`, `llm-gateway/sandbox-base-url.ts:24`) — *through* the broker as TUNNEL destinations. Forgetting the second hostname is the single most likely way a first lockdown breaks every session. Broker also serves UDP/53 on the same EIP. Ship `observe` first; a `broker_reachable` boot probe fails provisioning fast rather than hanging.

**Validate with Daytona before committing:** whether a server-side CIDR count cap exists. We need ≤4, so we survive either way.

---

### Stage 5 — Platinum (cross-repo; start the conversation during Stage 2)

Host-side nftables on the VM tap: `policy drop` on forward, accept only the broker, **plus transparent DNAT :80/:443 → broker** so no client needs to be proxy-aware. Requires a `network_policy` field on the create API in `github.com/kortix-ai/platinum`. This is the **schedule risk and the KaaB fast path**: `/etc/pt-env` puts the whole session env in cleartext on the *persisted* guest disk (`main.ts:491`), so deferring Platinum leaves the most-recommended KaaB path fully leaking. Stage 1 already fixes that for brokered secrets — which is precisely why Stage 1 must not wait on this.

---

### Stage 6 — teeth, and the KaaB per-end-user dimension

- **Per-prompt handle rotation** over the existing hot push with a 60s overlap, so an exfiltrated handle is dead within one turn. This is the single best answer to off-box replay on Daytona.
- Approval-gated egress; per-`end_user_ref` rate + spend caps; the security console over `secret_egress_events`.
- **Relax the mid-session agent-switch 409** (`secret-grant.ts:20`) for sessions where every granted secret is non-`runtime` — narrowing now takes effect on the next outbound call. A user-visible product win falling out of the security work.
- Bridge brokered secrets to the `(owner_type, owner_id)` dimension `executor_connection_profiles` already has (`kortix.ts:3786`) and `project_secrets` lacks, with a **server-side requirement that `owner_id == session.origin_ref`** — closing the hole the connector path currently has, where `validateSessionConnectorBindings` (`session-connector-bindings.ts:193`) accepts any non-member profile and the call-time recheck (`:451`) only re-verifies member-owned ones.

### Parallel track — independently sufficient to sink KaaB, fixed by none of the above

Each is small and should be scheduled alongside, not after:
- `GET /v1/projects/:id/git/clone-credential` returns the **raw** provider token to a sandbox-kind key (`r3.ts:300`); `KORTIX_GIT_PROXY` defaults **false** (`config.ts:222`).
- `buildGitAuthArgs` puts the token in argv (`git.ts:181`); the git credential helper is an in-box oracle (`git.ts:448`).
- 4319/4320 reachable from outside via `/proxy/<port>` (`proxy.ts:190`).
- KaaB session visibility resolves against a shared `created_by` (`session-inventory.ts:114`) — end-user A can list and open end-user B's sessions.
- Task #21 on the board: the actor-context claim is HMAC'd with the sandbox's own bearer (`actor-context.ts:76`).

---

## 5. What this will NOT protect against — say it plainly in the docs

1. **It stops key theft, not capability abuse.** A prompt-injected agent still spends the credential against the declared host and route. Bounded by host+method+path rules, policy/approval and rate caps. Not eliminated.
2. **Kortix's own session credentials stay readable.** `KORTIX_TOKEN` / `KORTIX_CLI_TOKEN` / `KORTIX_EXECUTOR_TOKEN` / `KORTIX_SANDBOX_TOKEN` are deliberately in every shell (`agent-env-file.ts:39-48`); `KORTIX_LLM_API_KEY` **is** the executor PAT (`session-sandbox.ts:433`). With a null agent grant that token carries the wrapper's full project authority.
3. **Non-HTTP secrets are out of scope.** A Postgres password, an SSH key, an SMTP credential has no header to inject into. They stay `runtime` — visible and honestly labelled — or `denied`.
4. **Anything ever delivered as `runtime` must be rotated, not merely re-scoped.** There is no retraction path at any provider (`daytona.ts:222`; `start()` at `:278` never re-sends), and the daemon's `process.env` keeps boot values for the life of the box.
5. **`sandbox.on_boot` persistence.** `main.ts:266` runs `bash -lc` with the daemon's full env every boot, before any prompt, and the agent can write the repo. One injection is a permanent, cross-end-user compromise. This is why strategy lives in the DB with a sandbox-write gate, and the manifest may only *strengthen*.
6. **KaaB cross-end-user session isolation is a separate, unfixed problem.**
7. **v1 gives every end-user the *wrapper's* key.** `project_secrets` has no `(owner_type, owner_id)` dimension. Stage 6.
8. **Off-box replay** of a handle + token pair on Daytona/E2B until session end (per-prompt rotation in Stage 6 shrinks it to one turn; only local-docker and Platinum give topological binding).
9. **Cert-pinned clients on `egress` hosts cannot work** — per-host `tls: 'tunnel'` is the documented escape, and it disables injection loudly.
10. **Single static encryption key.** One `API_KEY_SECRET`, `v1`-only envelope, no key id (`secrets.ts:50`). The broker decrypts on the request path and inherits that blast radius.

---

## 6. Decisions for the founder

1. **Do service-account-created (KaaB) projects default to `secret_default_strategy = 'denied'`?** — **Recommend YES.** It is the difference between a feature people enable and a platform that is correct out of the box: an undeclared secret in a KaaB project exists but has no path until someone declares one. Costs nothing for existing projects (default stays `runtime`).
2. **Do we build `egress` (TLS-terminating MITM) at all, or stop at `broker`?** — **Recommend: build it, per-project opt-in, and make `broker` the recommended default.** `broker` covers most real usage via `base_url_env` with zero CA and zero enterprise pushback; `egress` is for the tail of unmodifiable third-party code. Some enterprises will refuse a CA outright and must remain fully served by `broker` + `denied`.
3. **Auto-upgrading existing gateway-managed provider keys to `broker(llm_gateway)`** — flag day or opt-in? — **Recommend opt-in per project, then flip the default after a soak.** Removing the native key does not merely *permit* gateway routing, it **forces** it (`acp/harness-registry.ts:141` actively prefers a native key when present), and `LLM_GATEWAY_ENABLED` defaults false (`config.ts:329`), so self-host must keep the keys.
4. **Platinum host-agent egress work** — is that team available in the next quarter? This is the only cross-repo dependency and it gates the KaaB fast path's `egress` story. **Recommend: start the conversation during Stage 2.** Stage 1 already removes the value from `/etc/pt-env`, so this is not a blocker for shipping real security.
5. **Flip `KORTIX_GIT_PROXY` to default true?** — **Recommend YES, as a standalone PR.** It is the already-built server-side git-credential broker sitting dark, and it is the closest existing analogue to this whole project.
6. **Separate `KORTIX_LLM_API_KEY` from the executor PAT?** — **Recommend YES, as a sibling project.** Until they differ, "route LLM through the gateway" bounds neither spend nor out-of-turn use, and per-end-user spend caps (task #18) cannot be enforced against a token the agent holds. This plan depends on it for meaningful abuse control but does not deliver it.
7. **Do we relax the mid-session agent-switch 409 for all-brokered sessions?** — **Recommend YES, in Stage 6.** The 409 exists *only* because injected values are irretrievable; that reasoning genuinely no longer applies.

---

## Correction — verified by hand after the design pass

The *Parallel track* section lists open KaaB problems. Two were re-checked
directly against `main`:

**WRONG — "KaaB session visibility resolves against a shared `created_by`
(`session-inventory.ts:114`) — end-user A can list and open end-user B's
sessions."**

This is no longer true. `isSessionVisibleTo`
([executor/share.ts](../apps/api/src/executor/share.ts)) carries an explicit
guard:

```ts
const sharedCreatorIsMeaningless =
  ownership.origin === 'backend' &&
  ownership.callerSessionId != null &&
  ownership.callerSessionId !== ownership.sessionId;
if (sharedCreatorIsMeaningless) return false;
```

A sandbox token is session-bound, so end-user A's agent reaching end-user B's
backend session returns `false` before any `created_by` or visibility check runs.
The call site at `session-inventory.ts` passes `callerSessionId` through. What
*does* still see every backend session is a caller that is **not** session-bound
— the wrapper's own operator credential and human project members — which is by
design.

The agent appears to have read the call site without following into `share.ts`.
Do not schedule work from that bullet.

**CONFIRMED — the git clone-credential leak.**
`GET /v1/projects/:id/git/clone-credential`
([routes/r3.ts](../apps/api/src/projects/routes/r3.ts)) returns
`auth: { username, token }` — the **raw provider token** — in its JSON body, and
`KORTIX_GIT_PROXY` is `optBoolFalse`
([config.ts](../apps/api/src/config.ts)), i.e. the server-side git-credential
broker that would avoid handing the token out is **built but dark by default**.
This is the same defect class as the env leak and is the closest existing
analogue to the whole SDS project.

**PARTIALLY CORRECTED — the actor-context claim (task #21).** The design pass is
right that `verifyActorContext(raw, bearer)` HMACs the claim with the same bearer
the caller presents, and that the sandbox exports that bearer into every agent
shell. But the impact is smaller than "cap evasion": the cap check at
`router/routes/llm.ts` runs inside `if (actor) { … }`, so a caller that simply
**omits** the header is never capped at all. Forging is not the evasion path —
omitting is. The real defects are (1) an accounting control a hostile sandbox can
opt out of, and (2) forgeable spend *attribution* to another member's `userId`.
