# IAM — agent-centric access & inheritance (plan)

Turning the meeting notes into a grounded plan: what's real today, what the
"pyramid" idea actually solves, whether it makes sense, and how to build it.

> Source notes (verbatim)
> - use skills server-side with opencode.config
> - human → agent has resource → automatically human has that resource (inherit)
> - project level connectori (connectors)

---

## TL;DR

- **The pyramid idea is real and solves a genuine friction.** Today an agent's
  runtime access is `(launcher's own grants) ∩ (agent's declared needs)`, so to
  make an agent work for a person you must grant the resource **twice** — once
  to the agent (`kortix.toml`) and once to the human. Assigning the human to the
  agent and letting them **inherit** the agent's declared resources removes that
  double-grant.
- **But "human automatically HAS that resource" globally is over-permissive** —
  it defeats the per-agent containment we just built (a narrow agent's key would
  leak to the human everywhere). The safe form is **session-scoped inheritance**:
  assigning a human to an agent satisfies the agent's cap *for that agent's
  sessions*, not for the human's whole account.
- **Recommendation:** make the **agent the unit of capability** (it declares
  `env` / `connectors` / `skills` / `cli` in `kortix.toml`), assign
  **humans/departments → agents**, and inherit **session-scoped** by default with
  an explicit **"grant standalone"** opt-in when a person genuinely needs the
  resource outside the agent. Keep the "agent ⊆ launcher" cap as the security
  invariant; inheritance just auto-satisfies it.
- Skills and connectors both fold into this cleanly: they become per-agent
  declared capabilities that assigned humans inherit.

---

## What's real today (grounded in the code)

| Capability | Status | Where |
|---|---|---|
| Agent declares its resources (`env`, `connectors`, `kortix_cli`) | **Live** | `kortix.toml [[agents]]`; parsed in `agents.ts` |
| Per-agent env allowlist enforced at session boot | **Live** | `sessions.ts buildSessionSandboxEnvVars` |
| Agent capped at its launcher (standing identity ∩ launcher ∩ agentGrant) | **Live** | `iam/engine-v2.ts` |
| Assign an **agent → member/department** (who may use it) | **Live** | `iam_resource_grants` type `agent`; Resource-access card |
| Assign a **skill → member/department** | **Live** | `iam_resource_grants` type `skill` |
| Secrets shared to members/departments (one source of truth) | **Live** | share model (`project_secret_grants` + `share_scope`) |
| Connectors are **project-level** with share-scope + credential mode | **Live** | `executor_connectors.project_id` |
| Skills discovered from repo files (`.kortix/opencode/skills/*/SKILL.md`) | **Live** | `git/config.ts` |
| **Human inherits an agent's resources** | **Not built** | — |
| **Per-agent `skills` allowlist** (like `env`/`connectors`) | **Not built** | — |
| **Skills governed/run server-side via opencode config** | **Not built** | — |
| **Account-level connectors inherited by projects** | **Not built** | — |

**The friction that motivates the whole idea:** `buildSessionSandboxEnvVars`
resolves secrets **as the launching user** (`listProjectSecretsSnapshotForUser`)
and then narrows to the agent's `env` allowlist. So an agent only ever receives
`launcher_can_see ∩ agent_env`. If the human can't see `GITHUB_TOKEN`, declaring
`env = ["GITHUB_TOKEN"]` on the agent does nothing — the agent starves. Every
agent-for-a-person setup therefore needs the resource granted in two places.

---

## The pyramid, analysed

### The two directions (they are NOT the same)

1. **Cap (exists today):** `agent ⊆ human`. The agent can never exceed the person
   who launched it. This is a **security invariant** — it stops a prompt-injected
   agent from escalating past its operator. Keep it.
2. **Inherit (the note):** `human ⊇ agent`. The human gets the agent's declared
   resources. This is a **convenience** — it's what makes the cap *satisfiable*
   without double-granting.

They're compatible: inheritance grants the human exactly the agent's declared
set, so the cap is met for that set, and the cap still prevents the agent from
going beyond it. No circularity, because the agent's needs are **declared** in
`kortix.toml`, not themselves inherited.

### The security fork — how far does "human has that resource" reach?

| | Session-scoped (recommended) | Global |
|---|---|---|
| Meaning | Assigning Alice → `release-bot` lets **that agent** use its declared resources in **Alice's `release-bot` sessions** | Alice **has** `GITHUB_TOKEN` everywhere: her other agents, the Secrets UI, the API |
| Removes double-grant? | ✅ | ✅ |
| Keeps per-agent containment? | ✅ a narrow agent's key stays in that agent's sessions | ❌ the key leaks to the human broadly — defeats the point of per-agent scoping |
| Lets the human *see/edit* the secret value in the UI? | ✗ (needs an explicit visibility grant) | ✅ |
| Blast radius if the human is compromised | Small | Large |

**Recommendation:** default to **session-scoped**; offer an explicit
**"also grant standalone"** toggle on the assignment for the cases where a person
genuinely needs to see/use the resource outside the agent (e.g. to set a secret's
value). This gives the simplicity the note is after without silently widening
every operator's account.

### Does the pyramid "make sense"? — verdict

