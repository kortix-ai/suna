# AGI Task System V1

Status: canonical V1 contract; implementation exists on the isolated
`agi-task-system-v1` branch and is not shipped
Date: 2026-08-09
Owner: Kortix product/infra
Related:
`docs/specs/2026-08-06-autonomous-agent-harness.md`,
`docs/specs/2026-07-26-agi-autonomous-operations.md`,
`docs/specs/2026-07-24-agi-system.md`,
`docs/specs/2026-07-14-trigger-session-strategy.md`

## 1. Decision

Kortix V1 is a cloud-first autonomous coworker harness. It is not a claim that
the acting model is artificial general intelligence.

The durable product object is a task. A session is one replaceable execution
attempt beneath a task. PostgreSQL owns mutable coordination and authorization.
Git owns approved skills, procedures, configuration, and durable organizational
memory. OpenCode is the first session runtime. The AGI coordinator uses the
durable task control plane and Kortix CLI.

The product promise is:

> Delegate an outcome. Receive an evidence-backed result or one precise, durable
> blocker.

"Never stop" means durable responsibility. It means leases, lifecycle commands,
triggers, bounded retries, blockers, reminders, and resolution wake-ups. It does
not mean continuous inference, infinite spend, or a process that never exits.

This specification supersedes conflicting task, status, and feature-gate
proposals in the related documents. Those documents remain design background.

## 2. V1 product scope

V1 delivers one complete control loop for bounded engineering work:

1. A human creates or delegates a task.
2. The platform stores the outcome and verification contract.
3. One coordinator session atomically claims the task.
4. The coordinator can bind one bounded worker session.
5. The worker produces residue, progress, evidence, or a blocker.
6. The coordinator records application-append-only evidence against one candidate.
7. The server evaluates the structural completion contract.
8. A human resolves exact blockers or performs required review.
9. The task becomes `done` only after the server gate passes.
10. PostgreSQL preserves responsibility across process and sandbox restarts.

The initial work class is bounded engineering work. Examples include bug fixes,
regression tests, documentation corrections, small features, deployment checks,
and production-error investigation.

V1 exposes tasks through the cloud API, `@kortix/sdk`, the Kortix CLI, and a
task-first web review surface. Raw session transcripts remain execution detail.
The primary human surface leads with outcome, verification, blockers, evidence,
events, and session lineage.

## 3. Terms

| Term        | Exact boundary                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Project     | Existing Kortix tenancy, repository, IAM, and execution boundary.                                            |
| Coworker    | User-facing primary agent experience. V1 uses the reserved `agi` agent.                                      |
| Task        | Durable outcome, verification contract, responsibility, and mutable coordination record.                     |
| Session     | One cloud conversation and sandbox allocation. It is replaceable and non-authoritative.                      |
| Coordinator | The one session holding the current task claim.                                                              |
| Worker      | A distinct bounded session registered under the coordinator claim.                                           |
| Verifier    | Reserved session-lineage role for a future trusted producer. V1 does not create verifier links or producers. |
| Evidence    | Application-append-only support claim tied to one task contract revision and candidate digest.               |
| Blocker     | A typed, durable condition that requires an external or human action.                                        |
| Trigger     | Existing Kortix mechanism that wakes work.                                                                   |
| Monitor     | A verification requirement for a continuing condition. A trigger can evaluate it.                            |

V1 does not add projects, epics, milestones, spaces, playbooks, or organization
charts as execution primitives. The optional `goal_slug`, plus `parent_id` and
`blocked_by`, remain compatibility and grouping fields.

## 4. State ownership

| State                                                                                             | Source of truth                       | Rule                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| Task contract, status, claims, bounds, blockers, evidence metadata, events, messages, and lineage | PostgreSQL                            | Mutable or contended state requires transactions, leases, idempotency, and queries. |
| Effective IAM, service accounts, session credentials, grants, and lifecycle commands              | PostgreSQL                            | The platform owns enforced authorization and operational coordination.              |
| Approved agent instructions, declared grants, skills, procedures, configuration, and memory       | Git                                   | Authored policy and durable residue must be diffable, reviewable, and reversible.   |
| Large artifacts, screenshots, videos, logs, and transcripts                                       | Existing session and artifact storage | These are evidence sources, not mutable task authority.                             |
| Process state, caches, and sandbox scratch files                                                  | Sandbox-local storage                 | This state is disposable. Losing it must not lose responsibility or authority.      |

PostgreSQL is authoritative for whether work is owned, blocked, reviewable, or
complete. Git is authoritative only after a proposed procedure or memory change
passes its normal review path. A task result that must outlive the task must
produce durable repository or external-system residue.

