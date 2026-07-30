# Session-start latency and ACP architecture

> **Not shipped — reverted on 2026-07-30.** ACP and multi-harness
> (`kortix_version: 3`, Claude Code / Codex / Pi) are experimental, unreleased,
> and off by default (`KORTIX_ACP_RUNTIME=false`). OpenCode REST +
> `kortix_version: 2` are the shipped default. Read this file as a historical
> record, not as current product guidance.

**Date:** 2026-07-29

**Status:** Measured baseline, canonical ACP starter, selected-harness
refactor, and target architecture

**Scope:** Daytona, Platinum, local, dev, production, OpenCode, Pi, ACP, and
repository materialization

## 1. Answer

The normal OpenCode sandbox process already uses ACP.

`opencode.start()` is a sandbox-daemon method. It starts `opencode acp` and
waits for ACP `initialize`.

The Kortix SDK does not call this method. The SDK calls the Kortix session
lifecycle route.

The measured cold path performs two expensive operations:

1. It materializes the repository.
2. It starts and initializes a cold OpenCode process.

The sub-one-second target requires both operations to leave the claim path.

New blank projects use one canonical starter:

1. The starter ID is `general-knowledge-worker`.
2. The manifest uses `kortix_version: 3`.
3. OpenCode is the default logical agent.
4. Claude Code, Codex, and Pi are selectable logical agents.
5. Project creation enables `experimental.acp_runtime`.
6. The retired `acp-multi-harness` ID maps to the canonical starter.

This consolidation does not reduce provider startup latency by itself.

It makes every new project compatible with commit artifacts and stateful
runtime slots. It also removes starter selection from the boot architecture.

The multi-harness implementation on `origin/main` had a third problem.

It started legacy OpenCode before it started the selected ACP harness.

Selecting Pi therefore added Pi startup after OpenCode startup.

This branch removes legacy OpenCode from a managed session. It starts and
initializes only the selected ACP harness.

## 2. Current call graph

```text
@kortix/sdk session.start() or useSession()
  -> POST /v1/projects/:projectId/sessions/:sessionId/start
  -> API session lifecycle
  -> provider create or resume
  -> sandbox entrypoint
  -> kortix-sandbox-agent-server
  -> repository materialization
  -> selected runtime branch
       -> legacy session:
            opencode.start()
            -> spawn opencode acp
            -> ACP initialize
       -> managed session:
            AcpRuntime.getOrCreate(selected harness)
            -> spawn selected ACP harness
            -> ACP initialize
  -> ACP session/new or session/resume
  -> runtimeReady
```

These methods share the word `start`. They have different responsibilities.

| name | owner | operation |
|---|---|---|
| SDK `session.start()` | `@kortix/sdk` | Calls the Kortix lifecycle API |
| API `/sessions/:sessionId/start` | `apps/api` | Resolves or provisions runtime capacity |
| daemon `opencode.start()` | sandbox daemon | Starts and initializes the legacy OpenCode ACP process |
| ACP `session/new` | runtime harness | Creates the canonical harness session |

## 3. ACP status

The normal process launch is:

```text
opencode acp --port <port> --hostname 127.0.0.1 --cwd <workspace>
```

The default process transport is `acp`.

The repository contains two OpenCode compatibility surfaces:

1. A low-level `opencode serve` process rollback.
2. An SDK REST compatibility client for the OpenCode internal HTTP server.

Managed ACP sessions no longer start these surfaces. Legacy sessions keep them.

The client and process transports are separate concepts.

## 4. Comparable starter-project baseline

Each target contains five sequential sessions.

Every sample used a `default-cold` image.

| environment | provider | ready p50 | ready p90 | provider create p50 | repository p50 | OpenCode ACP initialize p50 | ACP session p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| production | Daytona | 22.430 s | 46.467 s | 1.412 s | 7.764 s | 7.222 s | 768 ms |
| production | Platinum | 27.279 s | 32.202 s | 2.271 s | 6.287 s | 12.973 s | 1.639 s |
| dev | Daytona | 20.573 s | 47.840 s | 5.197 s | 5.974 s | 7.610 s | 698 ms |
| dev | Platinum | 29.103 s | 33.167 s | 2.427 s | 6.923 s | 12.385 s | 1.651 s |
| local | Daytona | 15.222 s | 17.795 s | 1.898 s | 3.978 s | 6.996 s | 820 ms |
| local | Platinum | 20.728 s | 21.770 s | 2.055 s | 2.873 s | 11.977 s | 1.602 s |