**Yes, as a management model layered on top of the existing grants**, not as a
replacement for them. Concretely:

- The **agent becomes a capability bundle** — effectively a role you can *see and
  reason about* ("release-bot needs github + the deploy connector + the release
  skill"). Assigning a person to it is one action instead of N resource grants.
- It composes with **departments**: assign a department → agent, everyone in it
  inherits, off-board by leaving the department.
- It does **not** remove the finer-grained grants — direct member/secret grants
  still exist for the exceptions. The pyramid is the *common path*.

The one thing to resist: making it the *only* path or making it **global** by
default. That would trade the containment we just shipped for convenience.

---

## Recommended target model

```
Department ──assigned──▶ Agent ──declares──▶ Resources (env · connectors · skills · cli)
    │                      ▲                        │
  members                  │                        │ inherit (session-scoped)
    │                      └───────assigned─────────┘
  Human ─────────────────────────────────────────▶ effective access when running that agent
```

- **Agent = capability bundle.** `kortix.toml [[agents]]` gains `skills = [...]`
  alongside the existing `env` / `connectors` / `kortix_cli`. Reviewed in-repo,
  auditable via `kortix validate`.
- **Assignment = human/department → agent** (reuse `iam_resource_grants` type
  `agent`, add an `inherit` flag / semantics).
- **Inheritance = session-scoped by default.** At session boot, the agent's
  declared resources are treated as granted to the launcher *for that session*,
  so the cap is auto-satisfied — no separate human grant needed.
- **Escape hatch:** an explicit "grant standalone" makes the resource visible/
  usable to the human outside the agent (writes the normal member grant / share).
- **Invariant preserved:** `agent ⊆ launcher` still holds; inheritance only
  raises the launcher's ceiling to include the agent's declared set.

---

## Note-by-note plan

### 1. Skills server-side via opencode config
- **Today:** skills are repo `SKILL.md` files run in the sandbox; scoped via
  `iam_resource_grants` type `skill`.
- **Target:** make skills a first-class **per-agent declared capability**
  (`[[agents]] skills = [...]`), governed server-side through the opencode config
  the same way connectors go through the Executor — so a skill can be enabled/
  audited centrally and **inherited** by humans assigned to the agent.
- **Needs clarification:** "server-side" = run the skill's tools through the
  Executor gateway (like connectors), or just *register/allowlist* them in
  opencode config while they still execute in-sandbox? The former is a larger
  build; the latter is a natural extension of the env/connector allowlist.

### 2. Inheritance (the pyramid) — core work
- Add per-agent **`skills`** allowlist to `kortix.toml` + parser + `kortix validate`.
- Add **assignment semantics**: human/dept → agent grant carries "inherit"; the
  Members UI gains an "Agents" way to assign people to agents (mirrors the
  Resource-access card, inverted).
- **Session-boot inheritance:** in `buildSessionSandboxEnvVars` (and the connector/
  skill resolvers), when the launcher is assigned to the agent, treat the agent's
  declared `env`/`connectors`/`skills` as granted for that session (union into the
  launcher's visible set *before* the agent-allowlist narrowing) — removing the
  double-grant.
- **Escape hatch:** "grant standalone" writes the normal member/secret grant.
- Preserve the `agent ⊆ launcher` cap and audit every inheritance in the audit log.

### 3. Project-level connectors
- **Today:** connectors are already per-project + declared per-agent
  (`[[agents]] connectors`). So most of this is **real**.
- **Target (fits the pyramid):** assigning a human to an agent inherits the
  agent's connector access (session-scoped), removing the connector double-grant
  too. Optionally add **account-level connectors** that projects inherit (define
  a connector once for the org; projects opt in) — this is the only genuinely new
  data model here, and only if the org-wide-connector need is real.

---

## Phasing

- **Phase 0 — decide the semantics** (this doc + a short review): session-scoped
  vs global default; skills "server-side" meaning; is account-level connector
  inheritance actually wanted?
- **Phase 1 — agent as capability bundle:** add `skills` to `[[agents]]` + parser
  + `kortix validate` surface + the read-only Agents-view scope card. Low risk,
  self-contained.
- **Phase 2 — assignment + inheritance (session-scoped):** human/dept → agent
  assignment UI; session-boot inheritance for `env` first (the proven friction),
  then connectors + skills. Behind a flag; heavy test coverage on the cap.
- **Phase 3 — escape hatch + audit:** "grant standalone" toggle, audit entries,
  drift/what-can-this-person-do surfacing.
- **Phase 4 (optional) — account-level connectors** if the org-wide need is real.

---

## Open questions for the team

1. **Global vs session-scoped inheritance** — default to session-scoped (safe) with
   an explicit standalone opt-in? (Strong recommendation: yes.)
2. **"Skills server-side"** — execute via the Executor gateway, or just allowlist
   in opencode config with in-sandbox execution?
3. **Is the pyramid the primary path or one of several?** Recommendation: primary
   for the common case, direct grants still available for exceptions.
4. **Account-level connectors** — real need, or are per-project connectors enough?
5. **Visibility vs use** — when a human is assigned to an agent, should they *see*
   the resource in the UI (e.g. a secret's existence/value) or only have it work
   at runtime? Ties into the escape hatch.
