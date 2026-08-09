# Autonomous Agent Harness Architecture

Status: implementation decision
Date: 2026-08-06
Owner: Kortix product/infra
Related:
`docs/specs/2026-07-24-agi-system.md`,
`docs/specs/2026-07-26-agi-autonomous-operations.md`,
`docs/specs/2026-07-14-trigger-session-strategy.md`

## 1. Claim boundary

This system is a long-running autonomous-agent harness. It is not evidence that
the underlying model is artificial general intelligence.

There is no accepted binary AGI test:

- Legg and Hutter define intelligence as goal achievement across a broad range
  of environments: <https://arxiv.org/abs/0712.3329>.
- Chollet defines intelligence through skill-acquisition efficiency relative to
  priors and experience: <https://arxiv.org/abs/1911.01547>.
- Morris et al. separate performance, generality, and autonomy:
  <https://arxiv.org/abs/2311.02462>.

A process can operate for 30 days and remain narrow. Autonomy is a deployment
property. It is not proof of generality or human-level performance.

Kortix MUST evaluate capability, reliability, generality, learning, autonomy,
safety, and operating durability as separate dimensions. The acting model MUST
NOT be the sole verifier.

## 2. Terms

| Term | Exact boundary |
|---|---|
| **Substrate** | The platform-owned identity, authorization, session, trigger, connector, audit, change-request, and persistence services. The substrate does not reason. |
| **Sandbox** | One isolated Linux machine bound to one session, branch, agent, and credential. It contains untrusted execution. It is disposable. |
| **Harness** | The model loop that assembles context, invokes tools, and emits turns. OpenCode is the current harness. It is replaceable. |
| **Kernel** | A harness-local programmable working environment. Prime Agent uses persistent IPython. A kernel is optional and never authoritative storage. |
| **Autonomy** | The bounded control policy that decides when to start, continue, wait, escalate, or stop work. Kortix implements this above the harness. |
| **AGI agent** | The platform-owned `agi` coordinator. It decomposes goals and starts specialist Kortix sessions. It does not perform project work in its coordinator sandbox. |

These terms are not interchangeable. A sandbox is an isolation boundary. A
kernel is a working-memory convenience. Autonomy is a control policy. The
substrate owns durable state and authority.

## 3. Prime Agent comparison

