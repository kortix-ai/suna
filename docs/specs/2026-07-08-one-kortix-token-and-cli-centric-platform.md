# One Kortix Token + CLI-Centric Platform

Status: working document
Date: 2026-07-08
Owner: Kortix product/infra
Umbrella: `docs/specs/2026-07-08-kortix-control-plane-and-auth.md` — the north-star
(one control-plane API; CLI/MCP as thin auth-gated clients; self-describing CLI) that
absorbs this doc's identity model as-is and resolves its open questions #1 and #3.
Related: `docs/specs/2026-06-28-token-session-agent-identity.md`,
`docs/specs/2026-06-28-project-authorization-runtime-governance.md`,
`docs/specs/2026-07-05-agent-first-config-unification.md`

## Purpose

Two threads, one plan:

1. **One token.** The platform has accumulated 17 distinct credential types.
   Collapse identity down to a single token family with claims, so that the
   mental model is: *one Kortix token; on your laptop it is you, inside a
   sandbox it is the agent (capped by you), headless it is a service account.*
2. **CLI-centric.** Every action possible in the web UI must be possible via
   the CLI — which makes it possible for agents, because agents drive the CLI
   from sandboxes under the same authorization model. The CLI's project
   binding must be zero-friction: a global default project is always bound;
   a directory link overrides it; reaching a live cloud session takes as few
   keystrokes as possible.

These are the same problem: the CLI can only be safely exposed 100% to agents
once the identity model is one coherent token with enforceable per-agent
grants.

## Raw Prompt Input

```text
Overall, I want to make Kortix way more CLI-centric. You understand? Like, every single action that you take via the web UI, you should be able to take via the CLI as well. Which will allow the agent to also do 100% that. The only question I have is around the authorization model, of course, with that. But also, what I want to do is like make it very easy to just like type in Kortix. Have a model where always one project is clearly tied. Like, it doesn't have to be only the repo-based thing, but that you just have your global project which you tie to your Kortix-CLI. And then the, then the, if you run it from a certain directory, it will just overtake that, you know, like it will prioritize it rather. But, so that you can start like a new Kortix, for instance, open code from anywhere. So that the, and this is also flow I want to test and minimize the commands that you have to type in. So you can easily start like a cloud coding session, you know, that is just running open code without any hassle whatsoever, if you understand what I want to say. // Overall, making everything 100% CLI centric. My only question is around the authorization model because the CLI always requires a human. How is the authorization to the CLI, right? How does even the authorization to the sandbox look like? How many tokens is there? Can you check all the tokens? I want to refactor and make it one token, like just one. And like either this can be a human identity, like when you're running locally, right? Because like then you have the full human same scopes. But if you're running within the sandbox, like it's going to assume the selected agent identity, correct? How does it behave if we switch the agents? Like how is all this authorization propagated on what who has access to?

---

Yeah, the project binding model should even be should even be better like right when you install Kortix or like if you don't have a global project bound It should basically force you to do so or like you can skip it But like this the user experience should be so that this global project is always bound no matter what and it's like very nice and nice like on the CLI centric push can you hardcore make a plan on all the things we should be doing here? there's loads of fucking tokens. I can't fucking look through all of this like and then let's fundamentally refactor and optimize this. it's deeply complicated in my opinion.
```

## Current State (audited 2026-07-08)

### The full credential inventory — 17 types

Identity tokens (who is calling):

| # | Token | Prefix | Identity | Minted |
| --- | --- | --- | --- | --- |
| 1 | Supabase user JWT | (JWT) | human, browser | Supabase Auth |
| 2 | Personal access token | `kortix_pat_` | human, laptop/automation | `kortix login`, dashboard (`apps/api/src/accounts/core/tokens.ts`) |
| 3 | Session executor token | `kortix_pat_` + `session_id` + `agent_grant` + `service_account_id` (same `account_tokens` table) | launching user ∩ agent grant | every session provision (`mintExecutorToken`, `apps/api/src/platform/services/session-sandbox.ts:108`) |
| 4 | Sandbox daemon token | `kortix_sb_` | the daemon machine — no user identity | every session provision |
| 5 | Service account | `kortix_sa_` | non-human IAM principal | dashboard, or auto-minted identity-only per `[[agents]]` agent (secret discarded) |
| 6 | User API key | `kortix_` | the account, programmatic | dashboard API-keys page |

Non-identity credentials:

| # | Credential | What it is |
| --- | --- | --- |
| 7 | `kortix_gw_` gateway key | project-scoped external LLM access (`apps/api/src/llm-gateway/gateway-keys.ts`) |
| 8 | `kyolo_` YOLO member token | legacy billing attribution; **no longer injected** into sandboxes but still accepted by the gateway (`apps/api/src/billing/services/yolo-tokens.ts`) |
| 9 | `kortix_scim_` | IdP provisioning bearer (enterprise) |
| 10 | `kortix_tnl_` | tunnel machine credential (Computer connector) |
| 11 | `ksl_` setup link | stateless encrypted capability link (secret intake / connect) |
| 12 | `kps_` public share | anonymous session/preview share capability |
| 13 | `kortix_oat_` / `kortix_ort_` | Kortix-as-OAuth-server access/refresh for external clients |
| 14 | `X-Kortix-User-Context` | 60s-TTL HMAC header, signed with the sandbox token (not a bearer) |
| 15 | Session LLM token | HMAC token, single consumer route (`apps/api/src/shared/session-llm-token.ts`) — possibly dead |
| 16 | `INTERNAL_SERVICE_KEY` | gateway-pod ↔ API service-to-service secret |
| 17 | BYOK / third-party credentials | Codex auth.json, git credentials, connector secrets — proxied, never identity |

### Facts the refactor builds on

- **All identity tokens already converge to one principal shape** in one
  middleware (`apps/api/src/middleware/auth.ts` → `AuthVariables`). There is
  no per-token-type divergence downstream; only optional fields differ.
- **The session executor token already implements the "one token" model**:
  it is a `kortix_pat_` row with `project_id`, `session_id`, `agent_grant`,
  `service_account_id`. Locally the same prefix is a plain human PAT. The
  model is right; the sprawl is everything *around* it.
- **`KORTIX_LLM_API_KEY` is the same executor PAT** — the sandbox already
  authenticates to the LLM gateway with its one identity token.
- **Exactly two secrets matter inside a sandbox**: the identity token and the
  daemon machine token. But they are injected under **six names**
  (`KORTIX_CLI_TOKEN`/`KORTIX_EXECUTOR_TOKEN`; `KORTIX_SANDBOX_TOKEN`/
  `KORTIX_TOKEN`/`INTERNAL_SERVICE_KEY`/`TUNNEL_TOKEN` — the last three are
  one value, `apps/api/src/platform/services/sandbox-auth.ts:52-58`).
- **Agent switching is not enforced.** `KORTIX_ENFORCE_SESSION_AGENT_LOCK`
  defaults off (`apps/api/src/config.ts:146-153`); a switched agent inherits
  the boot agent's grant. The in-repo TODO says the correct fix is per-agent
  re-mint. The hot-swap mechanism to inject a re-minted token without an
  opencode restart **already exists** (`setExecutorProxyToken`,
  `apps/kortix-sandbox-agent-server/src/llm-proxy.ts`) — built for warm-fork
  restore, reusable for switch.
- **Acting identity is user∩grant, not the agent**, unless the agent's
  standing service account is "activated" (has ≥1 `iam_policies` binding), in
  which case the engine authorizes as SA∩grant
  (`resolveActingActor`, `apps/api/src/iam/engine-v2.ts:483-627`).
- **CLI project resolution already matches the desired model**:
  `--project` → sandbox env → `.kortix/link.json` → global default
  (`apps/cli/src/project-link.ts:89`). What's missing is the *always-bound*
  UX: `kortix login` never binds a project, and an unbound project is a
  dead-end error (`apps/cli/src/command-helpers.ts:59-64`) instead of an
  interactive picker.

### Known defects found in the audit

1. `kortix_sa_` bearers are only accepted by `supabaseAuth`, not
   `combinedAuth` — service accounts silently cannot call preview-proxy,
   cron, secrets, or SSE routes (`apps/api/src/middleware/auth.ts:143-174`
   vs `:346-575`).
2. OAuth access/refresh tokens and YOLO tokens are hashed with bare SHA-256;
   everything else uses peppered scrypt (`apps/api/src/oauth/index.ts:21-23`,
   `yolo-tokens.ts:31-33`).
3. `KORTIX_TOKEN` is overloaded: it aliases the *daemon* token today, and the
   in-code Phase-2 comment says it should eventually mean the *session*
   token (`session-sandbox.ts:347-349`). Until renamed, no reader can know
   which principal it is without checking sibling vars.
4. `kyolo_` mint/validate/attribute paths are still live with no known
   caller.
5. Session LLM token (`session-llm-token.ts`) has exactly one consumer route;
   likely dead.

