# Reloading a live session's config

*Verified against the repo @ `7f9c3734fb` (branch `prompt-connector-card`). All line numbers are from that checkout.*

## Root cause

A running session cannot pick up new config because the agent-behavior half of its config is not read from anywhere at runtime — it is compiled from git once, at session provision, into a single env var (`KORTIX_COMPILED_AGENT_CONFIG`, `apps/api/src/projects/lib/compile-agent-config.ts:384-415` → `apps/api/src/projects/lib/session-runtime-env.ts:42-44`), and the only live-push channel into a running box has a hard four-name allowlist that excludes it (`apps/kortix-sandbox-agent-server/src/routes/env.ts:10-21`, `:37`). Restarting opencode does not help, because `spawnChild` rebuilds the composed config from the daemon's *unchanged* `process.env` (`apps/kortix-sandbox-agent-server/src/opencode.ts:962`, `:988`) — a restart re-reads the same stale bytes. The restart "self-terminated" because the agent killed the process it was running inside: opencode owns the tool executor, so the `kill 223` shell's own result had nowhere to be delivered — the daemon respawned opencode ~500ms later (`opencode.ts:1021-1031`), but nothing finalized the orphaned turn, so the UI spun forever.

## Contradictions between the five reads, resolved

**"The codebase deliberately avoids respawning opencode."** — **Wrong, and it was my premise.** The two comments (`llm-proxy.ts:9-13`, `agent-env-file.ts:30-32`) are scoped to one fast path — the stateful warm-fork attach — and `llm-proxy.ts:21-22` says so explicitly. `opencode.restart()` is called from three live sites (`main.ts:712`, `routes/refresh.ts:58`, `routes/env.ts:166`) plus the unconditional crash-respawn loop. The reason for avoiding respawn is ~8s of boot latency on the critical path, not correctness.

**"The daemon respawns opencode" vs "the restart self-terminated."** — Both true, of different things. The *box* survives; the *turn* does not. Turn end is derived only from opencode's SSE `session.idle`/`session.error`; a killed process emits neither. The orphaned-turn repair exists (`main.ts:799 abortOpencodeTurn`) but is reachable **only** from `startSessionRuntime`, whose three call sites are boot (`main.ts:305`) and the two seed-adoption paths (`:347`, `:717`) — I enumerated them exhaustively. The Slack-only reconcile backstop bails twice (`main.ts:1444` non-Slack, `:1450` `completedAt == null` — which is exactly the symptom).

**"`dispose-only` reload exists / doesn't exist."** — The *client* exists and ships: `packages/sdk/src/core/runtime/client.ts:208-243`, tested at `client.test.ts:172-184`, wired into the web palette as **"Restart: Config Only"** (`apps/web/src/lib/menu-registry.ts:307-326`), and mobile POSTs `/global/dispose` directly (`apps/mobile/components/pages/LlmProvidersPage.tsx:96`). The *server* is not in this checkout: `core/kortix-master` and `core/kortix-supervisor` contain **only `node_modules`** and `git ls-files core` returns 0 files (verified). The daemon's `/kortix` router mounts only health/refresh/abort/git/pty/env (`proxy.ts:131-143`), so `/kortix/services/*` falls through to the opencode catch-all (`proxy.ts:209`). **Unresolved and load-bearing.** One check settles it — see below.

**"PID 223 was opencode."** — Unverified. If it was the *daemon* (normally PID 1, `apps/sandbox/entrypoint.sh:104`), nothing respawns and the whole box goes dark. Settle from the sandbox log: `[opencode] child exited` + `[opencode] restarting` lines mean it was opencode and this analysis holds.

**The double-spawn race** (`opencode.ts:1029-1031` timer checks only `stopping` at fire time; `start()` clears `stopping`; `:1038` clobbers `child` unconditionally) — the code shape is real, but it is not what the founder saw. It is a latent bug that every proposal below makes *more* likely.

---

## 1. What is actually frozen

