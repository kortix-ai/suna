# Kortix as a Backend (KaaB) — v1 Plan

Status: Draft for review · rev 2 (verified against current `main`)

## 0. TL;DR

**The ask:** let a third party wrap Kortix as a backend — many end-users on **one shared agent + repo**, each bringing **their own** connectors, model, and context, passed **at session start**, overriding the agent's defaults.

**The finding (verified in-repo):** ~80% of this **already ships**. The session-create contract already accepts per-session overrides, by reference, broker-safe. This is **activation + two small gaps**, not a rewrite.

**The shape:** a session is `{ config-with-optional-overrides, provenance }`. **Origin** decides who may override what and how the session behaves; **overrides** carry references; the broker resolves them server-side. Internal Kortix = `origin: user`, no overrides → **byte-identical to today**. Not a mode toggle — one pipeline, policy branches on the origin enum.

## 1. Already works today (use it now)

Session create — `POST /v1/projects/:id/sessions` ([contract `index.ts:298`, `.strict()`](../packages/api-contract/src/index.ts); core [`lib/sessions.ts:434`](../apps/api/src/projects/lib/sessions.ts)) — already accepts and overrides-over-defaults:

| Dimension | Field today | Safe because | Gotcha |
| --- | --- | --- | --- |
| **Connectors** | `connector_bindings: {alias: {profile_id}}` | broker resolves per gateway call (`resolveSessionConnectorProfile(sessionId, alias)`); session binding beats default; **credential never enters the request or sandbox** | **all-or-nothing**: bind any → every *unbound* alias goes null (§4.1) |
| **Model** | `opencode_model` | inline id, not a secret; catalog-validated | must be opencode ref form `kortix/<id>` — a bare wire id **silently drops** to default |
| **Agent** | `agent_name` | per-resource `agent.read` gate | soft-bound — the runtime prompt's `agent` can still switch it (still grant-gated) |
| **End-user context** | `runtime_context` (scalar map) | credential-like keys regex-rejected → `KORTIX_SESSION_CONTEXT` env | non-secret only; 64 keys / 16KB cap |

Connectors are already **user-owned profiles decoupled from the agent** (`executor_connection_profiles` + encrypted `executor_credentials`, migration `20260712190000000`). **That is exactly "each user brings their own, pass the reference."**

## 2. Auth — how the wrapper connects

**Kortix authenticates the wrapper; the wrapper vouches for its end-user.** (Stripe-Connect / Twilio-subaccount model.)

