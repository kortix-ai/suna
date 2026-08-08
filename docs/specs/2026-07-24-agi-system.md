# AGI System Specification

Status: working document
Date: 2026-07-24
Owner: Kortix product/infra
Related:
`docs/specs/2026-06-28-token-session-agent-identity.md`,
`docs/specs/2026-06-28-project-authorization-runtime-governance.md`,
`docs/specs/2026-07-08-one-kortix-token-and-cli-centric-platform.md`,
`docs/specs/2026-07-05-agent-first-config-unification.md`,
`docs/specs/2026-07-14-trigger-session-strategy.md`

---

## 1. Scope

### 1.1 Purpose

This document specifies the system required to operate a workforce of LLM-driven
agents as members of an organization: continuously, against goals rather than
prompts, with bounded authority, durable memory, real effects on external
systems, and full attribution — on infrastructure owned by the operator.

The reasoning component (the harness and its model) is out of scope and is
treated as a replaceable dependency. This document specifies everything the
harness is not.

### 1.2 In scope

Identity, authorization, project definition, session execution, continuous
operation, the action surface, state and distribution, human interfaces,
auditing, and deployment ownership.

### 1.3 Non-goals

- Model selection, prompting, or reasoning quality.
- A harness-specific runtime contract. The system MUST NOT depend on any single
  harness implementation.
- Any capability that exists only behind a graphical interface (see R-8.1).

### 1.4 Requirement language

MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted per RFC 2119.

Requirements are numbered `R-<section>.<n>` and invariants `INV-<n>` for
reference. Implementation status is tracked separately in §14; the body of this
document is normative and describes the target, not the current build.

### 1.5 Terminology

| Term | Definition |
|---|---|
| Project | A git repository that constitutes the organization's configuration and accumulated state. The unit of ownership, isolation, and billing. |
| Manifest | `kortix.yaml` at the project root. The declarative definition of the project's agents, grants, connectors, required secrets, triggers, policy, and runtime image. (Channel routing is live project state; `channels:` is rejected in v2.) |
| Agent | A named principal defined by a behavior file (`.md`) and a governance entry in the manifest. |
| Session | One bounded unit of agent execution: one sandbox, one branch, one agent, one token. |
| Sandbox | The isolated Linux machine a session executes in. |
| Grant | The set of capabilities declared for an agent across four dimensions. |
| Connector | A brokered interface to an external system. |
| Trigger | A cron schedule or signed webhook that starts sessions without human action. |
| Channel | A messaging surface through which humans address agents. |
| Change request | A proposed merge from a session branch toward the project's default branch. |
| Skill | A versioned procedural artifact in the repository, loaded into sessions. |

---

## 2. System model

### 2.1 Components

| # | Component | Responsibility |
|---|---|---|
| C1 | State store | Durable, versioned representation of everything the organization knows and how it behaves. |
| C2 | Manifest | Declarative definition of agents, grants, connectors, secrets, triggers, policy, runtime. |
| C3 | Action surface | The sole authorized path from an agent to any capability. |
| C4 | Identity service | Mints, scopes, and introspects credentials for human, agent, machine, and service principals. |
| C5 | Authorization engine | Resolves an action against a principal's scope and the agent's declared grant. |
| C6 | Session orchestrator | Provisions, binds, monitors, resumes, and terminates sessions. |
| C7 | Connector gateway | Brokers all external effects; resolves credentials server-side; enforces policy and approval; writes the effect ledger. |
| C8 | Trigger service | Evaluates schedules and receives signed webhooks; starts sessions. |
| C9 | Channel service | Bidirectional message transport between humans and sessions. |
| C10 | Harness | Reasoning and tool-invocation loop. Replaceable. |

### 2.2 Planes

The system operates over three planes with distinct reversibility properties.
Confusing them is the primary source of design error.