Raw files:

- `tests/performance/session-start/results/2026-07-29/production-starter.json`
- `tests/performance/session-start/results/2026-07-29/dev-starter.json`
- `tests/performance/session-start/results/2026-07-29/local-starter.json`
- `tests/performance/session-start/results/2026-07-29/session-boot-analysis.json`

### 4.1 Platinum exact-commit repository image

The current `kortix-ppwarm-*` path is a repository disk image.

Its key contains:

```text
project_id
+ template_slug
+ exact_commit_sha
+ base_runtime_snapshot
```

It is not a daily snapshot.

A commit or runtime identity change creates a different key.

The image contains:

1. The exact repository checkout and `.git`.
2. Runtime disk files.
3. Baked dependency and runtime caches.

The image does not contain:

1. VM memory.
2. A running sandbox daemon.
3. A running Pi or OpenCode process.
4. An initialized ACP connection.
5. A pre-created ACP session.

The provider build uses `capture: 'none'`.

The same project and commit produced two cold controls and five image hits.

| phase | cold controls | image-hit p50 |
|---|---:|---:|
| Image resolution | 2.533s, 2.554s | 105ms |
| Platinum create | 2.097s, 2.250s | 2.108s |
| Repository materialization | 2.341s, 2.528s | 39ms |
| Selected Pi harness boot | 431ms, 431ms | 460ms |
| Create to runtime ready | 7.928s, 8.734s | 3.863s |
| ACP initialize | 238ms, 221ms | 301ms |
| ACP `session/new` | 5.357s, 5.107s | 5.270s |
| **Create to session ready** | **14.223s, 14.222s** | **9.462s** |

All five image-hit sessions used
`kortix-ppwarm-b941768b-37a8eec1-e516c44c8217`.

The retained guest returned
`85f0efd3b8232796d6b3cef382481e3fa7857ae4` for
`git rev-parse HEAD`.

The first image build failed after 9m 15.402s.

Platinum returned no detailed build error.

The retry completed after 10m 10.923s.

The raw records are under
`tests/performance/session-start/results/2026-07-29/platinum-warm-rerun-20260729T140943Z`.

## 5. Exact ACP image warm-up A/B

The image build ran ACP `initialize` and `session/new`.

Both providers booted `kortix-default-9f0b65e21921`.

| provider | ready | provider create | repository | first ACP output | ACP initialize | root session |
|---|---:|---:|---:|---:|---:|---:|
| Daytona | 35.997 s | 2.066 s | 5.593 s | 23.314 s | 299 ms | 1.202 s |
| Platinum | 41.310 s | 13.209 s | 10.749 s | 8.466 s | 631 ms | 3.210 s |

The runtime HOME is `/home/kortix` on both providers.

Both providers retained these image files:

```text
/home/kortix/.local/share/opencode/opencode.db
/home/kortix/.local/share/opencode/opencode.db-shm
/home/kortix/.local/share/opencode/opencode.db-wal
```

The main database size was 249,856 bytes on both providers.

The persisted database did not remove project configuration loading.

Daytona loaded the project `opencode.jsonc` at `00:31:23.184Z`. It completed
the configuration stage at `00:31:44.681Z`. This stage took 21.497 seconds.

Platinum loaded the project `opencode.jsonc` at `00:31:40.637Z`. It completed
the configuration stage at `00:31:46.961Z`. This stage took 6.324 seconds.

The image retained the database. OpenCode still evaluated the project
configuration and plugins for the new process and workspace.

Raw files:

- `tests/performance/session-start/results/2026-07-29/local-baked-acp-a-b.json`
- `tests/performance/session-start/results/2026-07-29/local-baked-acp-a-b-cache-inspection.json`