The comparison uses Prime Agent public commit
[`87e7a7f1140ed7d4a14f656e6b902f99afad018b`](https://github.com/PrimeIntellect-ai/prime-agent/commit/87e7a7f1140ed7d4a14f656e6b902f99afad018b).

| Primitive | Prime Agent | Kortix decision |
|---|---|---|
| Session lifecycle | Local daemon, one worker per root tree, JSONL transcript, recovery journal | Keep Kortix API sessions, lifecycle queue, sandbox providers, and PostgreSQL leases. Do not port the local daemon. |
| Programmable kernel | Persistent IPython plus typed host requests | Do not make `dill` or a process namespace authoritative. Add a sandbox-local kernel only if evaluation proves it improves results. Host operations remain typed SDK/API calls. |
| Recursive workers | `rlm()` admits child sessions; results arrive through messages or files | Reuse `agi` plus ordinary Kortix sessions. Record task, parent session, budget, state, and result explicitly. |
| Goal | One session-scoped objective stored in its JSONL state | Store reviewed goal declarations in git. Store contended execution and measurement state in PostgreSQL. A session cannot own a durable goal. |
| Heartbeat | Session-local recurring prompts and schedules | Desugar goal `push` to the existing Kortix trigger subsystem. Do not add a heartbeat scheduler or wake queue. |
| Continual harness | Local/global JSON CRUD for prompts, memories, skills, and subagent descriptions | Keep durable knowledge in reviewed repository text. Add provenance, evidence, and rollback through git. Do not call unverified CRUD “learning.” |
| Compaction | Model-generated summary plus a retained transcript cut point | Treat summaries as derived checkpoints only. Preserve the authoritative event and artifact history. |
| Security | Workers and IPython use the caller's operating-system permissions | Execute untrusted work only inside Kortix cloud sandboxes. Keep credentials and irreversible effects behind server policy. |

Adopt Prime Agent's separation of session state, executor state, host policy, and
lifecycle supervision. Do not embed Prime Agent as a second platform runtime.
Do not reintroduce ACP or multi-harness transport for this feature. OpenCode
remains the sole session runtime.

## 4. State ownership

The storage question is answered by mutability and contention.

| State | Source of truth | Reason |
|---|---|---|
| Goal declaration, `done_when`, desired status, cadence, metric definitions | `kortix.yaml` in git | Human-authored, few, diffable, reviewable, portable. |
| Agent behavior and grants | Agent Markdown plus `kortix.yaml` in git | Authored policy and behavior require review. |
| Semantic memory, procedures, decisions, durable facts | Markdown, skills, and code in git | Durable organizational residue must survive every session and remain reviewable. |
| Task, dependency, assignee, claim, claim expiry | PostgreSQL | Generated, high-rate, and contended. An atomic conditional update must produce one winner. |
| Goal evaluation and metric observation | PostgreSQL | Each push has one durable identity. Append-only metric values bind to that identity and support deterministic health queries. |
| Trigger execution, session command, approval, external effect, audit | PostgreSQL | Operational coordination and ledgers require leases, idempotency, and queries. |
| Transcript and tool artifacts | Session store and artifact storage | Execution evidence. Not a substitute for durable organizational memory. |
| Kernel variables, process state, scratch files | Sandbox memory/disk | Disposable working state. Loss MUST NOT lose a goal, task, observation, authority rule, or durable result. |

A task MUST NOT be the system of record for anything that outlives it. A task
that creates a durable fact, decision, procedure, or deliverable MUST write that
residue back to the repository through a change request.

## 5. Smallest complete control loop

```text
recover durable goal and tasks
  -> read recent observations and blockers
  -> select or create one next task
  -> atomically claim it
  -> start one bounded specialist session
  -> authorize each effect before execution
  -> read back and verify the resulting state
  -> record task transition and metric evidence
  -> write durable residue to git through a change request
  -> continue, wait for the existing trigger, escalate, or stop
```

Only five product nouns are required: workspace, AGI, goal, task, and
trigger. Do not add an organization chart, workflow engine, wake queue, or
separate memory service.

## 6. Required invariants

1. A goal exists outside every session.
2. A task claim uses one atomic conditional database update.
3. A failed claim is an atomic loser. The caller selects different work.
4. A trigger is the only mechanism that starts work without a human.
5. Session idle is not task completion. A model response is not goal completion.
6. Goal completion requires an explicit status change with cited evidence.
7. A worker turn must change task state, record evidence, or record a delivered blocker.
8. The control plane permits one idempotent no-progress continuation. It then escalates.
9. Every continuation has time, token, cost, and iteration bounds.
10. Meta cannot merge its own change request or push a protected default branch.
11. A flat declared metric across three consecutive fired goal evaluations is a stall.
12. A declared metric missing from the latest fired evaluation is `unmeasurable`, not `on_track`.
13. A sandbox or kernel restart cannot repeat an irreversible effect.
14. The same session and principal identifiers join state, effect, and control records.

### 6.1 Implemented goal-evaluation contract

Each manual or scheduled goal push creates one idempotent PostgreSQL evaluation.
The existing trigger and lifecycle-command paths own its `queued`, `fired`, or
`failed` delivery state. Metric observations require the returned evaluation
identity. Lifecycle settlement persists `fired_at`; health orders only fired evaluations by that durable completion time and ignores failed or incomplete deliveries. It reports a
metric as `unmeasurable` without a finite value in the latest fired evaluation,
`stalled` after three consecutive fired evaluations contain the same finite
value, and `measuring` otherwise. The aggregate prioritizes `stalled`, then
`unmeasurable`, then `measuring`. Health never writes or infers the Git-authored
desired status.

### 6.2 Implemented task-worker liveness contract

PostgreSQL owns each coordinator-to-worker binding, immutable wall/token/cost/
iteration contract, deadline, admitted-iteration counter, progress evidence,
idempotent settlement replay, continuation consumption, escalation, and blocker.
Registration verifies the project, live coordinator claim, worker session, and
`metadata.spawned_by_session`. It atomically binds those identities and queues
the initial prompt through the existing session lifecycle outbox. The coordinator
creates the worker without a prompt before registration. Every server prompt
ingress rejects a marked but unbound child and a terminal bound worker. The
lifecycle engine and direct OpenCode proxy re-check admission immediately before
prompt dispatch.

The coordinator records exactly one of two outcomes for each server-owned `task.liveness_turn_id`: semantic evidence through `/progress`, or no progress through `/no-progress`. PostgreSQL rejects the opposite outcome for the same task and settlement id, including concurrent retries. Each accepted outcome advances or clears the current turn id.
`/no-progress` requires the current stable `settlement_id`. A replay returns the stored
action. The first distinct settlement queues the only continuation. A second
distinct settlement atomically blocks and releases the task, queues a
server-owned worker stop, and wakes the coordinator. Restarts cannot reset this
policy because every decision is stored and compare-and-set in PostgreSQL.

The server and PostgreSQL cap caller-selected contracts at 3,600 wall seconds,
1,000,000 tokens, USD 25, and 128 iterations. Meta can only narrow these
platform ceilings. It cannot expand them through request metadata.

The LLM gateway enforces bounds after billing and project budget checks. It
writes each completed managed request synchronously to `usage_events` with a
server-owned, per-account idempotency key. Admission, settlement, `/no-progress`,
and the liveness sweep read that ledger for actual LLM tokens and cost.
`gateway_request_logs` remains asynchronous observability data and is not an
authoritative liveness input. `sandbox_compute_sessions` supplies compute cost.
If the synchronous usage write fails, the server blocks the bounded task and
keeps the request fence closed instead of admitting unaccounted work. Iteration
admission atomically increments `liveness_iterations_admitted` before provider
dispatch. The existing singleton project-trigger scheduler sweeps active bounded
workers for wall, token, cost, compute, and iteration exhaustion. It does not add
a workflow engine or another scheduler.

A durable PostgreSQL admission fence permits one in-flight provider request per
bounded worker. Gateway completion and pre-dispatch error paths settle the fence
with the matching request ID. A crashed gateway cannot strand the fence forever:
its lease expires at the immutable worker wall deadline, and the recurring sweep
then blocks the task and releases its sessions. Token and cost limits can still
overshoot by the usage of that one admitted provider request because actual usage
exists only after the provider responds. Concurrent requests cannot multiply the
overshoot. Iteration admission remains exact because its counter increments in
the same atomic update that acquires the fence. Native provider calls, external
APIs, and delayed compute metering remain outside exact instantaneous token and
cost enforcement.

`queued` and `drained` describe local lifecycle-command handling only.
`drained` does not prove remote prompt delivery. An empty newly created worker
remains pending initial-prompt delivery and is not classified as settled or
no-progress. A liveness-stopped worker must not be revived.

The reserved AGI principal excludes broad project write, arbitrary session
stop, protected-branch push, and merge. Runtime Git clone credentials contain
only the Kortix proxy origin and the caller's existing Kortix token. Sandbox
tokens are read-only at the proxy. A session PAT must contain the literal
`project.gitops.push` grant for `receive-pack`; CR-open aliases, stale agent PATs,
unbound workers, terminal workers, and the meta principal cannot bypass that
gate. Server-owned finalization performs the bounded worker stop. Session
principals are attributed from authentication and can write only their assigned evaluation. Human
observations store `session_id = null` and cannot impersonate a project session.

## 7. Memory model

Use four cognitive categories without creating four storage products:

- **Working memory:** current prompt, task, and sandbox scratch state.
- **Episodic memory:** session transcript, task transitions, observations, and effect records.
- **Semantic memory:** evidence-backed facts and decisions written to repository Markdown.
- **Procedural memory:** versioned and tested skills or code in the repository.

Retrieval can start with repository search and explicit file loading. A vector
index MAY be added later as a reconstructible cache. It MUST NOT become the
source of truth.

## 8. Evaluation gate

Each evaluation row specifies a held-out task family, frozen model and harness,
budget, baseline, repeated trial count, executable success test, and failure
taxonomy.

Minimum reported metrics:

- final-state task success and partial milestones;
- `pass@k` and reliability-oriented `pass^k`;
- tokens, currency, wall-clock time, and human minutes;
- uninterrupted task horizon and intervention rate;
- restart recovery, duplicate-effect count, stuck-run rate, and cost leaks;
- stale-memory, negative-transfer, and prompt-injection failures;
- policy denials, approval bypasses, and harmful side effects.

Relevant evaluation guidance:

- GAIA: <https://arxiv.org/abs/2311.12983>
- AgentBench: <https://arxiv.org/abs/2308.03688>
- METR task horizons: <https://arxiv.org/abs/2503.14499>
- AgentDojo: <https://arxiv.org/abs/2406.13352>
- AI Agents That Matter: <https://arxiv.org/abs/2407.01502>
- NIST AI RMF 1.0: <https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf>

The product MAY use “AGI” as a concise name for the AGI experience. The
technical documentation and evidence MUST call it a long-running autonomous-
agent harness until a predeclared AGI definition and independently reproduced
threshold are satisfied.