| Plane | Contents | Reversible | Primary control |
|---|---|---|---|
| State | Knowledge, behavior, config, deliverables | Yes — by revert | Post-hoc review (change request) |
| Effect | Calls to external systems | **No** | Pre-execution policy and approval |
| Control | Identity, grants, lifecycle | Yes — by inverse operation | Authorization + audit |

R-2.1 — Controls on the effect plane MUST be evaluated before execution.
Post-hoc review MUST NOT be the only control on any irreversible action.

R-2.2 — Controls on the state plane MUST NOT be relaxed on the grounds that the
effect plane is separately controlled, and the converse.

### 2.3 Invariants

These hold at all times and across all components. A violation is a security
defect, not a degradation.

- **INV-1 — Subordination.** An agent's effective capability is always a subset
  of the capability of the human on whose behalf it acts. An agent is never a
  privilege escalation path.
- **INV-2 — Non-ambient authority.** An agent possesses no capability except
  through the action surface (C3). Possession of a sandbox confers nothing.
- **INV-3 — Immutability of binding.** A session's identity, agent, and grant
  are fixed at provisioning and cannot change for the session's lifetime.
- **INV-4 — Credential confinement.** Third-party credentials MUST NOT be
  materialized inside a sandbox. They are resolved at the connector gateway.
- **INV-5 — Attributability.** Every state change, external effect, and control
  change resolves to a principal, a session, and a time.
- **INV-6 — Declared authority.** Every capability an agent holds is declared in
  a reviewed artifact under version control. There is no runtime-only grant.
- **INV-7 — Durable goals.** Goal state exists outside any session. Loss of a
  session MUST NOT lose the objective.
- **INV-8 — Isolation.** No session's authority or state derives from any other
  concurrently running session.

---

## 3. Identity

### 3.1 Principal types

R-3.1 — The system MUST express all identity in one token family, distinguished
by claims rather than by credential type.

| Principal | Distinguishing claims | Notes |
|---|---|---|
| Human | none beyond account | Interactive or automation from an operator's machine. |
| Project automation | `project_id` | Headless, bound to one project. |
| **Agent** | `project_id` + `session_id` + `agent_grant` | Acts as the launching human, capped by the grant. |
| Service account | service-account identifier | Non-human IAM principal. MUST NOT be injected into a sandbox. |
| Machine | sandbox/daemon credential | Control-plane transport only. Carries **no** user identity and MUST NOT be accepted as one. |

R-3.2 — A credential carrying `session_id` MUST also carry `project_id` and a
resolved `agent_grant`.

R-3.3 — Machine credentials MUST be excluded from the action surface's
credential resolution order. A machine credential MUST NOT satisfy any
user-scoped or agent-scoped authorization check.

### 3.2 Credential resolution

R-3.4 — The action surface MUST resolve credentials in a defined, documented
precedence order, and that order MUST be identical on an operator's machine and
inside a sandbox.

### 3.3 Introspection

R-3.5 — The system MUST expose the active credential's full context —
principal type, project, session, agent, and every grant dimension — through a
single endpoint and a single command.

R-3.6 — An agent MUST be able to determine its own authority before attempting
an action. Discovering a boundary by failing at it is not acceptable, because
failure modes are non-deterministic under an LLM caller.

### 3.4 Session credential lifecycle

R-3.7 — Every session MUST receive a credential unique to that session.

R-3.8 — A session restored from a warm snapshot MUST mint a credential of the
same shape and scope as a cold-provisioned session. Carrying forward a
project-only credential from a snapshot seed is a privilege defect.

R-3.9 — Session credentials MUST be revocable independently of the launching
human's credential.

---

## 4. Authorization

### 4.1 Grant dimensions

R-4.1 — An agent's grant MUST be expressed across exactly these dimensions,
each independently scoped:

| Dimension | Governs |
|---|---|
| `connectors` | Which external systems the agent may reach. |
| `secrets` | Which project secrets are materialized into the sandbox and readable via the secrets interface. |
| `kortix_cli` | Which project-scoped platform actions the agent may perform. |
| `skills` | Which procedural artifacts are loaded into the session. |