V1 does not create a separate memory database, workflow engine, scheduler,
heartbeat service, or wake queue.

## 5. Task contract

A task contains the following contract fields:

- `intent`
- `constraints`
- `out_of_scope`
- `contract_revision`
- `verification_requirements`
- `review_policy`

Verification requirement kinds are `command`, `http`, `artifact`, `deployment`,
`policy`, `human`, and `monitor`. Each requirement has a stable ID, description,
kind, and required flag. Review policy is `auto` or `human`.

The human contract is authoritative. A session principal cannot apply a
contract revision or remove a required check. A session can propose a
refinement. Each accepted revision increments `contract_revision`. Evidence
from an older revision remains in the ledger but cannot satisfy the new
revision.

Only a human JWT or PAT principal can revise a contract. Session principals and
unbound service accounts receive `403` before the mutation runs.

Contract changes are rejected after `done` or `cancelled`.

### 5.1 Status model

V1 retains the existing platform statuses:

```text
backlog
todo
doing
blocked
review
done
cancelled
```

Their meanings are:

| Status      | Meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| `backlog`   | Accepted work that is not ready for execution.                  |
| `todo`      | Ready work with no unresolved dependency.                       |
| `doing`     | One coordinator owns a live claim.                              |
| `blocked`   | Progress requires a durable external condition or escalation.   |
| `review`    | Non-human completion conditions pass, but human review remains. |
| `done`      | The server completion gate accepted the current candidate.      |
| `cancelled` | A human ended responsibility.                                   |

There is no task-level `failed` status. Worker attempts can fail. The task
continues, blocks, returns to `todo`, or is cancelled.

The supported state path is:

```text
backlog | todo -> doing -> blocked | review | done
blocked -> todo
review -> done
backlog | todo | doing | blocked | review -> cancelled
```

Only the task service performs authoritative transitions. Worker idle, session
settlement, a model response, a branch, a commit, or a pull request does not
complete a task.

### 5.2 Creation and dependencies

`origin_fingerprint` makes task creation idempotent within a project. A null
fingerprint disables deduplication. `parent_id` models structure only.
`blocked_by` models task dependencies. A task cannot block itself.

A claim rejects unresolved dependencies. New work can enter only `backlog` or
`todo`, then enter `doing` through a claim. The API, SDK, CLI, and generated
state store reject direct creation in `doing`, `review`, `blocked`, `done`, or
`cancelled`.

`goal_slug` is nullable. A task without a Git-authored goal retains the same
claims, liveness, evidence, blocker, and completion contracts. When a non-null
goal is supplied, the create route verifies that the authored goal exists.

`control_plane_version` is null for historical tasks and `1` for every new V1
task. This explicit marker prevents a default, empty-looking V1 contract from
falling through a legacy completion path.

## 6. Coordinator claims and session lineage

A coordinator claims a task with a session ID and lease duration. The accepted
lease range is 30 to 86,400 seconds. Claiming uses a transactional conditional
update. A concurrent loser receives a conflict and must select other work.

The claim path enforces these rules:

1. The session belongs to the project.
2. The task is claimable and its dependencies are complete.
3. A live claim cannot be stolen.
4. Agent or user assignment must match.
5. A worker session cannot also become a coordinator.
6. One coordinator session can own at most one task in `doing` or `review`.

The claim transaction checks both active statuses. Partial unique indexes fence
both the claim session and liveness coordinator across `doing` and `review`.
Expired-claim cleanup only clears `doing`, so a review claim remains available
for explicit human approval after its lease expires.

The existing leader-owned task sweep also recovers expired coordinator-only
claims. It returns the task to `todo`, records the abandoned coordinator and
lease in the event ledger, and queues one idempotent lifecycle wake for that
coordinator. A bound worker remains under the bounded-worker sweep instead.

The platform stores coordinator, worker, and verifier links in
`project_task_session_links`. Each link has a role and optional parent session.
`GET /tasks/current` finds the latest task for the authenticated claimant,
worker, or linked session.

A worker is a distinct session. Registration atomically binds one worker,
stores immutable bounds, extends the claim through the worker deadline, and
queues provisioning plus the initial prompt through the existing lifecycle
outbox. Retry is idempotent only when the worker, prompt, and bounds match.

The V1 platform ceilings are:

| Bound        |       Maximum |
| ------------ | ------------: |
| Wall time    | 3,600 seconds |
| Model tokens |     1,000,000 |
| Model cost   |        USD 25 |
| Iterations   |           128 |

The coordinator can narrow these values. It cannot widen them.

## 7. Worker progress and liveness

Each worker turn has a server-owned `liveness_turn_id`. The coordinator records
exactly one semantic outcome for that ID:

- `progress`, with one durable evidence reference; or
- `no_progress`, with one reason.

PostgreSQL rejects contradictory outcomes and makes retries idempotent. Progress
stores `last_progress_ref` and advances the turn ID.

The first distinct no-progress settlement queues one continuation to the same
worker. A second settlement, or any exceeded wall, token, cost, or iteration
bound, performs one atomic escalation:

1. Change the task to `blocked`.
2. Clear the coordinator claim and active request fences.
3. Revoke worker session tokens.
4. Queue worker stop.
5. Queue a coordinator wake with the escalation.

Provider admission and Git receive-pack use durable request fences. An active
provider request or unsettled Git write prevents terminal transition. Fence
expiry and the existing liveness sweep prevent a crashed process from holding
authority forever.

`queued` and `drained` describe lifecycle-command handling only. Neither state
proves that the remote worker completed work. An empty newly created worker is
waiting for its initial registered prompt. It is not no-progress.

## 8. Evidence ledger and completion gate

Evidence is application-append-only. An evidence row records:

- task and project identity;
- producing session, when present;
- contract revision;
- requirement ID, when present;
- kind and reference;
- summary;
- candidate digest;
- state: `passed`, `failed`, or `info`;
- creation time.

Database triggers reject evidence and event updates. The triggers do not reject
database deletes, and task deletion can cascade. Corrections through the V1 API
require new rows. A session can add evidence only inside its task lineage.

Agents request completion. They do not set `done` directly. The server accepts
completion only when all conditions are true:

1. The caller owns the task claim, subject to the human-review exception below.
2. No blocker remains open.
3. Every required verification requirement has matching `passed` evidence.
4. Each accepted evidence row matches the requirement kind.
5. Each accepted evidence row matches the current contract revision.
6. Each accepted evidence row matches the submitted candidate digest.
7. A human JWT or PAT principal approves the current candidate.
8. No provider request or Git write fence remains active.

When only human review remains, a session request moves the task to `review` and
preserves the coordinator relationship. A session principal cannot approve its
own result. A service account cannot impersonate a human approver. A human can
approve the same review candidate after the claim lease expires.

Completion records the candidate digest, contract revision, matching evidence
IDs, and verification time. It then clears the claim, revokes worker authority,
and queues worker stop.

The completion gate verifies structure, provenance identity, revision, digest,
and blocker state. It does not verify that an evidence reference contains true
proof. A task-lineage session can submit an arbitrary requirement ID, kind,
reference, and `passed` state. V1 has no registered verifier runtime or producer
allowlist. Therefore, both stored review-policy modes require human approval.
The `auto` value remains in the contract for forward compatibility, but it does
not authorize V1 completion. Human review adds judgment; it does not convert
arbitrary evidence into machine-verified truth.

The legacy `/done` route remains only for historical tasks whose
`control_plane_version` is null. Every V1 task must use `request-completion`,
including a revision-one task whose optional contract collections are empty.

## 9. Blockers, reminders, and resolution wake-up

A blocker records a category, requested human action, structured target,
request digest, attempts already made, status, reminder time, and optional
expiry. Open blockers with the same request digest are idempotent.

The reminder policy is bounded:

- default interval: 24 hours;
- minimum interval: 15 minutes;
- maximum interval: 7 days.

These values govern recurrence. When `next_reminder_at` is omitted, the store
sets the first reminder to 24 hours after creation. An explicit `null` is the
no-reminder policy.

A partial unique index permits one open blocker for each
`(project_id, task_id, request_digest)` tuple. Concurrent creation uses a
conflict-safe insert and reloads the winning blocker without duplicating the
creation event.

The existing project-trigger scheduler claims due reminders with row locks and
`SKIP LOCKED`. Each reminder uses a deterministic idempotency key. It writes a
task message, appends an event, advances `next_reminder_at`, and queues a
continuation for the selected coordinator through the existing session
lifecycle outbox. It does not add a new scheduler.

The sweep selects a blocker when its reminder is due or its expiry elapsed.
Expiry runs before reminder delivery. An expired blocker becomes `expired`
without sending a reminder. If it was the final open blocker, the same
task-locked reconciliation used by manual resolution returns the task to `todo`
and wakes the newest coordinator.

A session principal cannot resolve a blocker. Resolving the final open blocker
moves a `blocked` task to `todo` and queues a wake. The task must be reclaimed.
Resolution does not fabricate ownership. Only a human JWT or PAT principal can
resolve a blocker. The API accepts only an unbound Supabase or PAT principal as
human. It rejects legacy API keys, service accounts, and all session principals.