| Config kind | Frozen at boot? | Live path today | What a reload needs |
|---|---|---|---|
| **Compiled agent manifest** — `agents:` map, per-agent prompt from `.md`, model, permissions → `KORTIX_COMPILED_AGENT_CONFIG` (`compile-agent-config.ts:384`, `session-runtime-env.ts:42`, consumed `opencode.ts:118`) | **Yes — the hardest.** One git read of `project.defaultBranch` at provision, then immutable | **None.** Excluded from the 4-name allowlist (`env.ts:10-21`); also stripped by `isReservedSandboxEnvName` (`sandbox-env-names.ts:17-23`) | Recompile in API → push as allowlisted env → respawn. **This is the founder's bug.** |
| **Composed opencode.json** — gateway provider, executor MCP, Slack overlay (`buildOpencodeConfigContent` `opencode.ts:80`, written `:475`/`:988`) | Written only inside `spawnChild`, but **fully rebuilt from live `process.env` on every spawn** | Indirect: `/kortix/env {refreshModels:true}` → `opencode.restart()` (`env.ts:160-167`) | Nothing new to build — widen the allowlist and reuse `restart()` |
| **Session model** | No | `pushSessionModelToSandbox` → allowlisted `KORTIX_OPENCODE_MODEL` + restart + readiness wait (`sandbox-env-sync.ts:413-455`, `:231-246`) | Done. **This is the pattern to copy verbatim** |
| **Secrets / project env** | No | Two live channels: 0600 tmpfs file sourced by `BASH_ENV` — **no restart** (`agent-env-file.ts:12-13`, `env.ts:158`, `opencode.ts:971`); and `process.env` + restart. Pushed **every prompt** (`sandbox-env-sync.ts:198-230`) | Done |
| **Model catalog / providers** — baked `/opt/kortix/llm-catalog.json` (`opencode.ts:274`) | **Yes.** Repair writes the file and *deliberately* does not restart (`opencode.ts:347-353`); `:592-594` states providers materialize at process start | Model *selection* only | Genuine respawn (unless dispose changes this) |
| **opencode config DIR** — `.kortix/opencode/{opencode.jsonc,agents,skills,commands}` | **Path** frozen at spawn (`main.ts:119-129`, `opencode.ts:966`); **contents** live on disk; managed `kortix-*` skill overlay applied boot-only (`injected-skills.ts:47-52`) | Files change on `git pull`; whether opencode re-reads them is **unverified** | If the watcher covers them: pull is enough. A *newly added* config dir needs a respawn — the path was resolved once |
| **Repo working tree** | No | `POST /kortix/refresh` — pull + restart by default (`refresh.ts:44-58`). Called from exactly one place, with `restart=0` (`warm-session-workspace.ts:82-88` ← `r7.ts:349`) | Nothing. Just expose it |
| **Sandbox env vars generally** (identity, branch, tokens) | **Yes — create-time only** | `sessions restart` does `provider.stop()/start()` with **no env rebuild** (`actions.ts:311-315`); only replacement provisioning rebuilds (`:212-224`) | Nothing short of a new sandbox |
| **Connector bindings** | **Never in the box** | Resolved server-side per Executor request (`session-connector-bindings.ts:665`) | Nothing. **This is the architecture everything else should converge on** |

That fourth-from-last row is the direct answer to "restarting the OC Server doesn't get the newest config": `sessions restart` pays a full boot and hands back byte-identical stale env.

## 2. The reload path

**Where it lives:** a new daemon route `POST /kortix/reload` (`apps/kortix-sandbox-agent-server/src/routes/reload.ts`, mounted at `proxy.ts:131-143` beside `/refresh`), an API forward route, and `kortix sessions reload <id>` (there is no reload verb in the CLI today — grep of `apps/cli/src` for `kortix/refresh` returns nothing).

**Contract:** `{ repo?: bool, agentConfig?: string, mode: 'respawn'|'dispose', when: 'idle'|'now' }`. Auth exactly as `refresh.ts:26-37` — service bearer **or** signed user context; the in-sandbox agent already carries `KORTIX_SANDBOX_TOKEN` in every shell (`agent-env-file.ts:39-48`).

**What it does:** responds **202 immediately** with `{reload_id, opencode_pid}`, then out of band: optional `refreshRepo`, re-run `ensureOpencodeConfigDeps` + `ensureInjectedManagedSkills`, write the new agent config into `process.env`, `opencode.restart()` (which rebuilds the composed config at `opencode.ts:962-991`), then on readiness run the orphaned-turn finalize and optionally fire a resume prompt through `turn-auto-resume`'s `prompt_async` delivery (`turn-auto-resume.ts:148-162`).

