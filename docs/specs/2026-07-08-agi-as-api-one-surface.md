# AGI as API — One Surface (API / CLI / MCP)

Status: working document
Date: 2026-07-08
Owner: Kortix product/infra
Related: `docs/specs/2026-07-08-one-kortix-token-and-cli-centric-platform.md`
(identity + parity program — this document is its endgame),
`docs/specs/2026-06-28-project-authorization-runtime-governance.md`

## Purpose

Kortix is an AGI you address like an API. One resource catalog — Agents,
Skills, Memories, Schedules, Webhooks, Sessions, Connectors, Secrets,
Channels, Files, Change Requests, … — exposed through **one** point of
contact with three projections: REST, CLI, MCP. Whatever authorization your
token carries, you can read, create, update, delete, and invoke everything
it allows, from anywhere — a terminal, a script, any MCP-compatible client,
another agent. The system is self-describing: the full `kortix-*` operating
knowledge loads into any context on demand.

The unification is generative, not vigilant: the CLI commands and MCP tools
are *derived* from the same typed catalog the REST routes implement, so a
resource that exists is automatically reachable from every interface.
Parity stops being a program of catch-up PRs (the 466-route audit in the
companion spec) and becomes a property of the architecture.

## Raw Prompt Input

```text
AGI as API
1 single API/CLI/MCP that allows u to CRUD Agents/Skills/Memories/Schedules/Webhooks/Sessions/Connectors/…etc… & all the other things
Like we should primarily think in that realm how do we have 1 SINGLE point of contact. 1 API u can just access anyhow & it gives u access to ur full Kortix meaning u can use & configure it from anywhere thats mcp compatible in some sense
 / What about an idea like this? Like, let's go, let's go deep there. Like, should we design this? Like, make everything API, CLI, MCP specific so that even the whole like files, etc. Like, depending on the authorization which you have as a user, can be updated from any interface anywhere. So, the whole git file system, like memory, gets exposed, you know, like the whole file system, all the skills, you can call agents, sub-agents, Kortix agents, you can create new triggers and all the different things you can do. We basically make the interaction always 100% CLI native, and that is the beauty of everything. You understand what I kind of want to say? We also make it possible, like all the Kortix system understanding, yada, yada, yada. Like, you can just get the info from the CLI, like load the system, like the skill info, etc., into your context. Yada yada.

---

all the kortix-*
```

## Current State (what this builds on)

- **466 REST routes** (`tests/spec/routes.generated.json`), organically
  shaped per feature. The CLI covers subsets by hand; the 2026-07-08 parity
  audit found whole zero-CLI clusters (billing, enterprise IAM, gateway,
  review center, tunnel, session sharing).
- **The CLI already speaks MCP** — but only for connectors:
  `kortix executor mcp` is a stdio compatibility face over the Executor
  gateway (`apps/cli/src/executor/mcp.ts`). There is no MCP projection of
  the platform itself (no create-trigger, no read-memory, no start-session
  tool).