R-4.2 — Each dimension MUST accept an explicit list, `all`, or `none`.

R-4.3 — An omitted dimension MUST resolve to `none`. Deny-by-default is
required; an omitted grant MUST NOT widen authority.

R-4.4 — Where a legacy manifest version defaults an omitted dimension to `all`,
migration MUST write the explicit value reproducing prior behavior rather than
silently narrowing or widening it.

### 4.2 Resolution

R-4.5 — Effective authority MUST be computed as:

```
effective(action, agent, human) = declared(agent) ∩ scope(human)
```

R-4.6 — The intersection MUST be enforced regardless of which layer applies it.
If the declared grant is stamped without the intersection, the enforcing layer
MUST apply the human's scope before permitting the action.

R-4.7 — When a project has adopted per-agent governance, an agent absent from
the manifest MUST default to deny. It MAY still execute its behavior file; it
MUST hold no grants.

R-4.8 — A project that has not adopted per-agent governance MUST behave as
before adoption: no per-agent restriction, still capped by the human's scope.
Adoption MUST be opt-in and MUST NOT silently break existing projects.

### 4.3 Default-agent resolution

R-4.9 — A non-binding default-agent sentinel MUST resolve identically wherever
it is interpreted — grant resolution, the proxy, and the runtime. Divergent
interpretation of the sentinel is a class of defect that silently strips or
grants authority.

R-4.10 — A manifest SHOULD be able to bind its default to a concrete declared
agent, so that the default execution path carries an explicit grant rather than
an unrestricted one.

### 4.4 Enforcement layering

R-4.11 — Authorization MUST be enforced in at least two independent layers:

1. **Structural.** A project-bound credential MUST refuse any account-scoped
   action before the agent's grant is loaded. Account-scoped administrative
   actions (member, billing, token, role, policy, project creation) MUST be
   structurally ungrantable to an agent.
2. **Declarative.** The agent's `kortix_cli` grant restricts the project-scoped
   action set.

R-4.12 — The grantable-action catalog is a curation and validation surface. It
MUST NOT be the sole enforcement boundary.

R-4.13 — Action identifiers MUST follow `<resource>.<verb>[.<subresource>]`,
where the resource prefix corresponds to a declared resource type, so that the
engine can derive the required scope type from the identifier alone.

### 4.5 Separation of propose and land

R-4.14 — Opening a change request and merging one MUST be distinct actions.

R-4.15 — Merge is the canonical destructive state-plane action. It MUST be
grantable independently, and MUST default to requiring a human principal.

### 4.6 Assignment to human principals

R-4.16 — Authorization to use project resources MUST be assigned through the
agent, not through direct resource grants to individuals. Assigning an agent to
a member or group confers exactly what that agent declares.

R-4.17 — Grants MUST support group principals as well as individual members.

R-4.18 — Grants MUST support expiry.

R-4.19 — Grants referring to resources no longer declared in the manifest MUST
be surfaced as orphaned rather than silently ignored or silently honored.

---

## 5. Project definition

### 5.1 Manifest

R-5.1 — The manifest MUST be the single source of truth for: the agent roster,
per-agent grants, connector declarations, required secrets, triggers, channels,
connector policy, the sandbox image, and the default agent.

R-5.2 — The manifest MUST reside in the repository and therefore MUST be
versioned, diffable, and reviewable.

R-5.3 — The manifest MUST govern only authority and topology. Agent behavior
(prompt, model, mode, tool permissions) MUST live in the agent's own behavior
file. The agent's name is the join between the two.

R-5.4 — A malformed entry MUST NOT abort parsing of the whole manifest. Parse
errors MUST be collected and reported per entry so that a partial manifest
remains diagnosable.

R-5.5 — The runtime environment for a session MUST be constructed from what the
manifest grants that agent. Cloning the full repository and relying on the
agent's discretion is not an acceptable isolation model.

### 5.2 Change control

R-5.6 — A change to authority MUST follow the same review path as a change to
code. There MUST be no mechanism for granting authority that bypasses review.

