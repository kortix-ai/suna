# @kortix/worker

The pi-based session worker: the harness, and only the harness. Part of the
harness/worker split.

## What this package is

A single HTTP+SSE server wrapping `@earendil-works/pi-agent-core`'s `Agent`.
Every built-in tool (`bash`, `read`, `write`, `edit`) resolves its filesystem
and shell through an injected `ExecutionEnv` that RPCs into a separate
environment — no default tool can touch the worker's own disk
(`src/kortix-env.ts`).

It is **not deployed on its own**. `bun run build` produces one self-contained
`dist/worker-runtime.mjs` (nothing resolved at runtime); the API's
compiled-boot pipeline prepends per-`(project, sha)` agent config compiled from
`kortix.yaml` and serves the result:

```
push → apps/api/src/http/git-proxy/index.ts (pi_worker flag on)
     → compiled-pi-runtime-artifact.ts (cache, single-flight)
     → GET /v1/git/{project}.git/compiled-pi-runtime?ref&sha
```

The artifact self-describes: line 2 is a `// kortix-manifest-base64url:` marker,
`node artifact.mjs --manifest` prints it, and baked identity env vars fail
closed (exit 78) on mismatch.

## Config precedence

`main.ts` reads `globalThis.__KORTIX_COMPILED__` (the bake) and overlays env:
env vars win, because the control plane knows session-start facts (model
override, session id, environment URL) that a per-commit artifact cannot.

## Why this is not a pnpm workspace package

Own `bun.lock`, excluded in `pnpm-workspace.yaml`: the pinned
`@earendil-works/pi@0.84.3` release is younger than the workspace's 72h
`minimumReleaseAge` supply-chain cooldown. Fold it in once the pin ages out.
Pin 0.84.3 exactly — `AgentHarness` is unimplemented in this release (all 23
methods throw) and the working `Agent` surface was verified against it.

## Tests

The compile pipeline's tests live beside the pipeline and exercise the built
bundle directly: `apps/api/src/services/git-proxy/compiled-pi-runtime.test.ts` and
`pi-worker-bundle.test.ts` (the latter boots the real `dist/worker-runtime.mjs`
under node and asserts `/health`). Build first: `bun run build`.

Provenance: graduated from the `pi-worker` spike (PR #6924). The spike held the
Phase 0 gates S0.1–S0.5 and the Daytona benchmarks. It was removed from the
tree; read it in the git history of PR #6924.

## Durable Object runtime feasibility (KRTX-183)

**Decision: do not route sessions to a Durable Object yet.** The existing Pi
worker already defers environment provisioning until the first compute tool
call (`LazyKortixEnv`), and its `SessionStorage` writes to an external log.
There is no need to implement a second `machine` tool to test lazy attach:
`buildHarness` binds the built-in bash/read/write/edit tools to that environment.
A DO could replace the *harness host*, not the Linux environment, once its
runtime and transport contracts pass the gates below. Keep the current worker
as the default until then; this evaluation changes no session behavior.

| Gate | Evidence in the current runtime | Required proof before enabling DO |
| --- | --- | --- |
| Pi bundle runs in Workers | `src/main.ts` reads `process.env`; `worker.ts` uses `node:http`, `process.hrtime`, and `/proc/uptime`; `rpc-transport.ts` uses Node HTTP agents and `ws`. The artifact is built with `--target=node` and starts an HTTP server. | Build a Workers-targeted artifact, instantiate Pi in a local `wrangler dev` DO, and send a real model turn through the gateway. Do not infer Workers compatibility from the Node bundle. |
| Durable session state | `session-store.ts` writes through an append-only HTTP log and restores on boot. The worker's in-memory transcript is not the durable owner. | Restart/evict the DO during a turn and prove no accepted message or tool result is lost or duplicated. Keep the existing log as the source of truth until that is proven. |
| Attach on first use | `lazy-env.ts` calls the authenticated environment `ensure` endpoint. `kortix-env.ts` sends filesystem and shell operations to the daemon's `/kortix/env-rpc`. | Show zero VM allocations for a text-only turn; then run a command and push/pull a binary file against a real Linux VM. Node-only execution in a DO does not supply Python or a shell. |
| Large bodies | `apps/kortix-sandbox-agent-server/src/routes/kortix/env-rpc.ts` currently returns entire files as JSON/base64 and caps each command output stream at 2 MiB. Neither this protocol nor the current DO path proves safe above an edge body cap. | Probe request **and** response boundaries with binary and command-output payloads above the edge limit. Add bounded streaming/chunks with authenticated per-chunk reads/writes and integrity checks before production traffic. A larger JSON limit alone does not fix this. |
| Capacity and cost | The ~2 MB RAM and idle-billing figures in the huddle are hypotheses, not measurements of this Pi bundle. | Record peak heap, CPU per turn, sleep/wake latency, eviction behavior, and billed duration on the actual Cloudflare plan. Compare against the current lazy-worker + VM path at the same turn/tool-call distribution. |

**Proposed first experiment:** run an isolated DO proof with no production
routing: one text-only turn, one attached shell command, one binary round-trip
above the edge limit, and a forced DO restart. A failed gate keeps the Node
worker. Avoid adding a second configurable harness path or replacing the
existing authenticated RPC protocol until the proof passes.