## Target Model

### One identity token: "the Kortix token"

One token family (`kortix_pat_`, one table: `account_tokens`), defined by
claims, not by prefix proliferation:

```text
principal:  user_id XOR service_account_id      (who acts)
cap:        launching user's role                (never exceeded)
project_id: optional — narrows to one project
session_id: optional — narrows to one session
agent:      optional — the agent whose grant applies (kortixCli/connectors/env)
expiry:     per lifecycle policy (PAT) or session lifetime (executor)
```

Acting identity by context:

| Context | Principal | Cap |
| --- | --- | --- |
| Laptop / `kortix login` | you | your role |
| Sandbox session | the boot agent's standing service account | launching user's role ∩ agent grant |
| Headless automation / CI | a service account | its IAM policies |
| Trigger/schedule-launched session | the agent's service account | the trigger owner's role ∩ agent grant (open question #8 of the governance spec — resolve as part of Phase B2) |

A sandbox holds **exactly two secrets under exactly two names**: the Kortix
token (identity) and the sandbox machine token (control plane / HMAC key).
The machine token is deliberately NOT merged: it exists before and
independent of any user, is the proxy's HMAC signing key, and merging it
would give the agent daemon powers or the daemon user powers.

Everything else is a **capability credential**, explicitly enumerated and
documented as non-identity: setup links, public shares, SCIM, tunnel, OAuth
server tokens, user-context header, internal service key.

### Kill / absorb list

| Credential | Fate |
| --- | --- |
| `kyolo_` | delete (confirm zero live callers first) |
| Session LLM token | delete or wire properly (confirm consumer) |
| `KORTIX_TOKEN`, `KORTIX_EXECUTOR_TOKEN`, `INTERNAL_SERVICE_KEY`+`TUNNEL_TOKEN` in-sandbox aliases | rename to the two canonical names; drop aliases (new sandbox images only — same rollout caveat as the opencode-wedge fix) |
| `kortix_` user API key | absorb into the token family: it is a PAT (or SA token) with no narrowing claims |
| `kortix_gw_` gateway key | absorb: a project-scoped token whose grant is LLM-only (`kortixCli: [], connectors: [], llm: true`) — gateway already accepts PATs, so this is a mint-surface change, not an auth change |
| `kortix_sa_` bearer | keep the principal, unify the credential: an SA-owned row in `account_tokens` (`principal_type` column) so minting/listing/revocation/expiry policy is one system |
| Supabase JWT | keep — browser-only, third-party minted, already converges at middleware |

End state: **6 identity types → 2** (Kortix token + browser JWT), and the
non-identity credentials each documented with one sentence of why they exist.

## Plan — Track A: identity refactor

### Phase A0 — hygiene and dead code (small PRs, no behavior change)

- [ ] Remove `kyolo_` mint/validate/attribute (verify no live tokens
      presented in gateway logs first).
- [ ] Remove or properly wire `session-llm-token.ts`.
- [x] Accept `kortix_sa_` in `combinedAuth` (or document the restriction as
      intentional — decide, don't leave implicit). **Shipped: PR #4298.**
- [ ] Consistency pass on token hashing: scrypt+pepper for OAuth
      access/refresh tokens (migration: hash-on-next-use or rotate).
- [ ] `token_context` on `/accounts/me` covers every token type; `kortix
      token` prints it for all of them (identity probe parity).

### Phase A1 — per-agent identity (the real security refactor)

Closes the agent-switch hole and turns switching into a feature:

- [ ] Mint the executor token per (session, **agent**) instead of per
      session.
- [ ] On a prompt requesting a different declared agent: instead of 409,
      re-mint a token for that agent's grant and hot-swap it into the
      in-sandbox credential proxy (`setExecutorProxyToken` /
      `setLlmProxyToken` — mechanism exists) before the prompt reaches tool
      execution. Persist `project_sessions.agent_name`.
- [ ] Undeclared agent in a governed project → reject (existing
      default-deny / `AGENT_NOT_DECLARED` paths).
- [ ] Revoke the previous agent's token on switch (one live identity token
      per sandbox at any moment).
- [ ] Delete `KORTIX_ENFORCE_SESSION_AGENT_LOCK` (the lock becomes
      unnecessary: switching is safe because identity follows the agent).
- [ ] Flip the default acting identity: session tokens authorize as the
      agent's standing SA ∩ launching-user cap (today SA identity is opt-in
      via "activation"). Backfill standing SAs for existing `[[agents]]`.
