# Kortix Control Plane & Auth — one API, one token, every client

**Status:** North-star / plan of record (opinionated) — Marko + Eno, 2026-07-08.
Decisions, not options. Execution is phased and lands as small PRs behind the gates in §7.
**Consolidates / builds on:**
- `docs/specs/2026-07-08-one-kortix-token-and-cli-centric-platform.md` (the one-token identity model + CLI↔web parity — absorbed as-is; this doc is its umbrella)
- `docs/specs/2026-06-28-token-session-agent-identity.md` (token/session/agent identity)
- `docs/specs/2026-07-05-agent-first-config-unification.md` (the agent is the unit of identity/authz/config)
- `docs/specs/2026-06-28-project-authorization-runtime-governance.md` (IAM actions)
- `docs/specs/2026-07-08-session-work-submission.md` (`kortix submit` — the first worked example of a primitive done "the matrix way", §6)

---

## 0. Thesis

**A Kortix is one control-plane API. The CLI is the first thin client over it; MCP is
the second; a local agent, another app, or CI are more. They differ only in transport —
they share one API and one authorization function.** You should only ever need *the
Kortix token* (via CLI or, later, MCP) to fully use and configure your Kortix — every
primitive, from anywhere, with the token deciding what you can do.

Three properties fall out cleanly once framed this way, each owned by a different layer:

| You want… | is a property of… |
| --- | --- |
| CRUD every primitive (agents, skills, memories, schedules, webhooks, sessions, connectors, secrets, files) | the **API surface** (completeness) |
| use/configure Kortix from anywhere | the **token** (a scoped credential you hand any client) |
| "holds context on Kortix + how to use it, including base skills" | **self-description** (the API/CLI carries its own manifest + knowledge) |
| "Kortix magic gated by auth-level" | the **intersection** `cap ∩ scope` — the surface is total; the token picks the subset |

The rest of this doc makes each pillar a decision.

## 1. Pillar 1 — Auth (decided)

Auth is load-bearing: every other pillar is downstream of it, so it is settled first.

### 1.1 One token family, capability = claims, one authorization function

A **Kortix token** (`kortix_pat_`, one table `account_tokens`) is defined by claims, not
by prefix proliferation:

```text
principal:   user_id XOR service_account_id     (who acts — nothing else)
cap:         the principal's IAM role            (the ceiling; never exceeded)
scope:       optional narrowing claims:
               project_id?   — narrow to one project
               session_id?   — narrow to one session
               agent?        — whose grant (kortixCli/connectors/env) applies
               llm_only?     — LLM proxy only, no CRUD
               expiry        — PAT policy or session lifetime
```

Every request — CLI, MCP, raw HTTP, web — resolves through **one** function:

```
effective = principal.role  ∩  scope.grant
```