## 6. What `opencode.start()` measures

The historical `opencode-spawned` mark occurs after `opencode.start()` returns.

`opencode.start()` returns after ACP `initialize`.

The mark therefore includes:

1. Binary resolution.
2. Working-directory resolution.
3. Environment and auth materialization.
4. OpenCode configuration construction.
5. Child process creation.
6. OpenCode internal server startup.
7. OpenCode configuration and plugin loading.
8. The first ACP output.
9. ACP `initialize`.
10. Optional canonical session resume.

It does not measure only process creation.

The new timeline adds these marks:

```text
runtime-binary-resolved
runtime-cwd-resolved
runtime-config-ready
runtime-process-spawned
runtime-acp-first-output
runtime-acp-initialized
runtime-canonical-session-resumed
runtime-session-new-requested
runtime-session-resume-requested
```

## 7. OpenCode local isolation

OpenCode version: `1.18.7`.

The benchmark uses the Kortix starter OpenCode configuration.

| HOME state | process spawn p50 | first ACP output p50 | ACP initialize p50 | `session/new` p50 | total p50 |
|---|---:|---:|---:|---:|---:|
| fresh | 1.733 ms | 7.547 s | 7.659 s | 186 ms | 7.841 s |
| warmed by `opencode serve` | 1.014 ms | 471 ms | 556 ms | 166 ms | 722 ms |
| warmed by exact ACP lifecycle | 1.147 ms | 436 ms | 522 ms | 171 ms | 700 ms |
| persistent ACP-warmed HOME | 1.080 ms | 428 ms | 513 ms | 166 ms | 679 ms |

The cold delay occurs before the first ACP output.

Node child process creation is not the delay.

ACP JSON-RPC negotiation adds approximately 80–130 ms after first output.

The old `opencode serve` warm-up produces a locally warm HOME.

The image A/B proves that HOME persistence is insufficient. A running warmed
process avoids project configuration evaluation. A database-only snapshot does
not avoid it.

## 8. Pi comparison

Pi version: `0.81.1`.

| path | result |
|---|---:|
| Fresh `pi --mode rpc` to `get_state`, p50 | 439 ms |
| In-process module import, one time | 372 ms |
| In-process `createAgentSession()`, p50 | 2.865 ms |
| Third-party `pi-acp` initialize, p50 | 91 ms |
| Third-party `pi-acp` `session/new`, p50 | 1.549 s |
| Third-party `pi-acp` total, p50 | 1.635 s |

The third-party adapter starts a separate Pi process during `session/new`.

The target Pi design must keep Pi imported in the sandbox daemon.

The daemon must expose a Kortix-owned ACP adapter around in-process Pi sessions.

This design removes repeated module and process startup.

Pi does not remove repository materialization.

The registered Pi adapter is `pi-acp`.

The selected-harness refactor removes the OpenCode delay from Pi sessions.

It does not remove the `pi-acp` child process created during `session/new`.

## 9. Repository refresh and runtime reload

The repository already exposes a no-restart workspace refresh:

```text
POST /kortix/refresh?base=1&base_sha=<sha>&restart=0
```

The refresh route can:

1. Fetch and check out an exact `base_sha`.
2. Preserve the sandbox daemon.
3. Preserve the harness process when `restart=0`.

The route comment says a file watcher applies changes.

That statement is not valid for every OpenCode configuration file.

OpenCode `1.17.11` ACP exposes these session operations:

1. `session/new`
2. `session/load`
3. `session/list`
4. `session/resume`
5. `session/close`
6. `session/fork`

ACP does not expose a configuration refresh or runtime reload method.

OpenCode ACP caches one directory snapshot.

That snapshot contains providers, models, agents, commands, and the default
model.

The ACP implementation defines `Directory.refresh()`.

No ACP method calls it.

The TUI worker exposes an internal `rpc.reload()`.

That method invalidates configuration and disposes all project instances.

It is a full instance teardown.

It is not an ACP method or a hot configuration refresh.