- [ ] Audit event per switch: who, from-agent, to-agent, token ids.

### Phase A2 — one mint/list/revoke surface

- [ ] `account_tokens.principal_type` (`user` | `service_account`); migrate
      `kortix_sa_` bearer validation onto the same path.
- [ ] Absorb user API keys: new mints create claims-less PATs; `kortix_`
      validation kept for existing rows until rotated (status column tracks
      legacy).
- [ ] Absorb gateway keys the same way (LLM-only grant claim).
- [ ] One dashboard page + one CLI surface (`kortix token ls/mint/revoke`)
      for every token the account has issued, with provenance
      (login/session/manual/gateway) visible per row.
- [ ] SDK: one `KortixToken` type; kill per-credential client paths.

### Phase A3 — env var rename completion

- [ ] Sandbox env: exactly `KORTIX_TOKEN` (identity — the agent's token) and
      `KORTIX_SANDBOX_TOKEN` (machine). Bake new images accepting both old
      and new names first, flip injection second, drop aliases third
      (three releases; old sandboxes keep working throughout).
- [ ] CLI auth resolution order updated accordingly and documented in one
      place.

## Plan — Track B: CLI-centric platform (parallel)

### Phase B0 — always-bound project UX

- [x] `kortix login` ends by binding a global default project: if the
      account has projects, interactive picker (single project =
      auto-bind); if none, offer `kortix init` / create; `--no-project` and
      non-TTY skip cleanly. **Shipped: PR #4297.**
- [x] Unbound project + TTY = inline picker, not a dead end: replace the
      `No project linked.` error in `resolveProjectContext` with the same
      picker, offering to save the choice as the global default. Non-TTY
      (agents, CI) keeps the hard error. **Shipped: PR #4297** (single
      project auto-binds even non-TTY; multi-project non-TTY keeps the
      error).
- [ ] `kortix` bare landing shows the bound project prominently (it already
      shows host/account/project context) and says how to switch.
- [ ] `kortix projects use` (already interactive) advertised as the switch
      verb everywhere the binding is surfaced.

### Phase B1 — minimal keystrokes to a live session

**Status 2026-07-08: composite verb DEFERRED by Marko.** A top-level
one-command verb (create session → wait → attach OpenCode) was prototyped as
`kortix code` and rejected: sessions are general work sessions, not coding
sessions — no coding terminology anywhere in the product surface — and no
name felt right (`work`, `connect`, `start` all considered). The flow exists
today as `kortix sessions new --wait` + `kortix sessions connect`; revisit
the composite verb only when a name earns its place.

- [ ] Measure and minimize keystrokes-to-session as a tracked UX metric
      (target: installed+logged-in user reaches a live cloud session with
      one short command, zero flags).
- [ ] (deferred) composite verb wrapping `sessions new --wait` +
      `sessions connect`; naming TBD, nothing code-flavored.

### Phase B2 — web↔CLI parity program

Principle: the API is the product; web and CLI are both clients. A feature
is not shipped until both can do it — enforced mechanically, not by
review vigilance:

- [ ] Parity gap list (below) converted into `kortix` command work items,
      prioritized by what an agent driving the CLI needs first.
- [ ] **CLI coverage gate**: the ke2e route manifest already enumerates
      every API route; add a manifest annotation (`cli: <command>` or
      `cli: exempt(<reason>)`) and a CI gate that fails when a route ships
      without a CLI mapping — same mechanism as the route-coverage gate.
- [ ] Every CLI verb maps to an IAM action string (the `kortixCli` grant
      vocabulary). The grant vocabulary IS the CLI surface: adding a command
      means declaring its action string, which makes it grantable/deniable
      per agent for free. Gate this in the same manifest.
- [ ] `--json` on every read command; exit codes and error shapes uniform
      (agents parse these).

### Parity gaps (audit 2026-07-08)

The route manifest exists and is mechanically diffable:
`tests/spec/routes.generated.json` (466 routes) — the coverage gate above is
a manifest annotation away.

**Parity summary** (full audit in the PR description / session transcript):