**Why the 202 matters and `/kortix/refresh` is not good enough:** `refresh.ts:53-67` *awaits* `opencode.restart()` before responding. An agent that curls it blocks in a shell whose parent is being killed — identical failure to `kill 223`. Returning before restarting lets the tool result land first.

**Live-reloadable, no respawn:** project secrets to shells (`BASH_ENV`), and LLM credentials behind the localhost proxy (`llm-proxy.ts:14-19`). Both work because their consumer is re-created per use. **Genuinely needs a respawn:** the composed config file — providers, MCP servers, permissions, model registry, and the compiled agent map.

**How the respawn avoids self-termination:** the restarter is the daemon, a separate process that is the *parent* of opencode's process group (`opencode.ts:1013-1018`, `detached: true`), with nothing above it (`entrypoint.sh:104`). `when: 'idle'` — deferring until the next `session.idle` — should be the **default for any in-session caller**; it makes the reload genuinely lossless.

**What it cannot do:** change `OPENCODE_CONFIG_DIR`'s path (resolved once at spawn — a repo newly gaining a config dir needs a sandbox restart); change session identity/branch/tokens (create-time env); preserve an in-flight turn under `when:'now'`.

**In-flight turn and SSE under `when:'now'`:** the turn is lost. The SSE stream ends cleanly (no mid-stream timeout, `proxy.ts:41-53`); the event loop auto-reconnects (`opencode-events.ts:56-57`, `:98`, `:157`); the proxy 503s "opencode not ready" for the window (`proxy.ts:252-259`); on-disk history and the pinned root id survive, so the **same conversation** resumes. The stuck `running` part must be finalized or the UI spins — that is the screenshot.

**What the user sees:** `Reloaded — main abc123→def456, agent config recompiled (9f2c…), opencode restarted (pid 412)`. In the workspace, the interrupted turn ends with a message instead of spinning.

## 3. Staleness visibility

Hash the bytes that already exist. `compile-agent-config.ts:415` produces exactly `JSON.stringify(compiled)` — return `sha256(...).slice(0,16)` beside it, emit `KORTIX_COMPILED_AGENT_CONFIG_ETAG` at `session-runtime-env.ts:42`, and echo it from `/kortix/health`, which already returns `branch`, `commit_sha`, `opencode_pid` (`routes/health.ts:118-130`). Add `GET /projects/:id/agent-config/etag` that recompiles from the mirror (60s TTL, `mirror.ts:332-377`) without delivering anything. `kortix sessions info` then prints `config: 9f2c… (stale — project is at 4be1…)`. ~20 lines, no migration.

Two notes: the reconcile-on-hash pattern already ships for connectors (`manifestHashForConnector` → `executors.manifestHash` → `executor/sync.ts:404`), and `manifestHashForAgent` (`agents.ts:585`) is **already written and never wired**. And do **not** use `commit_sha` as the staleness signal — `refreshWarmSessionWorkspace` advances it while passing `restart:'0'` (`warm-session-workspace.ts:82-88`), so a box can report the newest commit while running config compiled days ago.

## 4. The meta-harness, assessed

**Already exists.** The CLI is already the orchestration API (`apps/cli/src/commands/sessions.ts:26-83`), and the spawn/observe/collect fan-out loop is documented as the sanctioned pattern in a first-party managed skill (`packages/starter/templates/managed/.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md:212-229`). The credential exists: the project-scoped PAT (`apps/api/src/projects/routes/r3.ts:74-80`, `:117-172`), enforced at `auth.ts:183-185`, which resolves `origin: 'backend'` (`session-origin.ts:71-73`) — while an in-sandbox executor token is *forcibly* `'user'`. An out-of-box harness therefore already has strictly more session-start authority than the same CLI inside a box. The immutability pattern exists: managed `kortix-*` skills are image-baked, force-overwritten into every session at boot (`injected-skills.ts:22-52`), deliberately absent from the user's repo (`packages/starter/src/index.ts:185-199`), with a live HTTP fallback at `/v1/skills`. And a durable out-of-sandbox session driver exists: leader-elected singleton workers over `projects/session-lifecycle/engine.ts` (`apps/api/src/index.ts:1226-1245`) — idempotency, requeue, backpressure, delivery retry, already solved.