OpenCode plugin v2 also exposes domain reload operations for agents, catalogs,
commands, integrations, references, and skills.

These operations reload plugin transform state.

They do not provide a standard ACP runtime reload method.

Use this update policy:

| changed path or state | action before ready |
|---|---|
| Ordinary repository source, tests, assets, or data | Exact-SHA checkout; keep the harness |
| `AGENTS.md` or agent definitions | Dispose and recreate the project instance or restart the harness |
| `.kortix/opencode/skills/**` or commands | Dispose and recreate the project instance or restart the harness |
| `.kortix/opencode/opencode.jsonc` or plugins | Restart the harness |
| Provider catalog, model routing, or harness environment | Restart the harness |
| Harness binary or runtime digest | Claim a matching seed; do not reuse the incompatible seed |

The first implementation must restart on every configuration-sensitive diff.

A later implementation can use OpenCode domain reloads after live parity tests.

Never mark a session ready with stale runtime configuration.

## 10. Target architecture

### 10.1 Commit artifact

Create one content-addressed project artifact per accepted commit:

```text
artifact key =
  project_id
  + exact_commit_sha
  + runtime_digest
  + template_digest
  + harness
  + harness_version
  + harness_config_digest
```

The artifact contains:

1. An immutable repository lower layer.
2. Resolved project runtime configuration.
3. Installed project dependencies when the manifest requests them.
4. A verified runtime cache manifest.

Build the artifact asynchronously after each accepted commit.

Use push, merge, and repository webhook events as freshness triggers.

Run a daily reconciliation sweep to recover missed events.

The daily sweep does not replace exact-commit keys.

Do not clone during session claim.

### 10.2 Running runtime slot

Maintain already-running slots for each provider, region, runtime image, and
harness.

Each slot contains:

1. The sandbox daemon.
2. An initialized ACP harness.
3. A pre-created blank canonical ACP session.
4. Session-independent LLM and executor proxy configuration.
5. A stable workspace mount point.

### 10.2.1 Fully stateful seed

A fully stateful seed completes these operations before capture:

1. Materialize the exact repository commit.
2. Start the sandbox daemon.
3. Start the selected harness.
4. Complete ACP `initialize`.
5. Create one blank ACP session.
6. Load repository agents, skills, commands, plugins, and model state.
7. Verify ACP events and PTY traffic.
8. Capture disk and process memory.

Capture occurs before session credentials enter memory.

The seed uses session-independent local LLM and executor proxies.

The claim path injects real credentials into those proxies.

The current sandbox daemon contains dormant seed-adoption code for this model.

The API disabled this path after Platinum restores passed `/kortix/health` while
ACP or PTY traffic stalled.

### 10.3 Session claim

The claim path performs only bounded local operations:

```text
reserve slot
  -> inject session tokens into local proxies
  -> attach commit artifact as immutable lower layer
  -> create writable session overlay
  -> create local session branch
  -> create or reset canonical ACP session
  -> return runtimeReady
```

For a stateful seed, `create or reset canonical ACP session` means adopting the
blank captured session.

It must not call the current third-party Pi `session/new`.

That call starts another Pi process and costs approximately five seconds in the
Platinum measurements.

Target budget:

| phase | p50 budget | p95 budget |
|---|---:|---:|
| Slot reservation | 25 ms | 75 ms |
| Token and environment adoption | 25 ms | 75 ms |
| Artifact and overlay attach | 75 ms | 200 ms |
| Branch creation and repository verification | 50 ms | 150 ms |
| ACP session reset or creation | 50 ms | 250 ms |
| API and network overhead | 75 ms | 200 ms |
| **Total** | **300 ms** | **950 ms** |

### 10.4 Commit race and miss behavior

The latest commit can miss the artifact cache.

Do not wait for the 10-minute exact-commit build.

Use this fallback:

1. Resolve the requested default-branch SHA.
2. Claim the newest compatible stateful seed.
3. Fetch the requested exact SHA.
4. Create the session branch from that SHA.
5. Classify the diff from the seed SHA to the requested SHA.
6. Reload or restart runtime configuration when the diff requires it.
7. Verify `HEAD == requested_sha`.
8. Verify the harness and blank ACP session.
9. Mark the session ready.
10. Continue the exact-commit seed build asynchronously.

