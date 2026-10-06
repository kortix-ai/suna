---
name: pi-cell
description: "The pi cell runtime: the pi coding agent running as a Durable Object inside a V8 isolate under celld (apps/pi-worker-js), its Platinum provisioning, and the pi-js.kortix.com router. Load WHENEVER you edit apps/pi-worker-js, apps/pt-celld.spec.json, apps/tools, infra/cloudflare/workers/pi-js-router, .github/workflows/deploy-pi-js-router.yml, the `pi_cell` project flag, or anything that boots, addresses, or tests a cell session; and whenever someone asks how the cell, celld, pi-durable, or just-bash fit together."
---

# The pi cell

A Kortix session whose agent loop runs in a **V8 isolate with no filesystem and
no child processes**. The isolate is a Durable Object (`AgentCell`) under
[celld](https://github.com/denoland/celld), Deno's self-hosted Durable Object
runtime. The transcript lives in the object's own SQLite and survives the death
of the process that runs it.

| Path | What it is |
| --- | --- |
| `apps/pi-worker-js/` | The cell: worker bundle, tests, `wrangler.json`, `deploy-platinum.mjs`. Standalone npm app, excluded from the pnpm workspace. Its `README.md` is the architecture doc. |
| `apps/api/src/feature-flags/registry.ts` | The `pi_cell` project flag. Available only with `KORTIX_PI_CELL_ENABLED=true` and a `PLATINUM_API_KEY`. |
| `apps/api/src/projects/lib/session-create.ts` | `piCellBoot`: a `pi_cell` session gets slug `pi-cell`, provider Platinum (locked), no project image, metadata `pi_cell_boot: true`. Requires the LLM gateway. |
| `apps/api/src/platform/providers/platinum.ts` | `buildCellCreateBody`: the `runtime: "cell"` create body. Tested in `platinum-cell.test.ts`. |
| `apps/pt-celld.spec.json` | Platinum template spec for the celld runtime image. The agent is not in the image: it is a bundle in the bucket. |
| `apps/tools/` | Mutation and rail tools the cell suites run (`mutate.mjs`, `cell-rails.mjs`). |
| `infra/cloudflare/workers/pi-js-router/` | The Cloudflare Worker that gives `pi-js.kortix.com` to one cell or one branch stack. |
| `references/` | Earlier design records: the micro-VM pi worker split (`vm-worker-*.md`) and the P2.4 scope. Read them as history; the cell replaced the micro-VM worker. |

## Runtime facts, verified

- **pi 1.0 split the harness out of `pi-agent-core`.** `pi-agent-core` 1.0.x
  exports only `Agent`, the agent loop, `proxy` and `stream-fn`. Tools,
  `ExecutionEnv`, compaction and skills moved: the durable harness is
  `@earendil-works/pi-durable`, and its `./tools` (`CodingTools`), `./env`,
  `./storage/sqlite` and `./storage/memory` subpaths import no Node built-in.
- **pi-durable runs on celld.** Measured 2026-10-05 on `celld 0.6.1 dev`
  (macOS arm64): `SqliteStorage` over the object's `ctx.storage.sql`,
  `CodingTools` (`write`, `bash`, `edit`, `read`) over a just-bash
  `InMemoryFs`, a duplicate `requestId` returns the same submission, a close
  and reopen restores every entry, and a harness closed mid-tool resumes: the
  `replay: "unsafe"` tool reports "interrupted and may have partially run", the
  `replay: "safe"` tool re-runs, and the run finishes.
- **just-bash needs `nodejs_compat`.** Its browser bundle imports `node:zlib`
  statically (gzip). Without `compatibility_flags: ["nodejs_compat"]` in
  `wrangler.json` the worker fails to load (`ERR_MODULE_RULE` on workerd), and
  `base64 -d` and gzip fail at run time on unguarded `Buffer.from` calls.
- **pi-ai's auth context does a variable dynamic `import()`** of
  `node:fs/promises` and `node:os`. Pass
  `createModels({ authContext: { env, fileExists } })` so keys come from the
  object's bindings and that path never runs.
- **pi-durable cannot wake itself.** The scheduler is in memory. After an
  eviction the host must call `harness.resume()`; the object's alarm is that
  wake-up.
- **celld loads every named export of the entry module as a handler.** A
  string or helper export fails the load (`Incorrect type for map entry
  'CELL_VERSION'`). Keep `src/worker.js` exports to `AgentCell` and `default`.
- **celld ends isolate work once the response is sent.** A turn that runs
  after the prompt answers must run on the object's alarm.
- **A Platinum cell takes session values as `CELLD_VAR_<NAME>`.** celld maps
  them to `env.<NAME>` in the isolate. An unprefixed variable reaches the celld
  node only. `CELLD_BASE_PORT=8000` puts celld on the port the API proxies.
- **Platinum prod refuses cells.** `runtime: "cell"` on `api.platinum.dev`
  answers `501 runtime_not_enabled` (measured 2026-10-05). Platinum dev
  (`api-dev.platinum.dev`) runs them: create to `/kortix/health` ready in
  4.6 s, a faux turn to `session.idle` in 241 ms. Deployed Kortix dev
  provisions on Platinum prod, so `pi_cell` cannot boot there yet.
- **A cell has no machine by default.** The `machine` tool needs the API's
  `…/sessions/:s/environment/ensure`, removed on main by `e60ed971f1`
  (#9189). It is offered only with `CELL_MACHINE=1`.
- **A worker version reaches a cell only at cell start.**
  `deploy-platinum.mjs` uploads and activates; `--roll` restarts the running
  cells the activation lists.
- **celld pin.** `pt-celld.spec.json` pins `celld 0.3.0` (x86_64 only).
  `celld 0.4.0+` adopts a new deployment in place and holds one in-flight
  request per object; `0.6.1` ships `aarch64-apple-darwin`, so `celld dev`
  runs on a Mac with no bucket and no Docker.

## Rules

1. **Storage is truth, memory is cache.** Every turn rebuilds model context
   from the object's SQLite. Never keep the only copy of a message in memory.
2. **A tool that is not safe to run twice is `replay: "unsafe"`.** After a
   crash, pi-durable reports it as interrupted instead of re-running it. Mark a
   tool `replay: "safe"` only when two runs leave the same state (a read, a
   whole-file write).
3. **No credential goes through `wrangler.json`.** `celld deploy` uploads its
   vars into the deployment manifest in the bucket, and celld keeps every old
   version. Credentials ride `CELLD_VAR_*` in the node's environment.
   Rotating a leaked credential means purging old versions too
   (`node celldctl.mjs purge`).
4. **Co-located celld nodes need distinct, stable `CELLD_NODE` ids.** A moved
   id makes every request answer `DurableObjectRoutingError`; a duplicated one
   makes nodes evict each other.

## The branch environment

`https://pi-js.kortix.com` is this branch's own stack on Platinum dev, with
cells on. Deploy it with `node apps/pi-worker-js/env/pi-js-deploy.mjs
[--sha <sha>] [--fresh]`; the README section "The branch environment" has
the VM, the key and what the host script changes. A fresh database races
Supabase storage grants once (`permission denied for table buckets`); the
host script retries `up` for that.

## Verify

```bash
cd apps/pi-worker-js
npm ci && npm run conformance              # pi-durable storage 23/23, env 21/21
npm test                                   # every suite + session-e2e on the pinned `celld dev`
cd ../api && bun test --isolate --env-file=scripts/test.env src/platform/providers/platinum-cell.test.ts
```

CI runs `npm ci && ./test/all.sh` in the `packages` lane
(`tests/bin/package-quality.ts`). `test/fetch-celld.mjs` pins celld `0.6.1`
by the sha256 of each release asset.

`test/mutate-*.mjs` rewrite tracked source in place. A run killed partway
leaves a mutant in `src/`. Run one alone, then `git status`.
