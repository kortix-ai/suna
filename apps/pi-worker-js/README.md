# pi in a cell

A Kortix session whose pi agent runs in a **V8 isolate with no filesystem and no
child processes**. The isolate is a Durable Object (`AgentCell`) under
[celld](https://github.com/denoland/celld), Deno's self-hosted Durable Object
runtime. The agent loop is `@earendil-works/pi-durable` 1.0, whose harness
already persists every entry, so the transcript lives in the object's own
SQLite and survives the death of the process that runs it.

A cell speaks the same daemon contract as kortixd's pi harness
(`/kortix/health`, `/kortix/env`, `/kortix/runtime/*`, `/global/event`,
`/session/*`). The API, the SDK and the web app cannot tell a cell from a
micro-VM session.

Status: behind the `pi_cell` project flag. Off by default. See
[Enable it](#enable-it).

## Shape

```
apps/api  ── POST /v1/sandboxes {runtime:"cell", template:"pt-celld", worker:"kortix-pi-cell"}
   │            env: CELLD_BASE_PORT=8000, CELLD_VAR_<every session var>
   ▼
Platinum cell ── celld ── default export (src/worker.js)
                            │ routes by root id (path, ?c=, or KORTIX_SESSION_ID)
                            ▼
                         AgentCell (one Durable Object per session)
                            ├─ CellEngine (src/engine.js)
                            │    pi-durable Harness over ctx.storage.sql (pi_* tables)
                            │    CodingTools: read, write, edit, bash
                            │    model: the Kortix LLM gateway (openai-completions)
                            ├─ ExecutionEnv
                            │    cell: just-bash over a persisted InMemoryFs (src/execenv.cell.js)
                            │    machine (CELL_MACHINE=1 only): kortixd /kortix/env-rpc/rpc
                            └─ Kortix contract (src/kortix/*)
                                 DurableTurnEvents → KortixEventBus → /global/event
                                 TranscriptStore (kx_messages, kx_parts)
```

## Source map

| Path | What it does |
| --- | --- |
| `src/worker.js` | `AgentCell` and the default export. Every route, the readiness gate, the alarm that drives turns. |
| `src/engine.js` | `CellEngine`: opens the pi-durable `Harness`, registers tools and prompt extensions, submits prompts, keeps `kx_turns`. |
| `src/do-sqlite.js` | `openPiStorage(storage)`: pi-durable's `SqliteDatabase` over a Durable Object's SQL API, tables prefixed `pi_`. Port of the `agents` 0.26 adapter (MIT). |
| `src/execenv.cell.js` | The pi-durable `ExecutionEnv` inside the isolate: just-bash, a `TrackedFs` persisted incrementally to SQLite, abort-aware `sleep`, `watch`. |
| `src/execenv.envrpc.js` | The same `ExecutionEnv` over a kortixd machine. Retries transport failures for replay-safe operations only. |
| `src/kortix/turn-events.js` | Maps pi-durable events (`run_start`, `message_update`, `tool_execution_*`, `auto_retry`, `run_end`) to Kortix frames. |
| `src/kortix/bus.js`, `transcript.js`, `ids.js` | Event bus and SSE, the `kortix.transcript.v1` store, root and message ids. |
| `src/kortix/prompt.js` | `CELL_VERSION` and the prompt body parser. Not in `worker.js`: see [celld rules](#celld-rules). |
| `src/vendor/pi-skills.js` | pi 0.84.4 skill loader (MIT). pi-durable 1.0 does not ship one. |
| `build.mjs` | esbuild bundle to `dist/worker.js`. Stubs pi-ai's variable `import()` in `auth/context.js`. |
| `wrangler.json` | celld deployment config. Holds no credential. |
| `deploy-platinum.mjs` | Uploads `dist/worker.js` as a Platinum worker version and activates it. |

## Turn lifecycle

1. `POST /kortix/runtime/sessions/<root>/prompt` parses the body and calls
   `CellEngine.submit({ messageId, content, model, noReply })`.
   `requestId = messageId`, so a retried prompt returns the first submission.
   A busy harness queues the prompt as a follow-up.
2. The route sets the object's alarm and answers. celld stops an isolate's
   work once the response is sent, so the alarm runs the turn.
3. The alarm arms a 30 s deadman alarm, then awaits `waitForIdle` for up to
   10 min. A cell that dies mid-turn wakes on the deadman alarm and calls
   `harness.resume()`.
4. `DurableTurnEvents` turns each pi-durable event into `message.updated`,
   `message.part.updated`, `message.part.delta`, `session.status` and
   `session.idle` frames. Each frame is written to `kx_messages`/`kx_parts`
   and published on `/global/event`.
5. After the turn ends the cell sends `kind: "end"` to the API's turn stream
   (`relayPending`). That callback is the only signal that finalizes a turn
   server-side. An end the cell could not deliver stays in `kx_turns` and the
   next alarm (5 s) retries it.

## Durability rules

1. **Storage is truth.** pi-durable writes every entry before it acts on it.
   The cell keeps no message only in memory.
2. **Replay is declared per tool.** pi-durable re-runs an interrupted tool
   call only when the tool declares `replay: "safe"`. Otherwise it reports the
   call as interrupted and does not re-run it. pi-durable's `CodingTools`
   declare no `replay`, so `read`, `write`, `edit` and `bash` are all `unsafe`
   (`harness/tool.js`: `tool.replay ?? "unsafe"`).
3. **Requests are idempotent by id.** `messageId` is pi-durable's `requestId`.

## wrangler.json

```json
{
  "name": "pi-cell",
  "main": "dist/worker.js",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "AGENT", "class_name": "AgentCell" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AgentCell"] }],
  "vars": {}
}
```

- `nodejs_compat` is required. just-bash's browser build imports `node:zlib`.
  Without the flag the bundle fails to load.
- `vars` stays empty. celld stores vars in the deployment manifest and keeps
  every old version. Session values reach the isolate as `CELLD_VAR_*`.

## celld rules

- celld loads **every named export** of the entry module as a handler. A
  non-handler export (a string, a helper) fails the load with `Incorrect type
  for map entry`. `worker.js` exports only `AgentCell` and the default handler.
- celld ends isolate work when the response is sent. Background work goes on
  the object's alarm.
- `CELLD_VAR_<NAME>` in the node environment becomes `env.<NAME>` in the
  isolate. `CELLD_BASE_PORT` sets the listen port; Kortix uses `8000`.

## Enable it

API environment (machine-local overrides go in the gitignored
`apps/api/.env.local`; never put a credential in a tracked file):

| Variable | Default | Effect |
| --- | --- | --- |
| `KORTIX_PI_CELL_ENABLED` | `false` | Makes the `pi_cell` flag available. |
| `PLATINUM_API_KEY` | — | Required. The flag is unavailable without it. |
| `PLATINUM_API_URL` | Platinum prod | Must point at a Platinum that runs cells. See [Known gaps](#known-gaps). |
| `KORTIX_PI_CELL_TEMPLATE` | `pt-celld` | Platinum template for the cell. |
| `KORTIX_PI_CELL_WORKER` | `kortix-pi-cell` | Platinum worker the cell boots. Must match the deployed worker. |
| `KORTIX_PI_CELL_DEFAULT_ENABLED` | `false` | Projects with no choice of their own run as cells. |

Which sessions are cells, in order:

1. kortix.yaml `sandbox.type: vm` → never a cell; `sandbox.type: worker` → a cell.
2. Otherwise the project's `pi_cell` flag, whose default is `KORTIX_PI_CELL_DEFAULT_ENABLED`.
3. Only on the default sandbox: a session that resolves a custom template boots a microVM.
4. Only with the LLM gateway on and cells available; otherwise a microVM, never an error.

A cell's provider is locked to Platinum and the project image is ignored
(`sessionRunsInCell`, `apps/api/src/projects/lib/session-create.ts`).

## Build, test, deploy

```bash
npm ci
npm run build                       # dist/worker.js
npm run conformance                 # pi-durable's own storage + ExecutionEnv suites
npm test                            # every suite, then a whole session on `celld dev`
npm run contract                    # the kortixd contract, in process
```

- `npm test` runs `test/all.sh`. `session-e2e` uses `CELLD_BIN`, else `celld`
  on `PATH`, else the pinned celld `0.6.1` release that `test/fetch-celld.mjs`
  downloads, checks against its sha256, and caches in
  `~/.cache/kortix/celld/0.6.1`. A checksum mismatch fails the run; no asset
  for the platform or no network skips the suite by name. celld `0.6.1` ships
  `aarch64-apple-darwin`, so the e2e runs on a Mac without Docker.
- CI: the `packages` lane (`tests/bin/package-quality.ts`, also
  `pnpm test -- --packages-only`) runs `npm ci` and `./test/all.sh` here.
- `test/mutate-*.mjs` rewrite tracked source in place. Run one alone and check
  `git status` after it. `test/all.sh` never runs them.

Deploy a new worker version:

```bash
PT_API_URL=https://api-dev.platinum.dev PT_TOKEN=… node deploy-platinum.mjs [--worker kortix-pi-cell] [--roll]
```

A running cell keeps its version until it restarts. `--roll` restarts the
cells the activation reports, one at a time.

## The branch environment: pi-js.kortix.com

`https://pi-js.kortix.com` runs this branch's whole stack (API, web, gateway,
Supabase) with `pi_cell` on, so its sessions are cells on Platinum dev.

| What | Where |
| --- | --- |
| VM | Platinum dev microVM `kortix-env-pi-worker-js` (`sbx_01M1SJ00XFM1AXHQ1YA1E296G6`), port 8080 |
| Public name | `infra/cloudflare/workers/pi-js-router`, target kind `stack` |
| Stack | self-host instance `pr-7117` in `/workspace/kortix-preview/self-host/pr-7117` |
| Secrets | `/workspace/kortix-preview/runtime-secrets.json` on the VM. Its Platinum key is the dedicated dev key `key_01M48V76C8P78BW23S7BM54WHP` ("pi-js branch env"), expiring 2027-01-04. |
| Cells | worker `kortix-pi-cell` on Platinum dev, shipped by `deploy-platinum.mjs` |

Deploy a commit (its `pr-<sha>` images must be on Docker Hub; the PR's
`preview` label builds them):

```bash
node apps/pi-worker-js/env/pi-js-deploy.mjs                 # origin/pi-worker-js, upgrade in place
node apps/pi-worker-js/env/pi-js-deploy.mjs --sha <sha> --fresh   # new instance and database
```

`env/pi-js-host.sh` runs on the VM. It follows the CI preview host script
with four differences: sessions on Platinum dev, `pi_cell` on, internal
billing off (no live Stripe key), and the managed provider on (default models
go through `OPENROUTER_API_KEY`). An `upgrade` backs up `.env`, the compose
files and a `pg_dump` of `postgres` first, and restores them if the new stack
does not come up.

## Measured

Platinum dev, worker version `d7f2ceef4033b343`, faux model, 2026-10-05:

| Step | Time |
| --- | --- |
| `POST /v1/sandboxes` (`runtime: cell`) → running | 1.3 s |
| create → `/kortix/health` ready | 4.6 s |
| prompt (write + bash + text) → `session.idle` | 241 ms |

## Known gaps

- **Platinum prod refuses cells.** `POST /v1/sandboxes` with `runtime: "cell"`
  answers `501 runtime_not_enabled` on `api.platinum.dev`. Platinum dev
  (`api-dev.platinum.dev`) runs them. `dev-api.kortix.com` provisions on
  Platinum prod, so the flag cannot boot a cell there until Platinum enables
  the cell runtime in prod.
- **No machine.** The cell's `machine` tool attached a full Linux box through
  the API's `POST …/sessions/:s/environment/ensure`. Main removed that route
  with the pi worker split (`e60ed971f1`, #9189). The tool is off unless
  `CELL_MACHINE=1`, and the shell note tells the model it has no machine.
- **Not in this path:** `daemon/`, `deploy.sh`, `celldctl.mjs`,
  `build-images.mjs`, `Dockerfile.celld`, `pt-agent-daemon.spec.json` and
  `clean-store.mjs` belong to the earlier self-hosted cell (own bucket, own
  tool daemon). `deploy.sh` documents why it is superseded. Their suites still
  run in `test/all.sh`.

The design history (pi 0.x on `pi-agent-core`, the tool daemon, the op ledger)
is in this file's git history and in `.agents/skills/pi-cell/references/`.