R-5.7 — An agent MAY be granted the ability to modify the manifest. That
modification MUST be expressed as a change request and MUST NOT take effect
until landed. Self-modification MUST NOT permit self-elevation.

---

## 6. Session execution

### 6.1 Binding

R-6.1 — A session MUST bind exactly one sandbox, one branch, one agent, and one
credential. This four-way binding is the unit of isolation.

R-6.2 — The session identifier and the sandbox identifier MUST correspond, so
that effect records, state changes, and transcripts join on one key.

### 6.2 Lifecycle

R-6.3 — Provisioning MUST: boot an isolated machine from a known image, obtain
the repository at a defined revision, create a fresh branch, mint the session
credential, materialize only the granted secrets, and start the harness.

R-6.4 — Session provisioning latency is a product constraint, not an
implementation detail. The system SHOULD provision from a pre-warmed image
rather than constructing the environment per session.

R-6.5 — Termination MUST NOT be required for work to be preserved. Preservation
is by commit and change request.

### 6.3 Isolation

R-6.6 — Sessions MUST be isolated at the machine level, not the process level.

R-6.7 — The system MUST support thousands of concurrent sessions over one
project configuration without cross-session interference.

R-6.8 — The only surface legitimately shared between concurrent sessions is the
external world, reached through the connector gateway, where contention is
therefore policy's problem and not the sandbox's.

### 6.4 Agent binding

R-6.9 — A request to execute a different concrete agent within a running
session MUST be rejected before it reaches the harness.

R-6.10 — Executing a different agent MUST require a new session with a newly
minted credential.

R-6.11 — Rejection MUST apply only when the session is bound to a concrete
agent and a different concrete agent is requested. A non-binding sentinel MUST
NOT trigger rejection on either side of the comparison.

R-6.12 — For a session bound to the sentinel, the proxy MUST normalize the
requested agent so the harness executes the agent the credential was minted
for, irrespective of what a client echoed.

### 6.5 Failure and resumption

R-6.13 — A turn terminated by a transient upstream failure SHOULD be resumed
with full context rather than surfaced as a terminal failure.

R-6.14 — Resumption MUST be bounded by a rolling window with backoff, not by a
counter reset on turn completion. A counter that resets on any terminal state
re-arms indefinitely and produces an unbounded loop.

R-6.15 — Resumption MUST NOT apply to deliberate abort, authentication failure,
authorization failure, insufficient credit, or malformed request. These require
human or configuration intervention.

R-6.16 — Resumption MUST be disableable by operator configuration.

---

## 7. Continuous operation

### 7.1 Goal state

R-7.1 — Goal state MUST be durable, external to any session, and expressed in
the state plane.

R-7.2 — A session MUST be able to reconstruct what remains to be done from the
state plane alone, without inheriting a prior session's context window.

R-7.3 — Progress toward a goal MUST be recorded as it is made, not only at
completion. A session that dies mid-objective MUST leave the objective
advanced, not lost.

### 7.2 Triggers

R-7.4 — Triggers MUST be declared in the manifest and therefore reviewed.

R-7.5 — The system MUST support time-based triggers with explicit timezone, and
event-based triggers authenticated by signature.

R-7.6 — Trigger activation MUST be controllable server-side, independently of
the manifest declaration, so that two deployments of one repository can be
prevented from double-firing without a code change.

R-7.7 — A trigger MUST be manually fireable for testing without altering its
schedule.

R-7.8 — There MUST be exactly one trigger subsystem. Multiple trigger backends
with distinct identity models are a correctness hazard: a user cannot reason
about which schedule is authoritative.

### 7.3 Session strategy

R-7.9 — A trigger MUST declare how it uses sessions across fires:

| Strategy | Semantics |
|---|---|
| `fresh` | Each fire provisions a new session, sandbox, and branch. |
| `reuse` | Each fire re-prompts the trigger's own persistent session. |
| `pinned` | Each fire re-prompts a specific operator-designated session. |