Each claim refreshes its durable coordinator-link timestamp. Reminder and
resolution wake-ups select the newest coordinator link, with the session ID as
a deterministic secondary order.

V1 does not implement unbounded harassment. It supports durable, visible,
auditable reminders with a bounded default and explicit opt-out.

## 10. Identity and authorization boundaries

The reserved platform coordinator is `agi`. It receives only these project
actions:

- project read;
- goal read and write;
- task read and write;
- change-request open;
- session read and start;
- file read;
- GitOps read.

It receives no connector grants and no environment grants. It cannot administer
IAM, read project secrets, push or merge protected branches, stop arbitrary
sessions, or widen its own authority. The project-bound PAT and the initiating
human's IAM role remain outer boundaries.

Workers receive their agent grant plus task and session binding. Session
credentials are short-lived and project-scoped. The API derives session identity
from authentication. A caller cannot select another session identity.

The broad primary-coworker access requested during onboarding must still pass
explicit account IAM, agent grants, connector policy, and session binding.
"Broad access" never means credential export, self-granting, MFA changes,
approval of the coworker's own consequential action, or creation of an
ungoverned access path.

V1 reuses current Kortix service accounts, session tokens, agent grants,
connector ownership, and secret injection. It does not provision Google
Workspace users, managed mailboxes, Android identities, or persistent browser
profiles.

## 11. `agi` feature gate

The feature key is `agi`.

`agi` is experimental, available, and off by default. When enabled for a
project, Kortix injects the reserved `agi` agent and makes it the default for
new sessions without an explicit agent. The platform locks it to the `agi`
sandbox, and an `agi` session cannot spawn another `agi` session. A trusted
generated goal push can request `agi` through the existing internal launch
path when the project flag is off. Arbitrary or forged requests cannot use that
exception.

The task page, project-sidebar entry, and command-menu entry fail closed when
the flag is disabled. The task API, SDK, and CLI remain protected by their
existing task IAM leaves. They are not hidden behind a second route gate.

The baked coordinator guide is task-first. It recovers `tasks current` before
optional goal state, and it accepts tasks without an owning goal. Human
dependencies use `tasks blocker` with a typed category, requested action,
stable digest, attempts, target, claim session, and bounded reminder. The guide
does not teach the legacy `tasks block` transition.

Disabling the flag removes the platform coordinator from project configuration
and restores normal OpenCode agent selection. V1 does not yet implement a full
coworker kill switch that revokes every active connector and session.

## 12. Cloud-first runtime

The V1 coordinator runs in a cloud Kortix sandbox. The coordinator image
contains the sandbox daemon, Kortix CLI, Git, OpenCode, and managed Kortix skills.

The coordinator sandbox intentionally does not clone the project or install its
toolchain. It coordinates. Specialized worker sessions run in ordinary project
sandboxes with the project repository and required tooling.

Each session remains an isolated compute and credential boundary. V1 does not
share a mutable filesystem or Python heap between sessions. Workers exchange
durable state through task records, typed messages, evidence, branches, change
requests, and artifacts.

The same API and SDK contracts support local development, but the production
design assumes disposable cloud compute. A machine can host several isolated
sessions. Compute placement does not change task ownership.

OpenCode is the only first-class runtime adapter in V1. Claude Code, Codex, Pi,
Prime Agent, ACP, and other harnesses can be invoked as tools only when current
agent policy permits it. They are not control-plane authorities.

## 13. Memory and continual harness

V1 uses four memory categories without creating four storage systems:

- Working memory: prompt, session state, and sandbox scratch files.
- Episodic memory: task events, messages, evidence, session transcripts, and
  artifacts.
- Semantic memory: reviewed facts and decisions in Git.
- Procedural memory: reviewed skills, instructions, code, and configuration in
  Git.

Task-local refinement proposals immediately replace the stored
`task.result.harness_overrides` value. The caller supplies the current
`task.result.harness_revision`, or `0` before the first refinement. The server
locks the task and rejects a stale base revision. The accepted proposal ID
becomes the next revision. The proposal stores the prior overrides as a rollback
patch. A rollback succeeds only while that proposal is the current revision, so
it cannot overwrite a newer accepted refinement. The API rejects a serialized
override above 16 KiB before applying it. Worker registration appends the
matching task-local override to that task's initial worker prompt. It never
enters another task's prompt. A session can apply a task-local stored override
only for its current task lineage. Only a human JWT or PAT principal can roll it
back.

Agent, project, account, and platform refinements remain proposals. V1 does not
auto-apply them. They must use their future review, canary, change-request, or
release path. This prevents a task agent from rewriting global policy.

