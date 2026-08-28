# @kortix/worker

The pi-based session worker: the harness, and only the harness. Part of the
harness/worker split (`docs/specs/2026-08-26-harness-worker-split.md`).

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
push → apps/api/src/git-proxy/index.ts (pi_worker flag on)
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
bundle directly: `apps/api/src/git-proxy/compiled-pi-runtime.test.ts` and
`pi-worker-bundle.test.ts` (the latter boots the real `dist/worker-runtime.mjs`
under node and asserts `/health`). Build first: `bun run build`.

Provenance: graduated from `spikes/pi-worker` (PR #6924), where the Phase 0
gates S0.1–S0.5 and the Daytona benchmarks live.