R-7.10 — The strategy MUST be expressible everywhere a trigger is created. A
strategy supported by the backend but absent from the client contract is
equivalent to unsupported.

### 7.4 Termination

R-7.11 — Completion MUST be defined against goal state, not against the end of
a model turn. A returned response is not evidence of a completed objective.

R-7.12 — Continuation MUST be bounded by explicit budget (wall-clock, token, or
iteration). Unbounded pursuit is a defect.

R-7.13 — The system MUST distinguish *blocked* from *complete* and MUST escalate
the former to a human through a channel rather than terminating silently.

---

## 8. Action surface

### 8.1 Parity

R-8.1 — Every action available through any graphical interface MUST be
available through the command-line surface.

Rationale: the command-line surface is the only interface agents can drive under
the same authorization model. A capability reachable only through a GUI is a
capability with no agent-facing policy, and its existence forces either an
unaudited side channel or a permanent human bottleneck. Parity is therefore a
security requirement, not an ergonomic one.

R-8.2 — The surface MUST be usable non-interactively and MUST emit
machine-readable output on request.

R-8.3 — The surface MUST bind to a project by default without per-invocation
configuration, and a directory-local binding MUST take precedence over the
global default.

R-8.4 — Alternative protocol faces (MCP or otherwise) MAY be offered. They MUST
be implemented over the same core and MUST NOT constitute a separate
authorization path.

### 8.2 Connector gateway

R-8.5 — Every external effect MUST route through the connector gateway.

R-8.6 — The in-sandbox client MUST be a thin client. It MUST NOT hold, receive,
or be able to derive a third-party credential.

R-8.7 — The gateway MUST, for every call, in order: authenticate the principal,
verify the connector is granted to the acting agent, evaluate policy, obtain
approval if required, resolve the credential, execute, and record the outcome.

R-8.8 — A denied or failed call MUST be recorded with the same fidelity as a
successful one.

R-8.9 — Recorded request data MUST be a digest, never raw inputs. Recorded
results MUST be redacted summaries.

### 8.3 Policy and approval

R-8.10 — The manifest MUST be able to declare a connector policy, materialized
to per-project settings.

R-8.11 — Actions MUST carry a risk classification.

R-8.12 — Actions above a configured risk threshold MUST pause for human
approval before execution.

R-8.13 — The approving principal MUST be recorded as a first-class field.

R-8.14 — An approval MUST be scoped. A blanket approval that silently persists
beyond the action it was granted for is a defect.

---

## 9. State, memory, and distribution

### 9.1 Representation

R-9.1 — All durable organizational state — configuration, procedural knowledge,
learned facts, and deliverables — MUST be represented as text under version
control in the project repository.

R-9.2 — The representation MUST be simultaneously human-readable and
agent-editable. There MUST NOT be a separate machine-only encoding of the same
state.

### 9.2 Procedural knowledge

R-9.3 — Skills MUST be loadable into a session without explicit invocation,
selected by the grant and by relevance to the task.

R-9.4 — Skills MUST also be explicitly addressable by name.

Rationale: R-9.3 and R-9.4 are the two distinct distribution failures. Implicit
loading is what makes one person's discovery become organizational default
behavior; explicit addressing is what makes it a callable asset. A system
providing only one of the two does not distribute knowledge.

R-9.5 — A session that acquires durable knowledge SHOULD write it as a skill or
skill amendment and propose it, rather than retaining it only in its transcript.

### 9.3 Landing

R-9.6 — Work reaches the default branch only through a change request.

R-9.7 — The default branch MUST represent the organization's current behavior.
A merge MUST be understood as changing how the organization operates, not only
what its files contain.

R-9.8 — A change request MUST carry the session identifier that produced it.

---

## 10. Human interfaces

R-10.1 — Agents MUST be addressable from the messaging surfaces the
organization already uses, not only from a dedicated application.

R-10.2 — A message arriving on a channel MUST start or continue a session under
the same identity and authorization model as any other entry point. A channel
MUST NOT be a privilege side channel.