V1 does not automatically extract semantic memory from every transcript, commit
memory files to Git, build an authorization-aware retrieval index, or prove
self-improvement. Those require evaluation, provenance, promotion, and rollback
beyond the implemented task-local mechanism.

## 14. Product surfaces

### 14.1 Cloud API

The project task API includes:

| Operation                   | Route                                                          |
| --------------------------- | -------------------------------------------------------------- |
| Current task                | `GET /projects/{projectId}/tasks/current`                      |
| Task list and create        | `GET, POST /projects/{projectId}/tasks`                        |
| Task detail                 | `GET /projects/{projectId}/tasks/{taskId}`                     |
| Claim                       | `POST /projects/{projectId}/tasks/{taskId}/claim`              |
| Claim compensation          | `POST /projects/{projectId}/tasks/{taskId}/release-claim`      |
| Legacy completion and block | `POST .../done`, `POST .../block`                              |
| Worker registration         | `POST .../worker`                                              |
| Progress and no-progress    | `POST .../progress`, `POST .../no-progress`                    |
| Contract revision           | `PATCH .../contract`                                           |
| Evidence                    | `GET, POST .../evidence`                                       |
| Server completion gate      | `POST .../request-completion`                                  |
| Blockers                    | `GET, POST .../blockers`                                       |
| Blocker resolution          | `POST .../blockers/{blockerId}/resolve`                        |
| Events and lineage          | `GET .../events`, `GET .../sessions`                           |
| Messages                    | `GET, POST .../messages`, `POST .../messages/{messageId}/ack`  |
| Cancellation                | `POST .../cancel`                                              |
| Refinements                 | `GET, POST /projects/{projectId}/refinements`                  |
| Refinement rollback         | `POST /projects/{projectId}/refinements/{proposalId}/rollback` |

Every route enforces project membership plus `project.task.read` or
`project.task.write`. The contract, blocker-resolution, cancellation, and
rollback routes require a human JWT or PAT principal. Evidence, task messages,
blocker creation, and task-local refinement enforce session lineage.

### 14.2 SDK

`@kortix/sdk` is the source of truth for clients. The surface begins at:

```ts
createKortix({ backendUrl, getToken }).project(projectId).tasks;
```

It exposes typed task CRUD, current task, claims, workers, progress,
no-progress, contracts, evidence, completion requests, blockers, events,
sessions, messages, cancellation, and refinements. React query keys cover task
inventory and task detail ledgers. Hosts must not add raw backend transports.

### 14.3 CLI

The CLI exposes:

```text
tasks current
tasks run
tasks watch
tasks contract
tasks evidence
tasks submit
tasks blockers
tasks blocker
tasks resolve-blocker
tasks events
tasks sessions
tasks cancel
```

It also retains task list, show, create, claim, legacy done, legacy block,
worker, progress, and no-progress commands.

`tasks run` creates a cloud coordinator session, claims the task, and sends the
coordinator prompt. `tasks watch` polls durable task state until `done` or
`cancelled`, or until its optional timeout. `tasks watch` is a client command.
It is not a server scheduler or liveness authority. `tasks run` is not one
database transaction, so it runs explicit compensation. A claim failure deletes
the new session. A prompt failure stops and deletes the new session, then
idempotently releases only that unused claim. Each failed compensation action is
reported. Lease expiry remains the durable fallback.

### 14.4 Web

The web route is `/projects/[id]/tasks`. It provides:

- task inbox filters for all, open, blocked, review, and done work;
- master-detail review;
- verification contract coverage;
- artifact-first evidence;
- open blockers and reminder times;
- human blocker resolution;
- event timeline;
- coordinator, worker, and verifier lineage;
- human `Verify and close` action;
- coworker readiness;
- project-sidebar and command-menu discovery.

Coworker readiness reports five observable capabilities: coordinator
configuration, callable tools, communication channels, callable computer
actions, and unresolved access requests. It derives those values from existing
project config, connector, Slack, email, computer, and blocker data. It does not
provision missing capabilities. Tool readiness requires at least one connector
with a callable action. Computer readiness is a connector-name/provider
heuristic, not a live browser-profile check. Read failures remain unknown and
never become ready.

The header and empty state expose a direct `Delegate task` modal. It creates a
goal-less `todo` task with human review and one required artifact condition. The
server-owned reconciler launches the coordinator.

## 15. Operations and scheduler integration

V1 reuses two existing operational mechanisms:

1. The project-trigger scheduler runs ready-task reconciliation,
   blocker-reminder, and bounded-worker sweeps.
2. The session lifecycle outbox owns provisioning, initial prompts,
   continuations, coordinator wake-ups, escalation, and server-owned stops.

