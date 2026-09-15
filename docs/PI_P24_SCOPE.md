# P2.4 closure — every consumer understands two runtimes

P2.4 started with 49 candidate single-runtime assumptions. The audit confirmed
28 defects and dismissed 21 candidates. All 28 confirmed defects are closed on
the `pi-worker` branch.

The session owns two independent runtime rows:

- `session_sandboxes` stores the Pi worker.
- `session_environments` stores the workspace environment.
- `project_sessions.session_id` is the shared logical session identity.
- Each physical runtime has a stable UUID and a distinct session token.

## Closure matrix

| # | Surface | Defect | Closure |
|---|---|---|---|
| 1, 10, 15, 23–25 | Billing | The invariant sweep treated every environment as a missing worker and closed its meter. | `workload_type='environment'`, the environment join, liveness stamping, missing-window recovery, and both invariant counters now treat environments as first-class compute. |
| 2, 11, 16 | Automatic stop | Reapers parked the worker but left its environment running. | The environment reconciler derives its action from durable session and worker state. It covers every stop writer without adding another parallel stop path. |
| 3, 12, 26 | Provider drift | An `active` row over a stopped or removed provider box wedged every tool call. | `ensureSessionEnvironment` checks provider state. It resumes stopped boxes and rebuilds removed boxes. Provider webhooks reconcile both runtime tables. |
| 4 | Provision/delete race | A detached environment create could publish after session deletion and leak a box. | Provision attempts carry an ownership token. Activation requires the same attempt and a live parent session. A losing attempt removes its provider box and closes metering. |
| 5 | Egress pin | Worker and environment competed for one first-write-wins pin. | Each runtime stores and verifies its pin on its own row. |
| 6 | Runtime authentication | Both boxes shared one token, so the API could not identify the caller. | `account_tokens.runtime_kind` and `runtime_id` bind one token to one physical runtime. A separate purpose-bound secret authenticates worker-to-environment RPC. Legacy null fields resolve to the worker during rollout. |
| 7 | Runtime projection | An environment could overwrite the worker projection. | The projection route accepts only a worker principal. |
| 8 | Proxy URLs | One session proxy URL was used for control and workspace traffic. | The SDK exposes worker and environment targets separately. Workspace consumers use the environment. Control and conversation consumers use the worker. |
| 9 | Prompt environment sync | Secret and runtime environment updates reached only the worker. | Prompt sync updates the worker and every already-active environment. It does not provision an unused environment. |
| 13 | Worker client cache | The worker kept a dead environment URL for its full lifetime. | Transport failures clear the cached client, re-run ensure once, and retry once. Ordinary tool errors do not reattach. |
| 14 | Error metadata | An error replaced environment metadata and erased its metering identity. | Error writes merge JSON metadata. |
| 17 | Restart | Restart repaired only the worker. | Restart coordinates both runtime rows and retains one turn authority: the worker. |
| 18–21 | SDK and React | The public runtime registry, files, preview URL, proxy URL, and `useSession` assumed one box. | Additive runtime-target APIs expose worker and environment roles. Files, terminal, preview, and services resolve the environment. Message and control paths resolve the worker. |
| 22 | Database identity | The environment UUID existed only inside JSON metadata. | `session_environments.environment_id` is a real nullable UUID column. New rows always set it. JSON remains a legacy fallback. |
| 27 | Account deletion | Account deletion left environment boxes and meters alive. | Account teardown enumerates and deletes environment runtimes with the other compute resources. |
| 28 | Public shares | Preview and file shares targeted the worker, where the requested port does not run. | Public-share resolution prefers the environment runtime for Pi sessions. |

## Executable lifecycle policy

| Worker | Environment | Legal | Control-plane action | Turn authority |
|---|---|---:|---|---|
| missing | missing | yes | none | none |
| missing | any row | no | delete environment | none |
| live | missing, stopped, or error | yes | lazy ensure | worker |
| live | provisioning | yes | wait | worker |
| live | active | yes | serve | worker |
| parked | active or provisioning | no | stop environment | none |
| parked | missing, stopped, or error | yes | none | none |

`apps/api/src/platform/services/session-runtime-state.ts` is the executable
source for this matrix. The environment never owns a turn and never extends a
parked worker's lifetime.

## Migration contract

`20260903080719873_pi_runtime_identity.sql` adds three nullable columns:

- `account_tokens.runtime_kind`
- `account_tokens.runtime_id`
- `session_environments.environment_id`

The migration adds no default and rewrites no existing row. New runtime rows
and tokens receive explicit UUIDs. Existing tokens remain valid as worker
tokens until their sessions end.

## Verification

The focused suites cover billing, every lifecycle state, provider reconciliation,
runtime routing, SDK targets, browser consumers, distinct credentials, egress
pins, secret sync, public shares, and the real PostgreSQL migration.

The deployed system test must also prove these black-box facts:

1. The API health SHA equals the `pi-worker` branch tip.
2. A fresh session returns assistant text from the worker.
3. The first workspace tool provisions an environment and reads or writes there.
4. The worker disk remains unchanged after workspace operations.
5. A second tool call reuses the same environment.
6. Stop and resume recover both runtimes.
7. The SDK and browser resolve workspace URLs to the environment.
8. Another account cannot read the session or its filesystem.