- **@kortix/sdk is the single entry** for everything that talks to the
  backend (SDK single-entry migration, PR #4124) — the natural home for a
  typed resource catalog.
- **Files are read-only over the API**; writes are git-native only. Memory,
  skills, agents, commands are all files in the project repo, so "edit a
  skill from anywhere" today means "clone and push".
- **Identity/authorization**: the one-token model (companion spec) gives
  every caller the same principal shape with claims
  (user|SA, project?, session?, agent grant). The IAM action-string catalog
  (`apps/api/src/iam/actions.ts`) already names most resource·verb pairs.
- **The `kortix-*` knowledge bundle** — `kortix-system` (+ its references:
  `kortix-cli.md`, `kortix-toml.md`, `change-requests.md`,
  `marketplace.md`, `credentials-and-setup-links.md`), `kortix-executor`,
  `kortix-memory`, `kortix-slack` — lives in `packages/starter` templates
  and is only present *inside sandboxes*. Nothing serves it to an external
  client that wants to understand how to operate Kortix.

## The Design

### 1. The resource catalog is the product

A single typed registry (lives in `@kortix/sdk`, consumed by API, CLI, MCP,
and eventually the web UI) declares every resource kind once:

```ts
{
  kind: 'trigger',
  plural: 'triggers',
  schema: TriggerSchema,                    // zod — one source for validation + docs
  verbs: {
    list:   { action: 'project.trigger.read' },
    get:    { action: 'project.trigger.read' },
    create: { action: 'project.trigger.create' },
    update: { action: 'project.trigger.update' },
    delete: { action: 'project.trigger.delete' },
    fire:   { action: 'project.trigger.fire' },   // kind-specific verb
  },
  address: 'kortix://{project}/triggers/{name}',
}
```

Rules:

- **Every verb maps 1:1 to an IAM action string.** The catalog IS the
  authorization vocabulary. An agent grant, a role, a scoped MCP profile
  all speak the same names.
- **Kind-specific verbs are declared, not ad-hoc** (`fire`, `start`,
  `stop`, `merge`, `install`, `invoke`, `answer`) — a bounded set with
  uniform semantics (idempotency, error shape, `--json` output).
- **Uniform addressing** — `kortix://{project}/{kind}/{name}` names any
  resource from any interface, in links, audit rows, and MCP resource URIs.

### 2. Three projections, generated from the catalog

| Projection | Shape | Today → Endgame |
| --- | --- | --- |
| REST | `GET/POST/PATCH/DELETE /v1/projects/:id/{plural}[/:name]` + `POST …/:name/{verb}` | existing routes get *mapped* into the catalog first (no big-bang rewrite), new kinds are generated |
| CLI | `kortix {plural} {verb} [name] [--flags from schema]` | hand-written commands retire kind-by-kind as the generated grammar covers them; bespoke UX (chat REPL, `ship`, `init`) stays hand-crafted on top |
| MCP | one hosted server: tools `kortix_{kind}_{verb}` + resources `kortix://…` | replaces "executor-only" MCP; connector tools mount under the same server |

The MCP projection is what makes "use & configure your full Kortix from
anywhere that's MCP compatible" literal: point Claude/Cursor/any client at
`https://api.kortix.com/v1/mcp` with a Kortix token and the toolset you see
IS your authorization — nothing more, nothing less.

The CLI stays the human/agent-native face (`kortix triggers create …`), and
because both CLI and MCP are projections of the same catalog, the B2
"coverage gate" from the companion spec becomes transitional: the endgame
gate is *catalog completeness* (a route that isn't in the catalog fails CI),
and projections can't drift because they're derived.

### 3. Everything is a resource — including the file system

The project is a git repo, so files (and therefore **memory**, **skills**,
**commands**, **agent definitions**) become writable resources with
git-honest semantics:

- `files.write / files.delete` produce **commits**, never loose mutations.
- Where the commit lands is decided by the caller's authorization, using
  the governance spec's vocabulary: `git = write` → direct commit to the
  default branch; `git = cr` → auto-managed session branch + change
  request; less → 403. Same rule on every interface.
- `memory`, `skill`, `command`, `agent` are *typed views over files*: they
  address by name (`kortix://{project}/skills/{name}`), validate their
  schema (SKILL.md frontmatter, agent config fields), and land through the
  same policy-resolved commit path. Editing a skill from an MCP client and
  from `kortix skills edit` is the same operation.

This kills the biggest parity cliff in the audit (skills/commands/file
writes) with one mechanism instead of three bespoke ones.

### 4. Agents are callable — invocation is a verb

"You can call agents, sub-agents, Kortix agents" becomes a catalog verb:

- `agents.invoke` — start an **ephemeral session** with that agent, seeded
  with the prompt; return the session address immediately or block for the
  result (`--wait`, long-poll on the API, tool-call-with-progress on MCP).
- This is sugar over the existing session lifecycle, not a new runtime: one
  invoke = one isolated sandbox on its own branch, work lands via files/CRs.
  (Deliberately consistent with the settled shared-state architecture: no
  standing/canonical session; parallel ephemeral sessions over shared
  state.)
- Sessions themselves stay resources (`sessions.list/get/stop/answer/…` —
  the `pending/approve/answer` verbs shipped in PR #4299 slot in as
  kind-specific verbs on `session`).

So from any MCP client: `kortix_agents_invoke(agent: "veyris", prompt:
"…")` → your AGI does the work in an isolated sandbox and the result comes
back through the same surface. That is "AGI as API" in one sentence.

### 5. Self-describing: all the `kortix-*` knowledge, loadable anywhere

The system explains itself through the same surface it exposes:

- The full `kortix-*` bundle — `kortix-system` + its references,
  `kortix-executor`, `kortix-memory`, `kortix-slack` — is **served,
  versioned with the platform**, not only baked into sandbox images:
  - MCP **resources**: `kortix://system/{doc}` (clients pull exactly the
    operating knowledge they need into context).
  - CLI: `kortix system [topic]` prints the same docs (`kortix system`,
    `kortix system change-requests`, `--json` for agents).
  - REST: `GET /v1/system/docs[/:topic]`.
- The **catalog itself is introspectable**: `GET /v1/catalog` (and a
  `kortix_catalog` MCP tool) returns every kind, verb, schema, and required
  action — filtered to what the presenting token may do. A client can
  discover "what can I do here?" without documentation.
- `kortix token` / `token_context` already answer "who am I?"; catalog
  introspection answers "what can I touch?"; system docs answer "how does
  this all work?". Together: an agent lands with zero prior knowledge and
  bootstraps full Kortix competence from the surface itself.

### 6. Authorization is the filter, identically everywhere

- All three projections terminate in the **same API handlers** — the
  catalog registers them once. UI hiding, CLI availability, and MCP tool
  listing are all views of one decision: `authorize(principal, action,
  target)` from the existing IAM engine.
- The one-token model (companion spec) supplies the principal: human PAT →
  your role; session executor token → launching user ∩ agent grant; service
  account → its policies. **A scoped MCP profile is just a token** — no
  separate MCP permission system.
- Token claims narrow the visible catalog: a project-scoped token sees one
  project's resources; an agent-grant token sees only granted verbs. The
  MCP `tools/list` response is per-token, so a leaked narrow token exposes
  a narrow toolset.

## What this absorbs / supersedes

- **Track B2 parity program** (companion spec): stays the near-term motion,
  but each gap should be closed *by adding the kind to the catalog*, not by
  hand-writing another command. The route-manifest CLI gate is the interim
  ratchet; catalog completeness is the end state.
- **`kortix executor mcp`**: becomes the connector-tools subtree of the one
  hosted MCP server (kept as a stdio alias for compatibility).
- **Session approvals** (PR #4299), **guided agent config**, **gateway
  keys**, **billing reads**: all become catalog kinds/verbs rather than
  bespoke surfaces.

## Phases

### Phase 0 — catalog spine + pilot kinds

- [ ] Define the catalog schema in `@kortix/sdk` (kind, zod schema, verbs,
      IAM actions, addressing).
- [ ] Register three pilot kinds by *mapping existing routes* (no handler
      rewrite): `trigger`, `secret`, `session`.
- [ ] Generate the CLI grammar for pilots behind a flag; diff output/exit
      codes against the hand-written commands, then swap.
- [ ] Hosted MCP endpoint `POST /v1/mcp` (streamable HTTP): `tools/list`
      from the catalog filtered by token; `kortix_catalog` tool;
      `resources/list` for system docs.
- [ ] `GET /v1/catalog` introspection (token-filtered).

### Phase 1 — files, memory, skills, commands as writable resources

- [ ] Policy-resolved commit path: one server-side write primitive
      (direct-commit vs session-branch+CR by `git` capability).
- [ ] `file` kind (read exists; add write/delete via the primitive).
- [ ] Typed views: `memory`, `skill`, `command`, `agent` (schema-validated
      wrappers over the same primitive) — closes parity gaps #3 and #5.

### Phase 2 — invocation

- [ ] `agents.invoke` verb (ephemeral session + optional wait) on REST,
      CLI, MCP.
- [ ] MCP progress notifications for long invokes; `--wait/--json` on CLI.

### Phase 3 — the long tail, by catalog migration

- [ ] Move remaining kinds into the catalog (connectors, channels,
      schedules/webhooks, marketplace, CRs, gateway, members/roles/grants,
      billing reads; enterprise IAM admin last).
- [ ] Flip the CI gate: a `/v1/projects/*` route not represented in the
      catalog fails the build (replaces the interim manifest annotation).

### Phase 4 — self-description

- [ ] Serve the versioned `kortix-*` bundle (`/v1/system/docs`, MCP
      resources, `kortix system`).
- [ ] Sandbox images consume the same served bundle at bake time (one
      source, no drift between what agents in sandboxes know and what
      external clients can load).

## Security Invariants

1. Every projection terminates in the same handler + the same
   `authorize()` decision; there is no CLI-only or MCP-only privilege path.
2. MCP tool visibility is computed per token; a token never lists a tool it
   cannot successfully call.
3. File/memory/skill writes always land as attributable commits (author =
   principal), via the caller's `git` capability — never unversioned
   mutation, never silent base-branch writes without the `write` capability.
4. `agents.invoke` never exceeds launching-principal authority (identical
   to session-start semantics; no canonical session, no shared runtime).
5. Catalog introspection reveals only what the presenting token could do —
   it is not an enumeration oracle for other principals' resources.
6. System docs are public-safe content only (operating knowledge, no
   tenant data), so serving them unauthenticated is a product choice, not a
   leak risk.

## Open Questions

1. MCP transport priority: hosted streamable-HTTP first (works with
   claude.ai/Cursor remotes) with `kortix mcp` as a local stdio bridge — or
   stdio first for zero-infra? (Leaning hosted-first; the CLI bridge is
   ~free once the catalog exists.)
2. Does the web UI eventually render from the catalog (schema-driven forms)
   or stay hand-crafted? (Recommend: hand-crafted UX, catalog-driven
   *capability gating* only.)
3. Verb grammar for kind-specific actions on REST: `POST …/:name/{verb}`
   vs `POST …/:name:verb` (Google style). Pick once, apply everywhere.
4. Rate limits / spend controls per token for `agents.invoke` from external
   MCP clients (an invoke costs real sandbox+LLM money).
5. How much of enterprise IAM belongs in the externally-visible catalog vs
   an admin-only catalog partition?
6. Naming: `kortix system` vs `kortix docs` for the knowledge loader (no
   coding terminology; "system" matches the skill name).

## Verification Gates

1. An MCP client with only a Kortix PAT can: discover the catalog, read
   system docs, create a trigger, edit a memory file (lands as a commit),
   invoke an agent, and answer its pending question — without touching the
   web UI or the git remote directly.
2. The same operations succeed via `kortix …` commands and raw REST with
   byte-identical effects and identical 403 boundaries.
3. A narrowed token (project-scoped, agent grant) sees a correspondingly
   narrowed `tools/list` and catalog — verified by diffing against the
   grant.
4. Deleting a kind's hand-written CLI command after catalog migration
   changes no test outcomes (generated projection is behavior-identical).
5. A fresh agent given only the MCP endpoint + token bootstraps: reads
   `kortix://system/*`, then completes a multi-step task (create schedule →
   invoke agent → review CR) with no out-of-band knowledge.