Do not use unqualified `git pull`.

`git pull` follows a moving branch.

Use an exact SHA fetch and checkout.

Collapse queued intermediate builds.

Build only the newest unresolved default-branch tip.

The API must record one explicit artifact state:

1. `ready`: exact commit artifact is attached.
2. `building`: exact commit artifact is being created.
3. `stale_available`: an older verified artifact is available.
4. `failed`: exact artifact creation failed.

The API must not silently attach an older commit.

The API can use an older compatible seed as an acceleration layer.

It must complete the exact-SHA update and runtime reload before it returns
`ready`.

### 10.5 Provider implementation

Daytona requires running sandbox slots.

Platinum can use running slots now.

Platinum process-memory restore remains disabled until it passes:

1. Network receive stress.
2. ACP SSE stress.
3. PTY stress.
4. Long-running prompt stress.
5. Repeated restore stress.

The previous stateful restore path kept `/kortix/health` available while ACP and
PTY traffic stalled. A health response alone is not restore proof.

## 11. Implemented first step

This branch changes the managed runtime path:

1. It skips legacy `opencode.start()`.
2. It skips OpenCode dependency preparation for non-OpenCode harnesses.
3. It injects managed skills only into the selected harness.
4. It initializes the selected ACP connection before `runtimeReady`.
5. It records process spawn, first ACP output, and ACP initialization.
6. It stops inherited prestarted OpenCode when the adopted session selects a
   managed harness.

The legacy OpenCode path remains available when no managed ACP server exists.

## 12. Delivery sequence

1. Deploy the granular runtime marks and selected-harness refactor.
2. Benchmark selected Pi and selected OpenCode on local and dev.
3. Add the in-process Pi ACP adapter.
4. Run OpenCode and Pi feature-parity tests.
5. Enable already-running harness-specific slot claims.
6. Move repository materialization to commit artifacts and overlays.
7. Fail artifact publication when its repository or runtime manifest is absent.
8. Remove the OpenCode REST process rollback.
9. Remove the SDK REST compatibility client.

Steps 8 and 9 simplify the architecture. They are not the first latency levers.

## 13. Acceptance criteria

All criteria apply separately to Daytona and Platinum.

| path | requirement |
|---|---|
| Warm exact-commit claim | p50 below 500 ms and p95 below 1 s |
| Cold exact-commit miss | Every phase is attributed |
| Repository correctness | `HEAD` equals requested `base_sha` |
| Runtime correctness | ACP `initialize` and canonical session succeed |
| Event correctness | ACP SSE receives prompt, tool, and idle events |
| Terminal correctness | PTY input and output remain live |
| Restart correctness | Canonical session resumes without duplicate prompt |
| Security | No project or session token exists in the immutable artifact |

## 14. Current decision

Do not remove an ACP readiness wait.

Remove legacy `opencode.start()` from managed ACP sessions.

Keep the harness initialized before a user requests a session.

Use commit artifacts and writable overlays instead of repository clone.

Build Pi in-process behind the same ACP contract.

## 15. Post-deploy dev proof

Dev API commit `7935cd9360afbd8f182ba6ac1dd12d0b3fdb6d3e` contains the
selected-harness change.

The live API returned:

```text
status=ok
version=0.11.1-dev.7935cd93
environment=dev
```

The first Daytona Pi session missed the snapshot cache.

| phase | elapsed |
|---|---:|
| Row and tokens | 499 ms |
| Snapshot cache resolution | 341.853 s |
| Daytona create | 1.237 s |
| Host provision total | 343.589 s |
| Guest repository materialization | 5.418 s |
| Pi ACP initialization after repository | 132 ms |
| Guest ACP ready | 5.575 s |

The first chat request used `kortix/glm-5.2`.

It returned `503` after the API's 25-second processing deadline.

The second Daytona Pi session hit the snapshot cache.