**Small delta.** "The only required env var is the Kortix token" is one fallback away: `resolveProjectId` (`apps/cli/src/project-link.ts:89-96`) never asks the API, though the API returns `token_context.project_id` (`accounts/core/tokens.ts:94-96`) and `whoami` already renders "project token" (`whoami.ts:178`).

**Genuinely new.** There is no immutable platform-owned *agent*. `DEFAULT_AGENT_SENTINEL` (`agents.ts:41-50`) is a non-binding pointer and the starter's `kortix` agent is an editable committed file. This needs real work in `agents.ts` to admit an agent no `agents:` map can shadow.

**"Boots instantly" is the weakest claim.** Measured boot is dominated by opencode's own cold start — 4.7s Daytona / 12.0s Platinum p50 (`main.ts:763-770`), ~3.2s of per-directory project init (`main.ts:499-503`) — not by cloning or config loading: the clone is already elided on the warm path (`git.ts:672`) and config deps are already zero-network (`opencode-config-deps.ts:21-25`). A config-less harness skips the clone and the manifest read, not the runtime init. Instant means **resident or parked-warm**, not a cheap cold spawn.

**Does it solve staleness?** No — your suspicion is right. It routes around it *for itself*: it never goes stale because it never materializes config into a box, which is the same reason connectors never go stale (`session-connector-bindings.ts:665`). But every sub-session it spawns is an ordinary sandbox with the same frozen `KORTIX_COMPILED_AGENT_CONFIG`. What the harness genuinely buys is being outside the **turn** — it can restart a sub-session's opencode without severing its own transport, and can replace a stale sub-session. That is a supervisor, not a fix, and `when:'idle'` + auto-resume buys the same property inside the box for far less. The non-substitutable parts are `origin='backend'` authority and surviving a sub-session's death.

## 5. Build order

**0. The live check (30 min, no code).** On a real sandbox: edit `~/.config/kortix-opencode.json`, `POST /kortix/services/system/reload {mode:'dispose-only'}`, then read back the agent list and compare `opencode_pid` from `/kortix/health`. Same session: `git pull` an agent `.md` change, `POST /kortix/refresh?restart=0`, ask the agent to state its own prompt. These two answers decide whether step 4 is "rewrite file + dispose" (milliseconds) or "respawn" (~8s), and whether `restart=0` is safe at all.

**1. Stop the hang.** `opencode.ts` (flag unplanned exits; hook post-respawn readiness) + `main.ts` (extract the finalize at `:799` out of `startSessionRuntime` into a reusable `finalizeOrphanedTurn()`; drop the Slack gate at `:1444` for this path). **~60 lines.** Unblocks: every crash, OOM, and agent `kill` ends the turn cleanly instead of spinning. Worth shipping even if nothing else does.

**2. Make the compiled agent config pushable.** `routes/env.ts:10-21` (+1 allowlist entry) and `sandbox-env-sync.ts` (add `pushSessionAgentConfigToSandbox` next to `pushSessionModelToSandbox:413` — same `postEnvToDaemon`, `refreshModels:true`, `waitForDaemonOpencodeReady`). **~80 lines.** Unblocks: the actual bug. Fire it from `apps/api/src/projects/routes/agent-config.ts:436-452`, which today commits to git and notifies nobody.

**3. The etag.** `compile-agent-config.ts:415`, `session-runtime-env.ts:42`, `routes/health.ts`, one API GET, `sessions info`. **~120 lines, no migration.** Unblocks: "stale is fine, but let me see it" — and gives the harness its reload-vs-respawn signal.

**4. `POST /kortix/reload` + `kortix sessions reload`.** New `routes/reload.ts`, `proxy.ts` mount, API forward, CLI verb. **~250 lines.** 202-then-restart; `when=idle` default in-session. Unblocks: the documented method.

**5. The two latent bugs steps 1–4 make more likely.** A monotonic spawn-generation guard on the respawn timer (`opencode.ts:1029-1031`, `:1038`); and SIGHUP — today it kills PID 1 in a normal session, since handlers are registered only on the two seed-adoption paths (`main.ts:351`, `:721`) and `shutdown.ts:41-42` registers only SIGTERM/SIGINT. **~40 lines.**

**6. Only if step 0 said yes:** replace the respawn with rewrite-config + dispose. Also lets the warm-fork hot-swap stop bailing on `gatewayCatalogChanged` (`main.ts:686`).