| Area | Status |
| --- | --- |
| Projects, auth/hosts/accounts, sessions core, CR, triggers, secrets/env, connectors/executor, Slack channel, sandbox templates, marketplace core, LLM providers, per-agent model, project access, grants, IAM roles/policies, deployable apps, self-host, files (read) | **Parity** |
| Marketplace custom sources, access-requests, sandbox provider/live list, GitHub installation mgmt, custom LLM provider | Partial |
| Session sharing / commit-push / session audit | Full gap |
| **Session permission/approval + question replies** | Full gap |
| **Review Center (approvals/changes inbox)** | Full gap |
| Skills & commands as CLI verbs; file writes | Full gap (read-only by design today) |
| **LLM Gateway: keys, budgets, usage, logs** (13 routes) | Full gap |
| Full agent config editing (guided, validated) | Full gap (only `model` settable) |
| **Billing/credits/seats** (39 routes) | Full gap |
| **Enterprise IAM: groups, SSO, SCIM, service accounts, MFA/PAT/session policy, account audit + webhooks** (~40 routes) | Full gap |
| Email + Meet channels | Full gap (Slack only) |
| **PAT/CLI-token management** (`/v1/accounts/tokens*`) | Full gap — the web manages the CLI's own tokens; the CLI cannot |
| Tunnel/Computers management (20 routes) | Full gap |
| Account deletion, admin surfaces | Full gap (low priority) |

**Ranked by what an agent driving the CLI needs first:**

1. Session permission/approval + question-prompt replies — a CLI-driven
   session that pauses for permission is currently unanswerable from the
   CLI; it hangs. Highest impact. **Shipped: PR #4299** (`kortix sessions
   pending/approve/answer`); inline REPL prompts in `sessions chat` remain
   a follow-up.
2. Review Center inbox (`review/items`, `approvals`) — the async loop an
   orchestrating agent polls and acts on.
3. Skills/commands/file-writes as first-class verbs (`kortix skills`,
   `kortix commands`) — today requires raw git.
4. LLM gateway keys/budgets/usage — agents provisioning sub-tools or
   checking spend.
5. Guided agent-config editing (`kortix agents edit` with validation).
6. Billing/credits visibility (keep a project funded).
7. Session sharing + commit-push + session audit.
8. Enterprise IAM beyond roles.
9. Email/Meet channel management.
10. Token management, marketplace sources, sandbox provider pin, GitHub
    installation mgmt, tunnel management.

## Security Invariants (carried + new)

1. One live identity token per sandbox at any moment, bound to
   (project, session, agent).
2. Agent switch = new token minted for the target agent's grant before any
   tool executes under it; the old token is revoked.
3. An agent can never exceed the launching user's role (unchanged).
4. The sandbox machine token never carries user identity and is never
   accepted as one (unchanged, now explicit).
5. Capability credentials (shares, setup links, SCIM, tunnel, OAuth) are
   never accepted by the identity middleware.
6. Every CLI verb is authorized by the same IAM action strings that gate the
   web UI — no CLI-only privilege paths.
7. A browser session never receives a raw runtime credential (unchanged —
   clone-credential 403 for JWTs).

## Open Questions

1. Trigger/schedule-launched sessions: which user cap applies when no human
   launched? (Inherited from governance spec #8; must be answered in
   Phase A1 because SA-as-principal makes it acute.)
2. What is the right name for the deferred one-command session verb — and
   should it be the bare `kortix` behavior once logged-in+bound
   (vercel-style) instead of a verb at all? (No coding terminology.)
3. Gateway keys: absorb (A2) or keep as a separate product surface for
   external LLM-proxy customers who should never hold an identity token?
4. Do we want per-token IP/network claims (enterprise ask) while we're
   reshaping the table?

## Verification Gates

1. `rg kyolo_` returns only migrations/changelog.
2. A sandbox env dump shows exactly two `KORTIX_*` secrets.
3. Switching agents mid-session: `kortix token` inside the sandbox shows the
   new agent's grant; a connector allowed only to the old agent 403s; audit
   row exists.
4. A service account can drive every `combinedAuth` route it has policies
   for.
5. Fresh laptop: `curl install → kortix login → kortix sessions new --wait
   → kortix sessions connect` reaches a live cloud session with nothing else
   typed — login already bound the project.
6. CI fails when a new API route lands with neither a CLI mapping nor an
   exemption.
7. `/accounts/me token_context`, `kortix token`, and sandbox health report
   identical (project, session, agent) for any token.

## Near-Term Checklist

- [ ] Review this doc, strike/confirm the open questions.
- [ ] Phase A0 PRs (each independently shippable).
- [x] Phase B0 login/binding UX PR (small, high-visibility) — PR #4297.
- [ ] Spike: per-agent re-mint + hot-swap on a dev sandbox (Phase A1
      de-risk) — prove `setExecutorProxyToken` works for a live switch.
- [ ] Convert the parity table into tracked issues.