R-10.3 — Channel-derived capabilities MUST be materialized as connectors and
MUST be subject to the same grant model.

R-10.4 — The system MUST support three modes of operation over one substrate:
on-demand (human-initiated), human-assisted (agent-initiated, human-gated), and
automated (trigger-initiated, policy-gated). These MUST differ only in what
initiates work and what requires a signature.

---

## 11. Auditing and attribution

### 11.1 Ledgers

R-11.1 — The system MUST maintain three records, corresponding to the three
planes of §2.2:

| Ledger | Records | Minimum fields |
|---|---|---|
| State | Knowledge and behavior changes | author, revision, parent, timestamp, session |
| Effect | Every external call attempted | account, project, connector, action path, acting principal, session, status, risk, request digest, redacted result, approver, initiated and resolved timestamps |
| Control | Identity, grant, and lifecycle changes | account, actor, action, resource type and identifier, prior state, new state, source address, user agent, timestamp |

R-11.2 — The effect ledger MUST also be the approval ledger. Approval state and
execution state MUST NOT be recorded separately, or they will diverge.

### 11.2 Correlation

R-11.3 — All three ledgers MUST be joinable on a common identity, minimally the
session identifier and the acting principal.

R-11.4 — The system MUST be able to answer, as a single query, what a given
agent did over a given interval — across state changes, external effects, and
control changes.

R-11.5 — The agent SHOULD be a first-class column on effect and control records,
not a value derived by joining through the session or extracted from an
untyped metadata field.

Rationale: scoping is what identity buys at execution time; correlation is what
it buys afterward. Every compliance, incident, and cost question is a
correlation question, and correlation degrades to guesswork if agent identity is
only reconstructable.

### 11.3 Retention

R-11.6 — Ledger retention MUST be independent of session and sandbox lifetime.
Destroying a sandbox MUST NOT destroy the record of what it did.

---

## 12. Deployment and ownership

R-12.1 — The system MUST be self-hostable in full, including single-tenant,
private-network, and disconnected deployments.

R-12.2 — The operator MUST be able to supply their own model providers and
credentials.

R-12.3 — A project MUST be portable: cloning the repository and supplying the
declared secrets MUST reproduce the organization's agents, skills, memory,
triggers, and runtime definition.

R-12.4 — No component of the system may require that organizational state,
configuration, or model access reside with the vendor.

R-12.5 — Behavior MUST be identical, modulo scale, between an operator's machine
and the hosted deployment. Local development and production MUST NOT be
distinct execution models.

---

## 13. Conformance

An implementation conforms to this specification if:

1. All invariants in §2.3 hold under concurrent load and under partial failure.
2. All MUST requirements are satisfied.
3. Every capability reachable by a human principal is reachable by an agent
   principal under the same authorization evaluation (R-8.1).
4. Every external effect appears in the effect ledger, and every ledger record
   correlates to a session and a principal (R-11.3).
5. Removing and replacing the harness (C10) requires no change to C1–C9.

Criterion 5 is the load-bearing one. If replacing the reasoning component
requires changing identity, authorization, state, or audit, then those concerns
have leaked into the harness and the system is not a substrate.

---

## 14. Implementation status

Assessed against the current build, 2026-07-24.