**Independent of all of the above, two bugs no reload endpoint fixes:** `compile-agent-config.ts:389`/`:405` read `project.defaultBranch` even when the session is on a different `baseRef` — a feature-branch session runs main's agent config from second zero, which is the most likely explanation for "I verified it works and the agent ignored it." And `sessions restart` (`r8.ts:113-117` → `actions.ts:311-315`) costs a full boot and returns identical stale env — rebuild env there or stop advertising it as a way to get fresh config.

## Must verify before building

1. **What `dispose-only` / `/global/dispose` actually re-reads** — the config *file*, the config *dir*, the provider registry, or only in-memory instance state. `core/kortix-master` is node_modules-only here (verified). This decides the shape of steps 4 and 6.
2. **Whether opencode's file watcher covers `agents/*.md`, `skills/`, `opencode.jsonc`** — `refresh.ts:44-46` and `git.ts:1145` assume yes; `llm-proxy.ts:12-13` says config is read only at spawn. If no, `restart=0` is itself a staleness source on every warm reuse.
3. **Whether PID 223 was opencode or the daemon** — from the sandbox log.
4. **Whether `POST /session/{id}/abort` finalizes a message whose writing process already died.** `main.ts:799` assumes it does; unverified against the pinned opencode.
5. **Whether the live model-change restart (`env.ts:160-167`) already drops mid-turn work** — it restarts with no drain and no in-flight check. If it does, that is a bug today, not just a hazard for the new endpoint.
6. **Security, separate track:** every unrouted `/kortix/*` path skips the daemon's user-context gate (`proxy.ts:153-155`) and falls through to the opencode passthrough (`proxy.ts:209`); and `/kortix/refresh` — which git-pulls and restarts opencode — is reachable through the user-facing proxy, since only `/kortix/env` is blocked (`preview.ts:785-791`).
7. **Re-measure the restart cost.** The ~8s figure (`llm-proxy.ts:11`) is a warm-fork number from before the warm-pool work; it sets the UX budget for `kortix sessions reload`.

---

## Measured: the dispose question, settled (2026-08-03)

Run against **opencode-ai@1.17.11** — the exact build `apps/sandbox/Dockerfile`
installs — started locally and probed directly.

| Question | Answer |
|---|---|
| Does `POST /global/dispose` re-read the config file from disk? | **Yes**, in-process, same pid |
| How long? | **~51ms** (a respawn is ~8s) |
| Is there a config file watcher? | **No.** A fresh process served its boot config unchanged for 18s after the file was edited |
| Does one dispose start a watcher? | No — every edit needs its own dispose |
| Does `POST /kortix/services/system/reload` exist? | **No.** It falls through to opencode's SPA catch-all: 200, `text/html` |

The experiment: boot with `agent.only-one.prompt = "BOOT"`; rewrite the file on
disk to add a second agent and change the prompt; poll `/config` for 18s — no
change; `POST /global/dispose` → `true` in 51ms; `/config` immediately shows both
agents and the new prompt; pid unchanged. A second edit stayed invisible until a
second dispose, which rules out "the first dispose installed a watcher".

An earlier reading of this same probe looked like evidence of a watcher. It was
not: that process had already been disposed once, and the check ran sub-second
after the edit. The clean run above is the one to trust.

### Consequences

1. `reloadConfig()` in the daemon rewrites the config file and disposes, falling
   back to a full restart when dispose does not answer with JSON. That fallback
   is not decoration — a 200 from this server proves nothing, because every
   unknown path returns the web UI.
2. The mid-session model change, the compiled-agent-config push, and
   `kortix sessions reload` all take the fast path. When dispose wins they **no
   longer sever an in-flight turn**, because nothing restarts.
3. **`systemReload()` in the SDK was broken and is now fixed.** It POSTed
   `/kortix/services/system/reload`, got 200 + HTML, and threw on
   `response.json()` — so both command-palette entries built on it had never
   worked. Mobile was unaffected: it POSTs `/global/dispose` directly.
   `'dispose-only'` now targets `/global/dispose` and `'full'` targets
   `/kortix/refresh` (the only client-reachable path that restarts the runtime —
   it pulls the workspace too, and the palette label says so). Both check
   `content-type` before trusting a 200, for the reason above.