| phase | elapsed |
|---|---:|
| Row and tokens | 658 ms |
| Snapshot cache resolution | 94 ms |
| Daytona create | 1.569 s |
| Host provision total | 2.320 s |
| Guest repository materialization | 15 ms |
| Pi ACP initialization after repository | 136 ms |
| Guest ACP ready | 183 ms |

The second chat lifecycle used `kortix/deepseek-v4-flash`.

It passed the initial response, follow-up, transcript reload, restart, and
post-restart response.

The live daemon reported:

```text
runtimeReady=true
runtime_harness=pi
opencode=down
opencode_pid=null
runtime-acp-initialized=183ms
```

The guest repository returned the same SHA for `HEAD` and remote `main`:

```text
8de781b942a3154dfd23ed7918ada8ae97f7c4a9
```

The raw record is
`tests/performance/session-start/results/2026-07-29/dev-pi-post-deploy.json`.

The result isolates three separate costs:

1. ACP is a protocol. It does not remove provider or repository latency.
2. Selected Pi removes the OpenCode process from the readiness path.
3. Exact artifact cache hits remove snapshot build and repository clone costs.

## 16. Startup-only Pi and OpenCode comparison

The startup boundary is ACP model selection completion.

The boundary excludes prompt dispatch, model execution, gateway latency, and
first-token latency.

| configuration | samples | runtime ready p50 | `session/new` p50 | session ready p50 |
|---|---:|---:|---:|---:|
| Pi, Daytona repository disk snapshot | 8 | 4.047 s | 2.987 s | 7.784 s |
| Pi, Platinum cold disk snapshot | 6 | 7.132 s | 5.127 s | 12.823 s |
| OpenCode, Platinum cold disk snapshot | 5 | 15.001 s | 641 ms | 16.298 s |

The Platinum rows use the same starter repository and snapshot state.

Pi reaches session readiness 3.475 seconds before OpenCode.

Pi saves 7.869 seconds during runtime boot.

Pi loses 4.486 seconds during `session/new`.

The comparable Platinum p50 events are:

| event | Pi | OpenCode |
|---|---:|---:|
| `POST /sessions` | 33 ms | 33 ms |
| Git authentication | 3 ms | 3 ms |
| Environment variables | 26 ms | 34 ms |
| Background allocation kicked | 48 ms | 47 ms |
| Row and service tokens | 47 ms | 47 ms |
| Cached image resolution | 2.396 s | 1.469 s |
| Platinum sandbox creation | 2.018 s | 2.094 s |
| Static web server | 22 ms | 22 ms |
| Git identity | 32 ms | 34 ms |
| Daemon proxy | 11 ms | 11 ms |
| Repository materialization | 1.645 s | 1.741 s |
| Selected harness configuration | 2 ms | 4 ms |
| Legacy OpenCode supervisor skipped | 4 ms | 4 ms |
| Selected process spawn call | 4 ms | 6 ms |
| Spawn to first ACP output | 417 ms | 8.451 s |
| First ACP output to initialized | 0 ms | 651 ms |
| Create to runtime ready | 7.132 s | 15.001 s |
| ACP stream open | 74 ms | 71 ms |
| ACP initialize | 294 ms | 237 ms |
| ACP `session/new` | 5.127 s | 641 ms |
| ACP model selection | 150 ms | 515 ms |
| Create to session ready | 12.823 s | 16.298 s |

Percentiles are calculated independently.

Nested event values overlap with runtime-ready totals.

## 17. Snapshot terminology

The Daytona benchmark did not use a stateful snapshot.

It used a repository disk snapshot.

The snapshot contains repository files. It does not preserve:

1. VM memory.
2. Running processes.
3. Open sockets.
4. An initialized ACP server.
5. An active Pi or OpenCode session.

A stateful snapshot preserves VM memory and process state.

The useful capture point is after repository materialization and ACP
initialization.

The capture must occur before session-specific secrets and identity enter the
runtime.

The restored runtime must adopt these values after restore:

1. `session_id`.
2. Session and project tokens.
3. Environment revision.
4. Repository commit overlay.
5. Canonical ACP session identity.