All queued commands have durable identities and idempotency keys. API restarts
do not erase them. Immediate delivery is a latency optimization. The outbox
remains authoritative after immediate delivery fails.

The event timeline is application-append-only audit history. Database updates
are rejected, but database deletes are not. Task messages are typed JSON with
task-scoped idempotency keys and lifecycle status. Session recipients must
acknowledge their own messages.

V1 does not add a separate task reconciler service. A bounded reconciler module
runs under the existing scheduler leader. It selects at most ten dependency-ready
`todo` tasks per pass from `agi` projects. It orders them by priority,
creation time, and task ID. Each selected task generation gets one idempotent
`create_session` lifecycle command. A later transition back to `todo` receives a
new command identity. Post-create handling atomically claims the still-ready
task and enqueues one coordinator-scoped initial prompt. A stale task returns
typed, non-retryable `TASK_READY_STALE` and retires the unused coordinator
session. The same scheduler retains bounded-worker, blocker, Git-write, and
expired-coordinator recovery paths.

## 16. Failure modes and recovery

| Failure                            | V1 behavior                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate task delivery            | `origin_fingerprint` returns the existing task.                                                                                                                |
| Concurrent claim                   | One transaction wins. Other callers receive a conflict.                                                                                                        |
| API restart after command queueing | PostgreSQL preserves the command for the existing outbox worker.                                                                                               |
| Worker prompt delivery failure     | The queued lifecycle command remains retryable.                                                                                                                |
| Duplicate semantic settlement      | The stored turn outcome is returned. Contradictory outcomes fail.                                                                                              |
| Worker no-progress                 | One continuation is allowed. The next no-progress result blocks and escalates.                                                                                 |
| Bound exhaustion                   | The sweep blocks work, revokes worker authority, stops the worker, and wakes the coordinator.                                                                  |
| Active provider request            | The admission fence prevents concurrent admission and terminal transition.                                                                                     |
| Active Git write                   | The receive-pack fence prevents terminal transition until the write settles or recovers.                                                                       |
| Open human blocker                 | The task remains incomplete. The default first reminder is 24 hours; expiry sweeps independently.                                                              |
| Blocker resolution                 | The final resolution returns the task to `todo` and wakes the newest linked coordinator.                                                                       |
| Human review required              | The task enters `review`; an agent cannot self-approve.                                                                                                        |
| Stale contract evidence            | It remains visible but cannot satisfy the current revision.                                                                                                    |
| Candidate mismatch                 | Evidence for another digest cannot satisfy completion.                                                                                                         |
| Sandbox loss                       | Durable task, claim, evidence, events, and commands survive. Scratch state does not.                                                                           |
| Human cancellation                 | Active admission or Git-write fences return `409` and stay intact. After settlement, one transaction revokes worker tokens, records evidence, and queues stop. |
| Expired coordinator claim          | The existing sweep returns it to `todo`, records recovery, and queues one deterministic wake.                                                                  |
| `tasks run` claim conflict         | The task remains unchanged and compensation deletes the newly created coordinator session.                                                                     |
| `tasks run` prompt failure         | Compensation stops and deletes the session, releases only its unused claim, and reports every failed compensation action. Lease expiry is the durable fallback. |
| Ready task changes before claim    | Post-create handling returns non-retryable `TASK_READY_STALE`, retires the unused coordinator, and does not steal authority.                                  |

Known V1 gaps and closed hardening items remain explicit:

1. Closed in V1: human cancellation rejects with a typed conflict while any
   admission or Git-write fence is active. The rejection preserves the task,
   worker authority, and every fence. After side effects settle, cancellation
   transactionally changes the task to `cancelled`, records actor and reason,
   revokes bound worker tokens, clears responsibility, and queues one
   idempotent server-owned worker stop.
2. Closed in V1: the existing scheduler recovers expired coordinator-only claims
   to `todo`, appends exact event truth, and queues one deterministic recovery
   wake. Bound workers remain under bounded-worker recovery.
3. Closed in V1: session evidence cannot authorize completion. Every candidate
   requires explicit approval from a human JWT or PAT principal.
4. Closed in V1: all human-only task routes accept only unbound Supabase or PAT
   principals. They reject legacy API keys, service accounts, and session
   principals.
5. Closed in V1: blocker creation and task-local refinement require the
   authenticated session's current task lineage.
6. Closed in V1: an omitted first reminder defaults to 24 hours, and expiry is
   swept independently. Explicit `null` remains the no-reminder policy.
7. Closed in V1: claims refresh coordinator lineage and blocker wake-ups select
   the newest coordinator.
8. Closed in V1: claim checks and database indexes reserve coordinator ownership
   across both `doing` and `review`.