There is no CLI-only, MCP-only, or web-only privilege path. This single invariant is what
makes "access it anyhow" safe: a new client is just a new transport in front of the same
gate. (Carries invariant #6 of the one-token spec.)

### 1.2 Scope only narrows, never widens

You never widen access by minting a token — you carve a *smaller* one. This is the entire
safety story for "use it from anywhere":

| Context | Principal | Cap (ceiling) |
| --- | --- | --- |
| Laptop / `kortix login` | you | your role |
| Sandbox session | the boot agent's service account | your role ∩ agent grant |
| Another app / local agent / MCP client | a service account (or scoped PAT) | its IAM policy / the narrowed grant you minted |
| Headless / CI | a service account | its IAM policy |
| Trigger/schedule-launched session | the agent's service account | the trigger's **pinned run-as owner** role ∩ agent grant (§1.5) |

Handing Kortix to some random local agent is safe *by construction*: it holds a token that
can do exactly its `cap ∩ scope` and no more.

### 1.3 Auth-level IS the token's claims — the API surface is total and uniform

Do **not** build "read-only mode" or "admin mode" as API variants. Build one complete API
where every primitive is CRUD-able, and let `cap ∩ scope` decide what actually goes through
(403 otherwise). "Depending on your auth-level" then needs zero special-casing — it is the
intersection. One surface, many effective subsets.

### 1.4 Minting is the real product surface

If identity is one token defined by claims, the UX that matters is *how you get the right
token for a context* — authentication is solved, **minting** is the feature:

- `kortix login` → you, on your laptop (full role, no narrowing).
- `kortix token create --project X --grant <actions> [--connectors …] [--expires …] [--llm-only]`
  → a scoped credential to paste into another app, an MCP config, or CI. **This command is
  the integration story** and deserves to be first-class and beautiful.
- Auto-mint at session birth → the agent (your role ∩ agent grant).

"Add Kortix to anything" = mint a scoped token and hand it over. Nothing else.

### 1.5 Two hard lines stay uncrossed; two open questions resolved

- The sandbox **machine token** (control-plane HMAC key) is not an identity and is never
  accepted as one.
- **Capability credentials** (setup links, public shares, SCIM, OAuth server tokens, the
  internal service key) are never accepted by the identity middleware.
- **Gateway keys** (`kortix_gw_`) → absorb into the family as an `llm_only` scope preset;
  presets are named claim-sets, not a separate credential type.
- **Trigger/schedule-launched sessions** → the trigger pins an explicit run-as owner at
  creation; that owner's role is the cap. No ambient "arbitrary account owner."

End state (from the one-token spec, kept): **6 identity types → 2** (Kortix token + browser
JWT); every non-identity credential documented with one sentence of why it survives.

## 2. Pillar 2 — One resource-complete API (the single point of contact)

The API is the single source of truth for a Kortix. For "one API that gives you your full
Kortix," every primitive must be a first-class REST resource with full CRUD, each verb
gated by an IAM action, each mapped 1:1 to a CLI verb (and, later, an MCP tool).

**The completeness matrix** — every primitive gets a row; a row is "done" only when all
columns exist:

| Primitive | REST resource | IAM actions | CLI verb | MCP tool (later) |
| --- | --- | --- | --- | --- |
| Agents | `…/agents` | `project.agent.read/write` | `kortix agents …` | generated |
| Skills | `…/skills` | `project.skill.read/write` | `kortix skills …` | generated |
| Memories | `…/memory` | `project.file.*` (files) | `kortix memory …` | generated |
| Schedules/Triggers | `…/triggers` | `project.trigger.*` | `kortix triggers …` | generated |
| Webhooks | `…/triggers` (webhook type) | `project.trigger.*` | `kortix triggers …` | generated |
| Sessions | `…/sessions` | `project.session.*` | `kortix sessions …` | generated |
| Connectors | `…/connectors` | `project.connector.*` | `kortix connectors/executor …` | generated |
| Secrets | `…/secrets` | `project.secret.*` | `kortix secrets …` | generated |
| Files / repo | `…/files`, git | `project.file.*`, `project.gitops.*` | `kortix files …` | generated |
| Change requests | `…/change-requests` | `project.cr.*` | `kortix cr …` | generated |
| Work submissions | `…/review/items` | `project.review.*` | `kortix submit` | generated |

**Enforced by the parity gate**: CI fails when a new API route lands without a CLI mapping
(or a documented exemption), keyed off `routes.generated.json`. This is what keeps the
matrix true over time instead of drifting. (Track B of the one-token spec.)

Gaps to close are the audit in that spec's "Parity gaps" section — this doc adopts them as
the backlog, not a new list.

## 3. Pillar 3 — Self-describing: the CLI carries the knowledge, not just the commands

"You only ever need the Kortix CLI to fully use and configure Kortix" requires the CLI to
*carry the knowledge*, so an agent handed only the CLI can bootstrap:

1. **Machine-readable capability manifest.** Extend `kortix schema` (today: the manifest
   schema) into a full description of the API: every resource, verb, IAM action, and input
   schema. This is the contract every client reads.
2. **Base skills via the CLI.** The `kortix-system` family (and the CLI reference itself)
   are retrievable *from the CLI* (`kortix skills …` / a docs surface), so the knowledge
   travels with the tool, not only with a repo template. An external agent can pull "how
   Kortix works + how to drive it" from the one binary it was given.

**MCP is a generated projection, not a second build.** An MCP server introspects the same
capability manifest to generate its tools, and ships the same base skills as resources.
That is precisely why CLI-first is not a detour from the MCP vision: do the API + manifest +
skills once, and every MCP-compatible surface lights up for free.

## 4. What this changes about how we build primitives

Every new primitive is added "the matrix way": REST resource + IAM action per verb + CLI
verb + spec row, all in one change, tested, parity-gate green. `kortix submit`
(`docs/specs/2026-07-08-session-work-submission.md`) is the first worked example — its
token-derived session binding (§3.4 there) is exactly the auth model in §1 applied to one
resource, and it is a row in the §2 matrix. New work references *this* doc for the model
and that doc for the pattern.

## 5. Non-goals / what NOT to do

- **No big-bang.** This touches identity, every route, and the security model. It lands as
  small PRs behind the phases and verification gates of the one-token spec — never one
  sweeping refactor.
- **No CLI-only or MCP-only capability.** If a client can do something the web can't (or
  vice versa), that's a bug in the model, not a feature.
- **No new credential types.** Every "new" auth need is a claim-set (preset) on the one
  family, or it's a documented non-identity capability credential — never a new prefix.
- **No widening tokens.** Minting always narrows.

## 6. Execution — how the two tracks compose

- **Track A (identity):** the one-token spec's phases A0–A3 (hygiene → per-agent identity →
  one mint/list/revoke surface → env-var rename). §1 here is the decided target for that
  track; §1.5 resolves its open questions #1 and #3.
- **Track B (CLI-centric + completeness):** the one-token spec's phases B0–B2 (always-bound
  project → minimal keystrokes to a live session → web↔CLI parity program). §2's matrix +
  parity gate is the acceptance criterion.
- **Track C (self-description), new here:** the capability manifest (`kortix schema`
  extension) + base-skills-via-CLI. Prereq for the MCP projection; can proceed in parallel
  once the manifest shape is agreed.

## 7. Verification gates (adopted + added)

Carries the one-token spec's gates (one identity token per sandbox; two `KORTIX_*` secrets;
agent-switch re-mint + audit; SA can drive every `combinedAuth` route it has policies for;
fresh-laptop → live session in minimal keystrokes; CI parity gate; `token_context` parity).
**Added here:**

1. `kortix schema --api` emits a complete, machine-readable capability manifest; a test
   asserts every route in `routes.generated.json` appears in it (or is exempt with a reason).
2. Every primitive in the §2 matrix has all four (REST, IAM action, CLI verb, spec row);
   CI fails a new route with no CLI mapping.
3. A scoped token minted with `kortix token create` can perform exactly its `cap ∩ scope`
   and 403s on everything else — proven by a test that mints a narrow token and exercises
   both an allowed and a denied verb.
4. An agent handed only the CLI can retrieve the base Kortix knowledge/skills from it
   (`kortix skills`/docs surface returns kortix-system content).

## 8. Open questions

1. The bare-`kortix` one-command session UX (vercel-style, no verb once logged-in+bound) —
   inherited from the one-token spec OQ#2; decide in Track B.
2. Per-token IP/network claims (enterprise) while reshaping the table — one-token spec OQ#4.
3. Capability-manifest format: reuse the OpenAPI the API already emits vs a Kortix-native
   descriptor optimized for CLI/MCP generation. (Lean: derive from OpenAPI + IAM-action
   annotations so there's one source.)