| Area | Requirements | Status |
|---|---|---|
| Principal model, claims-based tokens | R-3.1 – R-3.3 | Implemented; the credential-type inventory has not yet been collapsed to one family. |
| Introspection | R-3.5, R-3.6 | Implemented (`token_context`, `whoami --token-only`). |
| Session credential lifecycle | R-3.7 – R-3.9 | Implemented, including warm-restore parity. |
| Grant dimensions and resolution | R-4.1, R-4.2, R-4.5 – R-4.8 | Implemented. |
| Deny-by-default | R-4.3, R-4.4 | **v2 manifest only.** v1 defaults an omitted dimension to `all`. Migration is not complete. |
| Enforcement layering | R-4.11 – R-4.13 | Implemented. |
| Propose/land separation | R-4.14, R-4.15 | Implemented. |
| Assignment through agents | R-4.16 – R-4.19 | Implemented. |
| Manifest as source of truth | R-5.1 – R-5.4 | Implemented. |
| Runtime constructed from grant | R-5.5 | **Partial.** Repository acquisition is not yet fully grant-scoped. |
| Session binding and isolation | R-6.1 – R-6.8 | Implemented. |
| Agent binding and switch rejection | R-6.9 – R-6.12 | Implemented. |
| Turn resumption | R-6.13 – R-6.16 | Implemented for transient upstream failure only. |
| Durable goal state | R-7.1 – R-7.3 | **Not specified in the product.** No defined goal-state representation; the state plane supports it, nothing requires or structures it. This is the principal gap for continuous operation. |
| Triggers | R-7.4 – R-7.7 | Implemented. |
| Single trigger subsystem | R-7.8 | **Violated.** Two backends with distinct trigger identity. |
| Session strategy | R-7.9, R-7.10 | `fresh` and `reuse` implemented at the fire layer; `reuse` not exposed in the client contract, so unreachable in practice. `pinned` not built. |
| Goal-based termination | R-7.11 – R-7.13 | **Not implemented.** Completion is turn-based. |
| CLI parity | R-8.1 – R-8.4 | **Partial.** Parity is the stated direction; not audited or enforced. |
| Connector gateway | R-8.5 – R-8.9 | Implemented. |
| Policy and approval | R-8.10 – R-8.14 | Implemented; approval scoping (R-8.14) not verified. |
| State representation | R-9.1, R-9.2 | Implemented. |
| Skill loading | R-9.3, R-9.4 | Implemented. |
| Knowledge write-back | R-9.5 | **Not implemented.** No mechanism induces a session to persist what it learned. |
| Landing | R-9.6 – R-9.8 | Implemented. |
| Channels | R-10.1 – R-10.4 | Implemented. |
| Three ledgers | R-11.1, R-11.2 | Implemented. |
| Correlation | R-11.3, R-11.4 | **Partial.** Joinable, but no single interface answers R-11.4. |
| Agent as first-class field | R-11.5 | **Not implemented.** Agent is derived through the session or carried in untyped metadata. |
| Retention | R-11.6 | Implemented. |
| Ownership and portability | R-12.1 – R-12.5 | Implemented. |

### 14.1 Summary of gaps

Ordered by distance from the specification:

1. **Goal state and goal-based termination** (R-7.1 – R-7.3, R-7.11 – R-7.13).
   Nothing in the system represents an objective independent of a session, and
   nothing defines completion other than the end of a model turn. Every other
   continuous-operation mechanism is present; this is what they are missing.
2. **Knowledge write-back** (R-9.5). Skills distribute once written. Nothing
   causes them to be written.
3. **Session strategy reachability** (R-7.9, R-7.10) and **trigger subsystem
   unification** (R-7.8).
4. **Deny-by-default migration** (R-4.3, R-4.4).
5. **Agent as a first-class ledger field** (R-11.5).
6. **CLI parity audit** (R-8.1) — currently a direction, not an enforced gate.

---

## 15. Open items

- Whether goal state is a defined artifact in the repository, a first-class
  platform resource, or both, and what the reconciliation loop between goal
  state and session output looks like (R-7.1 – R-7.3).
- Whether a continuation budget is per-goal, per-trigger, or per-project, and
  where it is declared (R-7.12).
- Whether per-turn credential minting should replace the session-bound model,
  which would permit safe in-session agent switching (R-6.9 – R-6.11).
- Whether approval scope is per-call, per-session, or per-connector, and how an
  approval is revoked before it expires (R-8.14).
- How R-8.1 parity is mechanically enforced rather than asserted.
- Whether skills are selected for implicit loading by grant alone or by a
  relevance mechanism, and how that selection is made auditable (R-9.3).