Capturing the current third-party `pi-acp` before `session/new` is
insufficient.

`pi-acp` starts Pi during `session/new`.

Capturing it after `session/new` preserves one session-specific Pi child
process.

The reusable Pi capture point requires a persistent in-process Pi ACP server.

## 18. Exact Pi `session/new` cause

Kortix pins these runtime versions:

| component | version |
|---|---:|
| OpenCode | 1.17.11 |
| Claude Agent ACP | 0.58.1 |
| Codex ACP | 1.1.2 |
| Pi ACP | 0.0.31 |
| Pi coding agent | 0.80.6 |

The npm packages for `pi-acp@0.0.31` and `0.0.32` contain the same
`session/new` startup sequence.

One request performs these operations:

1. Load slash commands and Pi settings.
2. Spawn `pi --mode rpc --no-themes`.
3. Call `get_state` inside `PiRpcProcess.spawn()`.
4. Call `get_state` inside `SessionManager.create()`.
5. Call `get_state` inside `newSession()`.
6. Call `get_available_models` inside `newSession()`.
7. Construct ACP model, mode, and configuration responses.

One Pi `session/new` starts one child process.

It performs three `get_state` requests.

It performs one `get_available_models` request.

Measured costs are:

| path | p50 |
|---|---:|
| Pi RPC through `get_state` | 503.195 ms |
| Third-party `pi-acp` `session/new` | 1.865 s |
| Daytona `pi-acp` `session/new` | 2.987 s |
| Platinum `pi-acp` `session/new` | 5.127 s |
| In-process `createAgentSession()` | 3.819 ms |

OpenCode creates sessions inside one initialized `opencode acp` process.

Its comparable Platinum `session/new` p50 is 641 ms.

ACP does not cause the Pi delay.

The third-party Pi adapter architecture causes the Pi delay.

## 19. ACP reference implementations

ACP defines a protocol and SDKs.

It does not define one mandatory agent architecture.

The ACP TypeScript documentation names Gemini CLI as the complete
production-ready reference agent.

Current implementations use these patterns:

| agent | implementation | session architecture |
|---|---|---|
| Gemini CLI | Native ACP | Creates configuration, client, chat, and session objects in one process. |
| Codex | `@agentclientprotocol/codex-acp` | Starts one persistent `codex app-server`. ACP sessions map to threads. |
| Claude | `@agentclientprotocol/claude-agent-acp` | Creates one Agent SDK `query()` per ACP session. The SDK owns executable lifecycle. |
| OpenCode | Native `opencode acp` | Implements ACP inside the OpenCode process. |
| Pi | `svkozak/pi-acp` | Starts `pi --mode rpc --no-themes` during every `session/new`. |

The ACP registry lists `svkozak/pi-acp` as the Pi adapter.

Kortix uses it because no other Pi adapter is registered.

It is an MVP adapter. It is not a latency-optimized server.

The target Pi implementation must use this design:

1. Start one Kortix-owned ACP process.
2. Use the current ACP TypeScript `agent()` API.
3. Import `@earendil-works/pi-coding-agent` once.
4. Load project resources once.
5. Create Pi sessions through in-process `createAgentSession()`.
6. Translate `AgentSession` events into ACP updates.
7. Use the Pi `SessionManager` for persistence and resume.
8. Remove Pi RPC IPC from `session/new`.

Inspected sources:

- ACP protocol:
  <https://github.com/agentclientprotocol/agent-client-protocol/tree/e67a7d4625c0aea6b5a8ea2dd48d2c890cd2eb06>
- Gemini CLI:
  <https://github.com/google-gemini/gemini-cli/tree/3499c84f7b8e70c86600e7cd2c67a7c65a667f5e/packages/cli/src/acp>
- Claude Agent ACP:
  <https://github.com/agentclientprotocol/claude-agent-acp/tree/d7a65ce1d042a90d24a71279a319735cb9200bf8>
- Codex ACP:
  <https://github.com/agentclientprotocol/codex-acp/tree/ba5bef59cfcea4229841fe9438d816696621307b>