9. Closed in V1: `tasks run` deletes a new session after claim failure. After
    prompt failure, it stops and deletes the session, then idempotently releases
    only the unused claim owned by that session.
10. Closed in V1: new tasks accept only `backlog` or `todo`; nullable
    `goal_slug` supports task-first work; `control_plane_version = 1` prevents
    legacy completion bypass.
11. Closed in V1: the existing scheduler leader reconciles dependency-ready
    `todo` tasks into one idempotent AGI-coordinator lifecycle command. Claim
    and initial prompt enqueue are atomic after session creation.
12. Closed in V1: task-local harness overrides enter only that task's bounded
    worker prompt and are capped at 16 KiB.
13. Closed in V1: each ready-task generation and replacement coordinator has a
    distinct durable command identity. Stale coordinator creation is retired.
14. Closed in V1: worker registration deletes a reservation when atomic task
    binding fails.

These closed items define the V1 hardening boundary. They do not claim external
truth verification beyond the mandatory human completion decision.

## 17. V1 non-goals

V1 does not include:

- model-level AGI claims;
- automatic Google Workspace or Microsoft identity provisioning;
- managed mailbox, MFA, Android, or persistent browser provisioning;
- long-video transcription and company-brain ingestion;
- an Ask versus Delegate composer redesign;
- a general goals, projects, milestones, or org-chart product hierarchy;
- arbitrary multi-agent graphs or unbounded recursive worker depth;
- shared mutable volumes between sessions;
- ACP-native or multi-harness UI rendering;
- Claude Code, Codex, Pi, or Prime Agent as a first-class runtime;
- a TypeScript replacement for `kortix.yaml`;
- a separate scheduler, workflow engine, heartbeat, or wake queue;
- a general verifier execution service, evidence freshness engine, or waiver
  model;
- automatic merge, production deployment, or consequential external approval;
- unrestricted access to connectors, secrets, browsers, or external APIs;
- automatic Git promotion of memories and skills;
- a vector index as authoritative memory;
- online model-weight training;
- a repository-wide Project-to-Workspace rename.

V1 also defers web contract editing, evidence submission, cancellation,
messages, and refinement management. The SDK exposes messages and refinements,
but the CLI does not yet expose those groups.

## 18. V1 acceptance contract

The implementation is acceptable only when tests prove all of these paths:

1. A duplicate task origin creates one task.
2. Concurrent coordinators cannot own the same task.
3. One claim cannot own two workers.
4. A worker cannot control its coordinator task.
5. A restart cannot reset a no-progress settlement or continuation count.
6. Required evidence must match the requirement kind, current revision, and
   candidate digest.
7. An open blocker prevents completion.
8. Every V1 completion requires human JWT or PAT approval after evidence passes.
9. Session principals and unbound service accounts cannot revise the contract,
   resolve a blocker, cancel, roll back, or self-approve human review.
10. Blocker creation and task-local refinement enforce task lineage.
11. Every open blocker has a bounded first reminder or an explicit no-reminder
    policy, and expiry is evaluated independently.
12. Reminder and resolution wake-ups select the current coordinator.
13. One coordinator cannot retain a review claim while claiming another task.
14. Human approval completes a review task after claim expiry.
15. Blocker reminders use the existing scheduler and deterministic keys.
16. Resolving the final blocker returns the task to `todo` and queues a wake.
17. A partial `tasks run` launch reports every compensation action. Claim
    release returns the task to `todo`, refuses another session's claim or
    started work, and creates one event across repeated requests.
18. Web discovery and the task page fail closed when `agi` is disabled.
19. API, SDK, CLI, and web clients use the same task contract.
20. A recovered `todo` task can launch a replacement coordinator and receives a
    coordinator-scoped prompt identity.
21. A stale ready-task coordinator and a failed worker reservation are
    retired before their errors return.
22. Ready-task reconciliation is bounded, deterministic, feature-gated,
    idempotent, and cannot claim a stale or dependency-blocked task.
23. A goal-less task completes the same claim, evidence, human-review, and
    server-gated lifecycle as a goal-linked task.
24. Task-local refinements reject oversized patches and stale base revisions.
    Rollback cannot overwrite a newer accepted refinement.

The isolated branch meets this acceptance contract only when the referenced
local tests remain green. It is not shipped. Deployment requires a separate
authorized delivery cycle with migration application, merge, artifact
verification, and live dev acceptance proof.

## 19. Local verification record

The AGI rename and task-system cleanup passed these local gates on 2026-08-09:

| Surface | Command | Result |
| ------- | ------- | ------ |
| API | `pnpm --dir apps/api test` | `6221 pass`, `130 skip`, `0 fail`, `23722 expect()` calls across `603` files |
| API types | `pnpm --dir apps/api typecheck` | exit `0` |
| SDK | `pnpm --dir packages/sdk test` | `1829 pass`, `0 fail`, `7135 expect()` calls across `144` files |
| SDK types | `pnpm --dir packages/sdk typecheck` | exit `0` for the package and examples |
| SDK package | `pnpm --dir packages/sdk smoke:install` | packed install, Node ESM import, and client construction passed |
| CLI | `pnpm --dir apps/cli test` | `773 pass`, `0 fail`, `2736 expect()` calls across `71` files |
| CLI types | `pnpm --dir apps/cli typecheck` | exit `0` |
| CLI binary | `pnpm --dir apps/cli build` | built `dist/kortix` for `bun-linux-x64` with an attestation |
| Web | `pnpm --dir apps/web test` | `4963 pass`, `0 fail`, `19079 expect()` calls across `452` files |
| Web build | `pnpm --dir apps/web build` | production build passed; `/projects/[id]/tasks` is present in the route manifest |
| Web lint | ESLint over every changed and untracked Web file | `0` errors; `5` existing React-compiler or MDX-configuration warnings |
| Database | `pnpm --dir packages/db test` | `221 pass`, `18 skip`, `0 fail`, `476 expect()` calls across `25` files |
| Migrations | `pnpm --dir packages/db lint` | `198` migration files pass; Squawk reports `0` issues in `105` files |
| Shared | `pnpm --dir packages/shared test` | `298 pass`, `0 fail`, `857 expect()` calls across `20` files |
| API contract | `pnpm --dir packages/api-contract test` | `68 pass`, `0 fail`, `139 expect()` calls |
| Manifest schema | `pnpm --dir packages/manifest-schema test` | `361 pass`, `0 fail`, `571 expect()` calls across `7` files |
| Sandbox daemon | `pnpm --dir apps/kortix-sandbox-agent-server test` | `459 pass`, `0 fail`, `1086 expect()` calls across `44` files |
| Sandbox daemon types/build | `typecheck` and `build` package scripts | both exit `0`; binary built for `bun-linux-x64` |
| Whitespace | `git diff --check` | exit `0` |

The Web typecheck reports the repository's existing `test.each` typing errors
in three unchanged test files. The shared-package typecheck reports the existing
`project-glyphs.test.ts:32` assertion type error. Neither file differs from the
branch base.

The live local API returned `200` from `http://localhost:24608/v1/health`. The
production Web build and the running Web server expose the task route. The
unauthenticated running route correctly redirects to `/auth`.

A real project-scoped session token executed these three CLI creation forms:

```text
kortix tasks new --title "Probe task default" --json
kortix tasks new --title "Probe task fingerprint" --status todo --fingerprint agi-probe-20260809-1530 --json
kortix tasks new --title "Probe task assigned" --agent kortix --origin cli --json
```

All three commands exited `0`. Each response contained `goal_slug: null` and
`control_plane_version: 1`. The acceptance task
`5b53e8aa-347f-451c-b41b-693bcfb78871` then passed contract revision, claim,
current-task recovery, evidence submission, agent self-approval rejection, and
human completion. PostgreSQL records `status = done`, contract revision `2`,
evidence `1a9ea149-6356-4184-b4d6-f54a75326afd`, and candidate digest
`sha256:agi-task-cli-acceptance-v1`.

Authenticated browser DOM and network assertions remain unverified because the
in-app browser backend exposed no controllable browser.

A second real task exercised the complete durable lifecycle after the AGI rename:

```text
task: dcd2d0b6-e31d-48b7-b34a-3b0be788e2a8 (make 100$)
flow: claim -> worker -> blocker -> resolve -> reclaim -> artifact evidence -> review -> done
completed_at: 2026-08-09T18:04:09.732Z
artifact: TipOut — Tip & Split Calculator for Servers
deployment: 0a531c18-4392-4652-bd19-b65605c3b636, version 3, ready
candidate: sha256:e4e6b04a079c71689984be1ebee07bac45ef83da0fa3d2bc4c31dd3556346793
artifact HTTP: 200, 5687 bytes
```

The final artifact requirement stored `state = passed` for the same candidate
digest. The real CLI read the task with exit code `0` and returned
`status = done`. Project change request `#1` remains open and unmerged. All
temporary PATs used for this acceptance run were revoked.

The implementation remains isolated on `agi-task-system-v1`. It is not merged
or deployed. A draft pull request is the review boundary for integration,
migration application, conflict resolution against current `main`, and live Dev
verification.