- **Caller = a Service Account token (`kortix_sa_`)** — a *machine* identity, held server-side, never exposed. IAM-scoped (deny-by-default governance) to exactly `session.start` + connector-profile management. Survives offboarding; auditable; independently revocable. **Not** a user PAT (ties to a person, over-privileged, and end-users aren't members) and **not** a raw API key (coarse, no policy). Service accounts already ship.
- **End-user identity = a parameter, not an auth principal** — the wrapper passes `origin_ref` (its own user id) + that user's `profile_id`s. Kortix records `origin: backend`, resolves *that user's* profiles, attributes usage to `origin_ref`. **End-users never authenticate to Kortix.** Scales to 100k with no per-user login and no subject-identity system.

**Developer UX (the whole integration):**
```
1. Tokens → New service account → paste kortix_sa_… into backend env        (once)
2. Attach policy: session.start + connector-profiles                        (least privilege)
3. Per end-user: store their credential once → get profile_id               (server-to-server)
4. POST /sessions  (Bearer kortix_sa_…)
   { agent_name, origin_ref:"user-123", connector_bindings:{ gmail:{profile_id} } }
```
Base case (shared agent, no per-user connectors) = steps 1–2 only.

**Direct streaming (optional):** to let an end-user's browser stream a session directly, the backend mints a **short-lived, session-scoped token** for that one session and hands *that* to the browser — never the `kortix_sa_` key. Governed by the existing PAT max-lifetime / idle-revoke policy.

## 3. The 3 gaps to build

1. **`origin` as a first-class field + policy gate** (the spine). Today it's informal (`metadata.source='trigger:cron'`). Promote to `origin: user|trigger|schedule|backend` + `origin_ref`, resolved once at create in `sessions.ts`. It gates **which override fields a caller may set** (only `backend` may set connector/secret refs; `user` only model) and **behavior** (approval relay, attribution). Small: column + resolve-at-create + a `canOverride(origin, field)` check.
2. **Secrets by reference** (the one net-new config dim). Merge a referenced secret bundle in **`resolveOwnerRawEnv`** (the hot-push path), not just boot (§4.2). Scope split: `connector`-scope = broker, never in sandbox = always safe; `runtime`-scope enters the sandbox = only safe while the wrapper **proxies chat** (end-users have no raw sandbox access).
3. **Skills subset** (v2-manifest only, mostly deferred). Intersect a requested subset with each agent's compiled `permission.skill` grant in `buildSessionSandboxEnvVars`. *Selecting* repo skills = clean; *injecting new* skills = untrusted code = out of scope.

**Enablers:** a **server-to-server connector-profile mint** for the wrapper; softening the **all-or-nothing binding** (a "bind these, inherit rest" mode).

## 4. Edge cases (the parts that bite)

**4.1 Connector all-or-nothing (verified).** Bind one connector and every unbound alias resolves null → that connector goes dark for the session. *Handling:* v1 — the mint API returns the agent's full connector set so the wrapper binds all; v1.1 — add an `inherit_unbound: true` mode. **Decide which.**

**4.2 Secret hot-push clobber (verified, the killer).** Every prompt re-pushes the project snapshot; a boot-only secret override reverts on turn 1. *Handling:* the merge MUST live in `resolveOwnerRawEnv`, not only boot. Non-negotiable.

**4.3 Session-sharing / resume identity leak.** A `backend` session resumed or viewed by a teammate (or the wrapper's own admin) must NOT resolve the *viewer's* profiles. *Handling:* **lock the resolved profile set to the session at start** (bindings are already session-rows) — never re-resolve by the current actor. `backend` sessions default `visibility: private`.

**4.4 Profile authorization (cross-tenant).** A service account referencing a `profile_id` it doesn't own must 403 (already: `validateSessionConnectorBindings`, same account+project+active). *Suggest:* also reject a profile for a connector the **agent isn't granted** (already: `agentMayUseConnector` fold) — keep both.

**4.5 Profile revoked mid-session.** End-user disconnects their Gmail while a session is live. *Handling:* the broker fails **closed** — a bound-but-revoked profile returns null, never falls back to the shared default (verified). The wrapper must surface "reconnect".

**4.6 Origin spoofing.** A user PAT must not be able to claim `origin: backend` or pass connector overrides. *Handling:* origin is **derived from the caller's token kind**, not accepted from the body; `canOverride` rejects out-of-envelope fields. `origin_ref` is trusted only from a service-account caller.

**4.7 Model not servable / wrong form.** *Handling:* normalize via `toOpencodeModelRef` and **fail-fast** at create with `isModelServableForAccount` (reuses the request-time resolver) — never silently fall to default.

**4.8 Idempotent retries.** Session create already takes an idempotency key; a retried start must not double-create or double-charge. *Handling:* require the wrapper to send it; document it.

**4.9 Warm-pool / snapshot reuse.** A recycled warm sandbox must not carry a prior session's overridden env/secrets. *Verify:* env is (re)pushed per session at boot + hot-push — confirm no residual from the pool image before GA.

**4.10 Per-end-user cost & concurrency.** Caps are account-level (`enforceAccountCap`); one end-user could exhaust the account cap and block others. *v1:* usage is attributed per `origin_ref`; the wrapper reads it and cuts off upstream. *Later:* native per-`origin_ref` cap + concurrency in the gateway pre-flight (the one thing the earlier subject-metering idea is still good for).

**4.11 Trigger/webhook on behalf of an end-user.** A webhook that should run as end-user X needs `origin: trigger` **plus** X's `origin_ref` + profile binding. *Suggest:* let a trigger carry an `origin_ref` + connector bindings so origin and overrides compose — the wrapper's most powerful pattern (event → the right user's session).

## 5. Build order

1. `origin` field + resolver + `canOverride` policy gate — the spine.
2. Document + expose the shipping path (connectors/model/agent/context) as the "backend" contract, with §4 gotchas. **This alone makes base-agent wrapping real today.**
3. Server-to-server connector-profile mint + all-or-nothing softening (4.1).
4. Secret-bundle by reference — hot-push merge + scope split (4.2).
5. Skills subset (v2, optional).

Each new contract field needs a schema add + a ke2e route-coverage test (the `.strict()` contract + coverage gate); transport is free (body flows verbatim to the core).

## 6. Open decisions

1. **All-or-nothing vs inherit-unbound** connector binding (4.1) — pick the default.
2. **Runtime-secret overrides**: allow at all in v1, or connector-scope only until untrusted-sandbox hardening exists?
3. **Native per-`origin_ref` caps/concurrency** (4.10) — v1 (wrapper-enforced) or build now?

## 7. Explicitly out of scope (v1)

Per-end-user **custom code** (new skills/executors — untrusted code); per-end-user **file/memory state** + the release/overlay machinery (a proxying wrapper doesn't need it); a Kortix-hosted end-user UI. These return only if a wrapper needs untrusted **direct** sandbox access — a later phase, not now.