- Pi ACP:
  <https://github.com/svkozak/pi-acp/tree/2f6e3c5>
- Pi SDK:
  <https://github.com/badlogic/pi-mono/blob/cced6a21da273b26ee4a23a803680614bbe8dd1e/packages/coding-agent/docs/sdk.md>

## 20. Stateful target architecture

Use this immutable snapshot key:

```text
runtime digest + repository commit + runtime configuration digest + harness
```

Build the stateful runtime in this sequence:

1. Restore or create the exact runtime disk state.
2. Materialize the exact repository commit.
3. Install runtime configuration dependencies.
4. Start the sandbox daemon.
5. Start and initialize the selected ACP harness.
6. Verify ACP initialization, repository SHA, PTY, and network state.
7. Remove session-specific credentials.
8. Capture VM memory and disk state.

Claim a session in this sequence:

1. Restore the exact stateful snapshot.
2. Rebind provider network and ingress state.
3. Attach a writable repository overlay.
4. Create the local session branch.
5. Adopt session tokens and the environment revision.
6. Create or reset the canonical ACP session.
7. Verify ACP, PTY, and event-stream liveness.
8. Return `runtimeReady`.

Use an already-running runtime slot when a provider cannot restore process
memory.

The target budgets are:

| phase | p50 target |
|---|---:|
| Snapshot lookup | less than 10 ms |
| Stateful restore or slot claim | less than 100 ms |
| Overlay and local branch | less than 20 ms |
| Environment adoption | less than 50 ms |
| In-process Pi `session/new` | less than 10 ms |
| API and transport | less than 60 ms |
| **Create to runtime ready** | **less than 250 ms** |

The implementation must pass the stateful restore tests in section 10.5.

A `/kortix/health` response does not prove ACP, PTY, or event-stream liveness.

## 21. Canonical starter and fast-boot contract

`general-knowledge-worker` is the only user starter.

The API and web creation paths use this ID for every blank project.

The CLI creates the same starter without a starter selector.

`minimal` remains an internal base for marketplace project composition.

The retired `acp-multi-harness` input remains an API and SDK compatibility
alias. The starter loader normalizes it to `general-knowledge-worker`.

The canonical scaffold is also the deterministic snapshot scaffold.

Its rendered repository root remains the input to `stageScaffoldRepo()`.

This preserves the exact-scaffold repository reuse path.

The default agent is `opencode`.

The selected logical agent determines the harness:

| logical agent | runtime profile | harness |
|---|---|---|
| `opencode` | `opencode` | OpenCode ACP |
| `claude` | `claude` | Claude Code ACP |
| `codex` | `codex` | Codex ACP |
| `pi` | `pi` | Pi ACP |

All four paths use the same ACP lifecycle boundary.

The fast-boot implementation must key artifacts by commit, runtime digest,
configuration digest, and selected harness.

The starter consolidation does not enable stateful restore.

The current measured session-ready p50 values remain:

| path | p50 |
|---|---:|
| Pi with Daytona repository disk snapshot | 7.784 s |
| Pi with Platinum exact-commit repository disk image | 9.462 s |
| Pi with Platinum cold disk snapshot | 12.823 s |
| OpenCode ACP with Platinum cold disk snapshot | 16.298 s |

The target remains 300 ms p50 and 950 ms p95 for a warm exact-commit claim.

## 21. Persisted benchmark assets

The benchmark directory now contains:

1. Startup-only analyzer.
2. Published Pi ACP source-path auditor.
3. Historical first-token analyzer.
4. End-to-end session probe.
5. Pi ACP wire probe.
6. Pi RPC wire probe.
7. Every retained Pi and OpenCode raw result.

Use:

```bash
node tests/performance/session-start/analyze-startup-ready.mjs \
  tests/performance/session-start/results/2026-07-29/local-pi-daytona-post-fix-0[1-8].json
```

The analyzer reports:

```text
boundary: ACP model selection complete; prompt not included
files: 8
valid: 8
rejected: []
create_to_session_ready_ms p50: 7783.588
```
