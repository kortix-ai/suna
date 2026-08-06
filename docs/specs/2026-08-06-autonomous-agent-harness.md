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
| **Meta agent** | The platform-owned `meta` coordinator. It decomposes goals and starts specialist Kortix sessions. It does not perform project work in its coordinator sandbox. |

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
| Recursive workers | `rlm()` admits child sessions; results arrive through messages or files | Reuse `meta` plus ordinary Kortix sessions. Record task, parent session, budget, state, and result explicitly. |
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
| Goal metric observation | PostgreSQL | Append-only time series written at machine rate and queried by range. |
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

Only five product nouns are required: workspace, meta agent, goal, task, and
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
11. A flat declared metric across three consecutive goal pushes is a stall.
12. A goal with no observation for a declared metric is `unmeasurable`, not `on_track`.
13. A sandbox or kernel restart cannot repeat an irreversible effect.
14. The same session and principal identifiers join state, effect, and control records.

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

The product MAY use “AGI” as a concise name for the meta-agent experience. The
technical documentation and evidence MUST call it a long-running autonomous-
agent harness until a predeclared AGI definition and independently reproduced
threshold are satisfied.
