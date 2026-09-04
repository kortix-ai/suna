# pi in a cell

A coding agent whose loop runs inside a **V8 isolate with no filesystem and no
child processes**, keeps its transcript in the cell's own SQLite, and survives
the death of the process running it.

Everything below was measured on the pinned `celld 0.3.0` from
[`../pt-celld.spec.json`](../pt-celld.spec.json), against a real S3 (MinIO), with
a real `celld deploy`. `./test/e2e.sh` reruns all of it.

Eleven suites, 162 claims. **Seven of them need nothing but node — 132 claims**,
including the turn queue's concurrency, the daemon's security boundary and the
provider layer. That split is deliberate: the Docker VM on this machine dies
every four or five heavy suites, so anything that can be tested without a
container has been moved to where it can run constantly. Three of the last four
bugs were found on that side of the line.

| suite | what it proves | needs |
|---|---|---|
| `npm run shapes` | every Platinum request matches the route's zod schema | nothing |
| `npm run compaction` | the cut never orphans a tool result | nothing |
| `npm run safety` | 15 claims: the daemon boundary — auth, path confinement, symlinks, session isolation, idempotency, single flight, truncation, timeouts | nothing |
| `npm run cell` | 25 claims: routing, backend selection, the turn queue's claim, orphaned turns, compaction, the op ledger, transcript reload — the real `AgentCell` against a fake DO backed by real SQLite | nothing |
| `npm run models` | 23 claims: the provider layer's edges — bedrock refused with a reason, an unknown model id falling back rather than throwing, `base_url` winning, both provider sets | nothing |
| `npm run ctl` | 23 claims: **no secret reaches `wrangler.json`** — with an API key, with a subscription login, and under the test pin | nothing |
| `npm run deploy-contract` | 15 claims: what `deploy.sh` actually sends to Platinum, against a stub control plane | nothing |
| `npm run e2e` | 9 claims: the cell serves, tools reach a real shell, the transcript is pi-shaped and durable across SIGKILL, retries do not re-execute, concurrent prompts do not interleave, no secret reaches the bucket, compaction bounds the transcript | docker + minio |
| `npm run platinum` | the platform's own API drives all five tools, and a scoped key is refused elsewhere | docker + minio |
| `npm run crash` | a cell killed MID-COMMAND resumes without running it twice | docker + minio |
| `npm run streaming` | 12 claims: tool-by-tool streaming, cross-session isolation, multiple watchers, reconnects, ordering | docker + minio |

```
== 5. the session survives SIGKILL of the node ==
  PASS a new process read all 8 messages back from the bucket
== 9. compaction bounds the transcript, which is the bill ==
  PASS compacted: peak 2027 -> 1522 tokens, head is a summary, tail starts at a user turn
```

## The one thing that decided the architecture

**`@earendil-works/pi-coding-agent` cannot run in a cell.** It imports `fs`,
`fs/promises`, `path` and `readline` at module top level — bundling it for a
worker target fails with **106** unresolved imports.

**`@earendil-works/pi-agent-core` bundles clean.** Same `Agent`, same tool
shape, no host assumptions. The whole worker is **566 KB**.

So this builds on `pi-agent-core` and gives up `pi-coding-agent`'s session tree,
skills and compaction plumbing — all of which are re-addable on top, and none of
which are the hard part.

## Shape

```
  cell (V8 isolate)                        daemon (a box with a shell)
  ┌────────────────────────┐               ┌──────────────────────┐
  │ pi Agent loop          │  POST /exec   │ bash -lc, one dir    │
  │ tools = fetch(...)     │──────────────▶│ per session          │
  │ SQLite: msgs, ops      │  opId cached  │ opId → result cache  │
  └────────────────────────┘               └──────────────────────┘
        │ LTX → object storage
        ▼
   transcript survives the node
```

No SSH and no agent protocol: three POST routes and a bearer token.

| route | body | returns | pi tool |
|---|---|---|---|
| `/exec` | `{opId, sessionId, command, timeout}` | `{stdout, stderr, exitCode}` | `bash` |
| `/read` | `{opId, sessionId, path, offset?, limit?}` | `{content, lines}` | `read` |
| `/write` | `{opId, sessionId, path, content}` | `{ok}` | `write` |

## The tools are pi's own

pi's `createBashTool`, `createReadTool`, `createWriteTool` and `createEditTool`
run in the cell unmodified. Their only host dependency is an `ExecutionEnv`
(`FileSystem & Shell`), which `src/execenv.js` implements over the workspace
daemon; `src/pitools.js` binds that env per session and wraps each call in the
op ledger. The hand-rolled bash/read/write that preceded them are gone as the
default — they were three tools maintained worse than pi maintains them, and
there was no `edit` at all, so every change to a file cost a whole-file rewrite.

`edit` is `{path, edits: [{oldText, newText}]}` with a unified diff back. On a
500-line file that is a few hundred output tokens against several thousand,
every edit. After compaction it is the largest cost lever here.

**Both backends run pi's tools now.** `src/execenv.js` implements ExecutionEnv
over the workspace daemon; `src/execenv.platinum.js` implements it over
Platinum's own API — `/exec` and `/files*` with a `sandbox:<id>`-scoped key, so
audit, billing, quotas, the spend gate and org isolation come with it. Platinum
serves `stat`, `list` and `grep` natively; `append`, `rename`, `mkdir`, `remove`
and `canonical` have no route and go through `/exec`, which is not a workaround
— the sandbox *is* a shell, and a route per filesystem verb would be
re-implementing coreutils over vsock.

Proven where it runs: an `edit` turn through `/prompt`, against a real daemon,
changes exactly the target line on disk and lands in the ledger as `edit`,
`done`. And the same four tools over Platinum's API against the stub, with the
scope refusal still holding underneath.

## The two invariants

**1. `opId` is pi's own `toolCallId`.** It is stable across a retry, so a cell
that dies mid-command and resumes elsewhere retries with the same id, and the
daemon returns the first result instead of running `rm -rf build && ...` twice.
Claim 4 is that property, and disabling the cache fails it (`the command
re-ran: 1 -> 2`) while claims 1–3 still pass.

The cell also writes the op to its own `ops` table **before** the call, with
`INSERT OR IGNORE` so a retry does not erase the evidence. That is what
distinguishes "never started" from "may have run" after a crash.

**2. Storage is truth, memory is cache.** `agent.state.messages` is rebuilt from
SQLite on *every* request, not only after an eviction — so the resume path is
exercised constantly instead of on the rare occasion it matters. The user
message is persisted before the model runs; the assistant message and its tool
results are persisted together on `turn_end`, because that is the only point
where the transcript is consistent.

## What cost the most time

**celld routes a cell to its owner by node id, and the id must be stable.** A
node restarted with a fresh identity is not the owner, so every request answers:

```
DurableObjectRoutingError: The Durable Object owner is currently unreachable
celld: peer owner unreachable scope=AgentCell:4f19… owner=127.0.0.1:8090
       error=peer no longer owns AgentCell:4f19…
```

The transcript was never at risk — the routing was. Setting `CELLD_NODE` to a
stable value fixed it, and claim 5 passed on the retry. This is the same hazard
[`../celld-boot.sh`](../celld-boot.sh) calls "the 36x one", from the other
direction: that comment is about ids that collide, this is about ids that
*move*. Under Platinum the host already sets `CELLD_NODE_PREFIX` from the
sandbox id, so a real cell gets this right; a hand-run node does not.

## Running it

```bash
npm install
./test/e2e.sh          # everything: MinIO, deploy, five claims
```

The model is injectable and **scripted by default** — deterministic, offline,
free, and it exercises the entire machinery that is actually ours. Set
`ANTHROPIC_API_KEY` in `wrangler.json` vars for a real model; `src/model.js`
speaks the API over plain `fetch`, because the Anthropic SDK pulls node builtins
and would not bundle.

## Measured cost

One laptop, Docker + MinIO on loopback, `./test/bench.sh`. Read these as an
order of magnitude and a ratio to each other, not as production numbers — a real
deployment puts a network between the cell and its bucket, and between the cell
and the daemon.

| | |
|---|---|
| celld process start → serving | **907 ms** |
| warm request to a live cell | **4 ms** |
| first request to a never-seen cell (cold isolate) | **35 ms** |
| daemon `/exec` called directly (baseline) | **7 ms** |
| prompt: 1 bash call, cold cell, end to end | **112 ms** |
| prompt: 5 sequential bash calls | **133 ms** |
| read a 22 / 102 / 302-message transcript | **2 / 6 / 5 ms** |
| SIGKILL → replacement node serving | **779 ms** |
| first read of that cell after the kill | **151 ms** (302/302 messages recovered) |
| worker bundle | **566 KB** |

Two things fall out of that table.

**A tool call costs ~17 ms of platform.** Warm, one call through the whole cell
is 28.8 ms against 5.9 ms for the same command spawned natively — the daemon hop
adds 0.9 ms of that, the isolate and agent loop the other 22. Five sequential
calls in one prompt cost 98 ms, so each additional call is ~17 ms.

An earlier version of this file said ~5 ms, from comparing 112 ms and 133 ms.
Both of those were COLD-cell measurements, where the cold cost dominated and
hid the per-call figure. Warm numbers are the honest ones.

**Transcript restore is flat and free.** 302 messages read in ~5 ms, no worse
than 22. Rebuilding `state.messages` from SQLite on *every* request costs
nothing measurable, which is what makes "storage is truth" affordable rather
than merely correct.

And the number that matters most is not in the table: an LLM turn is 2–30 s.
Every figure above is between three and four orders of magnitude smaller. Losing
the entire node and recovering a 302-message session costs **~0.9 s** — less
than one model round trip. The platform is not where the time goes, and it is
not where the money goes either; the transcript is the bill.

## How this is built and configured

Platinum has no Dockerfile. A template image is a **spec JSON** applied by the
platform's own builder, and this directory has both halves:

| what | file | how it ships |
|---|---|---|
| the cell runtime | [`../pt-celld.spec.json`](../pt-celld.spec.json) | celld only — the agent is not in the image |
| the workspace | `pt-agent-daemon.spec.json` | ordinary microVM template, `node:22-slim` + the daemon |
| the agent itself | `wrangler.json` → `celld deploy` | a **bucket write**, not an image build |

The workspace spec is **generated from the daemon source** (`npm run spec`),
because `copy` carries file content inline as base64 and hand-pasted base64 rots
the first time someone edits the source. Its ops (`apt`, `copy`, `env`), its name
regex and its cpu/ram/disk bounds are checked against
`POST /v1/templates/from-spec` in `apps/api/src/api/templates.ts`.

`wrangler.json` is the agent's configuration file — celld reads it directly
(bindings, `new_sqlite_classes`, string vars). `deploy.sh` does the three steps
in order: build the workspace, create the cell, write the bundle.

**`Dockerfile.celld` is not part of any of this.** Platinum's builder does not
run on a laptop, so that file mirrors the celld install step purely so
`./test/e2e.sh` can drive a real celld node without a control plane.

The split is the useful part: **the image is the runtime, the agent is data in
the bucket.** Shipping new agent code is a bucket write. It does not reach a cell
that is already running — nodes load a deployment at startup — which is why
`deploy.sh` ends with a stop/start rather than a hope.

## Should we take celld 0.4.0?

Not yet, and the reason is measured rather than cautious. v0.4.0 (2026-08-28) is
newer than the pinned v0.3.0 (2026-08-20) and adds real things: `celld dev` (a
local node with no bucket and no Docker), `cell list`, `kv`, `queue`, and —
the headline — **deployments adopted in place**.

That last one is genuine. Flipping a marker in the worker and polling a RUNNING
node:

| | behaviour | its own `--help` |
|---|---|---|
| 0.3.0 | 60 s, still the old bundle | "Nodes load a deployment at startup; restart them to serve this version." |
| 0.4.0 | **adopted after ~20 s, no restart** | "A running node polls the deployment pointer and adopts the new version in place; nothing restarts." |

So [`../RUNBOOK.md`](../RUNBOOK.md)'s "a redeploy does not reach a running cell"
is true of the version we pin and **false of the next one**. Worth knowing before
someone plans a rollout around it.

**The blocker was concurrency, and it is now solved.** Six concurrent prompts to ONE cell:

| | 0.3.0 | 0.4.0 |
|---|---|---|
| sequential to one cell | 200 | 200 |
| concurrent to *different* cells | 200 | 200 |
| concurrent to the *same* cell | **all 200** | **one 200, five closed** |

0.4.0 logs `incomplete_message ... connection closed before message completed`.
It will not hold several in-flight requests against one Durable Object.

That found a weakness in this design rather than only in celld: **a prompt held
an HTTP connection open for the whole agent turn**, and a turn is 2–30 s of model
time. So `/prompt?async=1` now accepts the prompt, queues it behind the same
promise chain that orders turns, and answers 202 immediately — the transcript is
in SQLite either way, so a client that disconnects loses nothing. On 0.3.0 that
works: six concurrent async prompts, 24 messages, six clean turns.

The first async attempt returned 202 and then did nothing on 0.4.0: the runtime
stops work once the response is sent, and neither `waitUntil` nor a held request
changes that. **The answer is an alarm.**

Turns are now rows in a `turns` table plus `storage.setAlarm()`. The alarm
handler is the only thing that runs a turn, so ordering is a `SELECT ... ORDER BY
i LIMIT 1` rather than a closure someone has to keep alive — and it survives an
eviction, a disconnect and a restart, none of which a promise chain does.

**Both versions now pass all nine claims**, so the upgrade is unblocked.

Two bugs on the way, both found by running it on both versions:

* The claim guarded against two alarms taking the same turn, which is not the
  failure. Six concurrent alarms each took a *different* pending turn and ran
  them in parallel — the exact interleaving the queue exists to prevent. The
  condition has to be global: `NOT EXISTS (... status='running')` inside the same
  `UPDATE`, which is atomic against other JS because the isolate is
  single-threaded and the call does not await.
* That bug was invisible on 0.4.0, which serialises alarm invocations, and only
  appeared on 0.3.0, which does not. Testing one version would have shipped it.

A turn found `running` from a previous life is marked **interrupted, never
re-run**. The op ledger protects a repeated tool call only because the id is
stable; asking the model again mints NEW toolCallIds, so every command would
execute a second time with no idempotency at all.

## Most of this does not need Docker, and it used to

`test/cell-harness.mjs` is a fake Durable Object: `state.storage.sql` is real
SQLite (`node:sqlite`), `setAlarm` is a timer, and the class under test is
imported from **`dist/worker.js`** — the bundle that actually ships, so nothing
is re-implemented or mocked away. If the bundle breaks, the test breaks.

It exists because of one bug. Six concurrent alarms each claimed a *different*
pending turn and ran them in parallel, producing the interleaved transcript the
queue exists to prevent. That was invisible on celld 0.4.0, which serialises
alarm invocations, appeared only on 0.3.0, and cost a full Docker run to find and
another to confirm. It is pure logic, and it now fails in two seconds with no
container.

Two things about the harness are deliberate:

* **Alarms overlap.** The first version cleared the pending timer on every
  `setAlarm`, so only one alarm was ever in flight — and removing the worker's
  global `NOT EXISTS (... running)` guard passed cleanly against it. A harness
  that cannot overlap cannot catch the bug it was written for. It models 0.3.0,
  which does not serialise: a queue correct under overlap is correct under
  serialisation, never the other way round.
* **The concurrency claim checks the transcript, not the aftermath.** Asserting
  "no turn is left running" *after* the alarms settle proves nothing, because by
  then they have all finished. The signature of the bug is two adjacent user
  messages — an alarm claims, writes its user message, and only then awaits.

What it does not test, and must not pretend to: replication, eviction,
hibernation, deployment adoption. Those are celld's.

## What boots what

celld's own `--help` is the authority; this is the chain, in order.

| stage | input | notes |
|---|---|---|
| 1. image | `../pt-celld.spec.json` | Platinum's builder. celld + `celld-boot`, nothing else |
| 2. entrypoint | `../celld-boot.sh` | reads `CELLD_BUCKET`, `AWS_*`, `CELLD_NODES`, `CELLD_NODE_PREFIX`, `CELLD_CROSS_VM`, `CELLD_NOFILE`; supervises and exits if a node dies |
| 3. node | celld flags / env | `--bucket`, `--endpoint`, `--region`, `--listen`, `--internal-listen`, `--advertise`, and **`CELLD_NODE`** |
| 4. deployment | `s3://<bucket>/<prefix>/deploy/current.json` | written by `celld deploy`, **read at startup only** |
| 5. bundle config | `wrangler.json` | main, DO bindings, `new_sqlite_classes`, string vars |
| 6. secrets | **`CELLD_VAR_*` / `CELLD_VARS_FILE`** | override worker vars at the node — see below |
| 7. all of it, locally | `agent.config.json` → `celldctl.mjs` | one file, one launch path |

### Old versions keep secrets forever

celld retains **every** version it has been deployed; `deploy/current.json` only
names the newest. That is right for rollback and wrong for credentials: a secret
that was in `wrangler.json` once stays in that version's manifest, and fixing the
code does not remove it. Measured — after the fix below, 19 historical manifests
still held `TOOL_DAEMON_TOKEN` and a test API key, and claim 8 kept failing until
they were purged.

**Rotating a leaked credential means purging history as well as rotating the
value.** `node celldctl.mjs purge` drops every version but the current one.

### The credential must not go through step 5

`celld deploy` uploads `wrangler.json`'s vars into the deployment manifest **in
the bucket**. celldctl used to put `MODEL_API_KEY` there, and it did exactly what
that implies — three manifests under `deploy/ptagent/` contained a complete
ChatGPT OAuth JWT. On Platinum that is the org's S3 prefix: a subscription token,
versioned, readable by anything with bucket access, surviving every redeploy.

Where they land is worth knowing, because it is not where you would grep: vars
become `raw_metadata.bindings[] = {name, text, type: "plain_text"}`, not
`"NAME": "value"`. Two earlier versions of the check were wrong in opposite
directions because they pattern-matched the serialisation instead of parsing it
— one reported clean with a planted canary in the manifest, the other flagged 14
innocent objects because a var NAME appeared with an empty value.
`test/scan-secrets.py` parses.

celld already provides the answer, and it is step 6. The credential now rides
`CELLD_VAR_MODEL_API_KEY` in the node's environment, which overrides the worker
var of the same name without ever reaching storage. Verified after the change:
the worker still sees a 1680-char token whose account-id claim decodes, a real
`gpt-5.6-luna` turn still writes and reads files, and a scan of every JSON object
under `deploy/` finds no credential.

### Knobs worth knowing

From `celld --help`, the ones that matter for an agent fleet:

| variable | default | why it matters here |
|---|---|---|
| `CELLD_V8_HEAP_LIMIT_MB` | — | the per-isolate heap budget the whole design is planned around |
| `CELLD_MAX_RSS_MB` | 80% of memory | the shed threshold; the capacity arithmetic assumes exactly this |
| `CELLD_IDLE_EVICT_S` | **disabled** | cells stay resident until memory pressure unless you set it |
| `CELLD_MAX_RESIDENT_CELLS` | — | hard cap, enforced at admission |
| `CELLD_LOCAL_CACHE_MAX_BYTES` | 2 GiB | hibernated SQLite cache |
| `CELLD_DURABILITY` | `fleet` | `fleet` acks at follower-fsync quorum; `bucket` waits for storage |
| `CELLD_OUTPUT_GATE` | on | `0` removes the durability wait from writes |

`CELLD_IDLE_EVICT_S` being disabled by default explains the memory numbers
above: nothing evicted during those runs, so 615 KB/cell is the resident cost,
not an average over hibernation.

## Compaction, and why it is the only optimisation that matters

Every other cost here is three to four orders of magnitude below a model turn.
What costs money is re-sending the conversation on **every** turn, so a session's
spend grows with the square of its length. Measured in a live cell against a
3000-token window:

```
turn  8   32 messages   2024 tokens
turn  9   25 messages   1519 tokens   <- compacted
turn 12   25 messages   1522 tokens   <- bounded, not growing
```

**`/context` reports the bill twice: estimated and actual.** The estimate prices
the whole transcript at the full input rate — the worst case, and the planning
number. The actual is what the provider says the session has already cost,
because every assistant message carries `input`, `output`, `cacheRead` and
`cacheWrite`, and those are recorded per turn.

That distinction matters because **pi applies prompt caching itself**
(`anthropic-messages` sets `cache_control`; the Agent forwards `sessionId` for
cache-aware backends), and the catalogue prices a cache read at roughly a tenth
of an input token — `claude-sonnet-5` is $2.00/Mtok in against $0.20 cached,
`gpt-5.6-luna` $0.20 against $0.02. Pricing every turn at the full input rate
overstated a long session and hid whether caching was working at all. `/context`
now reports the cache hit rate and what caching has saved, in dollars.

Prices need no credential: `MODEL_PROVIDER` + `MODEL_ID` are enough to ask "what
would this cost on claude-sonnet-5", which is useful before a key exists.

The window comes from pi's catalogue, so the threshold is per-model without a
table of our own — 400k for `gpt-5.1`, 1M for `claude-sonnet-5`, 272k for
`gpt-5.6-luna` — and `/context` reports the bill in dollars because the
catalogue carries price per million input tokens too.

Three silent bugs came out of testing it. `keepRecentTokens` defaults to 20000,
so below a ~40k window the cut keeps everything and compaction is decided,
attempted, and does nothing forever. `reserveTokens` defaults to 16384, so above
the window `shouldCompact()` compares against a negative budget and says yes for
an empty transcript. And a summary is its own **role**, not a text block —
storing it as "assistant" produces a contentless assistant turn. `settingsFor()`
now scales both to the window.

## A crash in the middle of a command

`npm run crash` kills the node while a command is running, brings the same node
identity back, and asks what the resumed cell knows. Three things held first
time: the op is `running` mid-flight, it survives the crash still `running` —
"may have run", not "never started" — and the transcript holds only the user
message, so the ledger is the *only* record.

The fourth did not, and it was the point of the whole mechanism: **the retry
re-executed the command, runs 1 → 2.** The daemon cached completed results only,
and a cell restarts in seconds, so the retry arrived while the first command was
still running. Fixed with single flight — an in-flight `opId` is registered
before the work and a retry awaits it instead of racing it.

The Platinum backend cannot be fixed that way: `/exec` takes no idempotency key.
The route's own comment records the cost of retrying anyway ("executes the
payload a SECOND time. Measured in prod 2026-07-31"), which is why it answers a
timeout with 504 rather than re-dispatching. So the cell does the same from its
side: an op still `running` in its ledger is reported to the model as an unknown
outcome rather than repeated.

## Two things the exact-match assertions hid

Switching to pi's own tools changed what every tool RETURNS, and three suites
compared results as one exact string. They failed as a single opaque blob that
said nothing about which tool was wrong, so the real regressions underneath went
unread. Those assertions are per tool now.

**pi numbers file lines from 1**, and treats offset 0 as 1. The hand-rolled read
tool it replaced was 0-based, so identical arguments now address a different
line.

**A config change did not restart the node.** `up` skips the restart when the
deployment version is unchanged, which is what stopped this machine's Docker VM
dying under six restarts a run. But node vars are passed with `docker run -e`,
and the skip compared the bundle only: changing one printed "already serving"
and kept the old value. Repointing `PT_WORKSPACE_ID` at another sandbox, or
rotating `PT_SANDBOX_KEY`, silently did not apply. The container now carries a
hash of its vars — hashed, because the label is readable by anyone on the host.

## The Docker VM crash was this repo

For weeks a sweep ended with "the docker VM died", and the theories were memory
pressure, restart churn, and a macOS CPU-wakeup limit. All three were wrong.

    lsof -ti tcp:7098 | xargs kill -9

`lsof -ti tcp:PORT` lists every process holding a socket on that port —
**including the process at the far end of a connection**. The cell runs inside
the VM and dials `host.docker.internal:7098`, so OrbStack proxies it and holds an
ESTABLISHED socket there, right beside our stub's LISTEN:

    pid 2757  OrbStack Helper   127.0.0.1:50937->127.0.0.1:7098 (ESTABLISHED)
    pid 5653  node              *:7098 (LISTEN)

`xargs kill -9` killed both. Once per sweep, at the one suite that has the cell
talk back to a host port. `reason: killed (SIGKILL)` in OrbStack's own kill log,
with no wakeup violation and no OOM, because nothing was wrong with the VM.

Five places did it — three in the suites and two in `celldctl`, which meant every
`up`. They now kill only LISTEN sockets, and only a process recognisable as ours.
A claim in `celldctl-logic` reproduces the shape — a node listener, a non-node
process connected to it — and fails if the far end dies.

What made this survive so long: the earlier hunts tested each suspect in
isolation, and in isolation there is no cell dialling out, so there is no far end
to kill. The bug needed the whole system running to appear at all.

## Counting what a cell owes

`BILLED_UNITS_IMPLEMENTED` in the control plane refuses to let any runtime claim
`'requests'`, because nothing counted them. A cell is the one runtime for which
per-request is the only honest unit: it hibernates to nothing, so billing it for
RAM it is not holding charges a customer for something they are not using.

`GET /meter` returns cumulative counters. The design decisions are all about the
ways a meter goes wrong:

**It lives in the cell's SQLite, not in the instance.** An idle cell is evicted
and rebuilt constantly — that is how celld runs, not an edge case — and a
counter in the instance resets every time. The customer would be billed for a
fraction of what they used, silently. The harness gained `rebuild()` (same
storage, new instance) so this is testable at all; without it every claim about
instance state passed trivially.

**Observability does not bill.** `/health`, `/meter` and `/sockets` are
excluded, by an explicit list rather than a name convention, so adding an
endpoint is a decision about billing rather than an accident of its path. A
monitor polling `/health` must not move a customer's invoice, and reading the
meter must not change it.

**Reading does not reset.** A meter that zeroed on read would lose everything
between a reader crashing and its next call, and two readers would each see half
the truth. The control plane takes differences between readings.

**`/reset` does not clear it.** `/reset` is a conversation operation, and the
party being billed must not be able to erase the bill by calling it.

What this does **not** do: report to the control plane. `BILLED_UNITS_IMPLEMENTED`
is unchanged and still excludes `'requests'`, because the heartbeat does not
carry this and the CP does not meter it. The counting exists; the billing does
not, and the registry should keep saying so until it does.

## What eviction actually does, measured

This was claimed and retracted once: an earlier run reported "HIBERNATION HELD"
while the eviction lines in the log belonged to a **different cell**. It is
measured per cell now.

**celld 0.3.0 logs no eviction line at all.** A grep for `evict|shed|...` returns
matches only because `publi`**`shed`** contains "shed" — which is exactly how the
first attempt fooled itself. What celld *does* emit is an **epoch per cell**: a
fresh isolate is `epoch=N fresh=true`, and one rebuilt from object storage comes
back `epoch=N+1 fresh=false`. That pair is the proof, and the suite refuses to
judge anything until it has seen it.

With that, three things are now known rather than assumed:

**Both eviction knobs work.** `CELLD_MAX_RESIDENT_CELLS`: touch a cell, touch
ten others, touch it again — `epoch=1 fresh=true` → `epoch=2 fresh=false`. And
`CELLD_IDLE_EVICT_S`, which this repo previously recorded as doing nothing:
measured against a control cell kept warm on the **same node with the same
config**, an idle cell is evicted after the threshold and the warm one is not.
The old note was reached by looking for a log line celld never writes.

That second one matters beyond the test: **cell-level scale-to-zero already
exists in celld.** An idle cell is dropped from memory and rehydrated on demand
in ~23 ms warm-node, ~104 ms cold-node. The residency oversell is real, not
aspirational.

**Socket survival across an eviction is NONDETERMINISTIC.** Some runs the
watcher receives turn events from the rebuilt cell and `getWebSockets()` still
reports it — hibernation held. Others the socket stays open, `getWebSockets()`
reports 0, and nothing reaches it: worse than a close, because nothing tells the
client to reconnect.

This was stated as a definite result twice, in both directions, and both times
it was a generalisation from a single observation of a system that does not
behave the same way twice. The suite no longer asserts an outcome. It asserts
CONSISTENCY: if the watcher got events the cell must still hold the socket, and
if it got nothing the cell must not. A cell broadcasting to a socket it does not
hold — or holding one it cannot reach — is a real bug in a way that neither
outcome alone is.

**Whether the client can still reach the cell is also a coin toss.** An inbound
message on that same socket is *sometimes* delivered to the rebuilt cell and
answered, and sometimes not — this was first written as a confident finding on a
single observation, and a later run contradicted it. It appears to depend on how
far the eviction had progressed. Either way the server cannot push, so nothing
actionable rests on it.

Re-adopting the socket on its first message looked like the fix and **is not**.
Measured: the ping is answered, but the instance serving the next request
reports `readopted: 0` — celld hands an inbound message to a *transient*
instance whose in-memory state does not persist. There is no way for a rebuilt
cell to push to a socket opened before it.

**The mitigation is reconnecting**, and that is a claim: a fresh socket receives
events from the rebuilt cell. A client must treat silence as a dead connection
rather than trusting an open one.

## Compaction must not destroy the record

Compaction answers "what should the model be sent?" It was answering "what
happened?" at the same time, by **deleting** the messages it summarised. After a
long session `/history` showed a summary and a tail, and what the agent actually
did — every tool result it had reported — was gone.

The transcript is kept now and the context is a **window** over it, marked by
`meta.context_from`. `loadMessages` reads the window; `/history` serves it by
default and `?all=1` adds the archive.

Two things this made visible. `/context` counted the whole table while its token
figure described the window, so the one number on that endpoint that says "how
big is the context" was the wrong one. And `/reset` cleared the rows but not the
watermark, which then pointed past every row in an empty table — the session
would have loaded nothing, forever.

The archive is **bounded** at 8 MB, oldest first, because a cell's SQLite
flushes to S3 on every change. It never touches the active context.

All of it is claimed **across a cell rebuild**, not only within one instance.
Every other claim in that suite reads from the same instance that wrote it, and
would hold even if none of this were in SQLite. The sharp end is the watermark:
`context_from` lives in the `meta` table, and as instance state a rebuilt cell
would reload the **whole archive** into context — silently unbounding both the
context and the bill while `/history` still looked correct.

Honest note on what that added. The old suite did catch that mutation, but
incidentally and with one claim — `/reset` noticed a stale watermark. The new
ones catch it directly with three, and name the consequence.

## Parity between the two backends

The daemon and Platinum are meant to be interchangeable. They were not.

**The op ledger has moved into the cell.** The daemon kept one, and it is what
made a retried tool call safe there; Platinum's `/exec` and `/files` are plain
calls, so a turn replayed after a crash re-ran whatever the call did — the
failure the whole design exists to prevent, on the path that is the product. The
ledger now lives in the cell's SQLite and covers both. The daemon keeps its own
underneath: it protects the individual filesystem ops *within* a tool call and
survives the cell entirely, which a ledger inside the cell cannot.

**A result too large to store is dropped, not truncated.** A truncated replay is
a *wrong* answer — valid-looking JSON that is half a command's output — where a
dropped one replays as an honest refusal to re-run. The cap is 200 KB and is
**unreachable today**: measured 2026-09-03, the largest result any tool can
produce is 50,039 bytes through the daemon (which caps stdout at 50 k), 102,857
through Platinum's `/exec`, and 359 bytes for a 400 KB file read because pi's
read tool truncates and reports the remainder. It stays as a backstop on what a
cell writes into storage that flushes to object storage on every change, and the
relationship is pinned by a claim: raise the daemon's stdout cap past it and a
test fails, instead of sessions quietly becoming unretryable.

**A failed call is still a completed call.** It is replayed rather than re-run.
The cell cannot tell "the command exited non-zero" from "the command ran and the
reply was lost", and the second re-runs side effects. A model that genuinely
retries emits a new tool call id, so the only caller arriving with the same id
is crash recovery.

**Who answers "did it run?" depends on what is underneath.** A call recorded as
`running` is re-dispatched only to a backend that advertises its own ledger. Get
that wrong in one direction and Platinum runs side effects twice; wrong in the
other and the daemon path refuses work it could have resolved.

**One tool set.** It was four tools on the daemon and six on Platinum, because
`list` and `grep` came from Platinum's native routes. They are now written once
against the `ExecutionEnv` and served by both, so what the model can do does not
depend on which backend a deployment happens to use. `grep` runs through the
shell even on Platinum, where a native route exists — paid deliberately, because
two implementations that format results differently is worse than one that is
occasionally slower.

**What cannot be equal**: Platinum has no cancel channel, so an aborted command
runs to its own timeout there. That is the platform's limit, recorded rather
than hidden.

## Skills, from the workspace

pi ships the whole loader — it walks the directory, parses `SKILL.md`
frontmatter, honours ignore files, reports diagnostics — and it takes an
`ExecutionEnv`, which is the interface this cell already implements. So skills
come from the workspace over whichever backend is configured, with no filesystem
in the isolate and nothing re-implemented here.

`GET /skills` lists what the cell can see, with the diagnostics. Without those,
a skill with broken frontmatter is invisible: the only symptom is a model that
never uses a skill somebody swears they wrote.

**Only the name, description and path reach the system prompt** — never the
content. The model reads a skill with its own read tool when a task matches it.
Two skills cost about 670 characters of prompt however long the skills are.

**Loading is cached per live cell**, because it costs 19 round trips for two
skills and the workspace rarely changes under a session. `?reload=1` re-reads,
and that path has a trap worth naming: loading LISTS and READS through the
daemon, which caches every op by id. A fixed op prefix would replay the first
load's reads forever — edit a `SKILL.md`, reload, get the old text back. The
prefix is fresh per load precisely so a reload is a reload.

Skills are loaded **per session**, because the daemon roots each session at its
own workspace: loading them under a fixed id read from a directory no session
works in, and the agent's own `.pi/skills` was invisible.

`POST /prompt {skill, text}` invokes one by name, formatted by pi rather than by
prose this cell invented. An unknown name is a 404 listing what does exist.

## Cancelling a turn

pi's bash tool is handed an abort signal and honours it — for its own return
value. That is not the same as stopping anything. An aborted `sleep 5` used to
sleep the full five seconds, run to completion, and only then tell the caller it
had been cancelled: a user stopping a runaway build got no relief, the cell
stayed blocked, and the command went on touching the workspace after the agent
had stopped listening.

The wire is small and every piece of it was wrong at first:

pi names it **`abortSignal`** in `ExecOptions`, not `signal`. Reading it as
`signal` is a silent no-op.

The daemon kills the **process group**, not the child. `bash -lc` may exec a
subshell, and killing bash alone leaves a grandchild writing into the workspace.

**A dropped connection is not a cancellation.** The obvious implementation kills
the command when the socket closes. That passes every cancellation test and
breaks crash recovery, which is the opposite case: a cell SIGKILLed mid-command
is exactly when the command should FINISH, so the retry carrying the same
toolCallId is answered from the ledger instead of running again. The two are
indistinguishable at the socket, so cancelling says so on `/cancel` and a
disconnect means nothing. Both directions are claims now.

On the Platinum path the signal releases the caller, but `/exec` has no cancel
channel, so the command runs on in the sandbox until its own timeout. That is
the honest limit of that path.

`POST /stop?c=<session>` is what triggers any of it. pi creates the abort signal
inside `agent.prompt()`, so the cell holds the running agent and calls `abort()`
from outside. Without that route every layer beneath it was unreachable and a
runaway command was unstoppable for its full timeout. `?queue=1` also drops what
has not started — off by default, because stopping the command someone is
watching is a different intent from discarding work they queued.

## Forking a session

`POST /fork {to, upTo?}` branches a conversation: the target session ends up
with a prefix of this one's transcript and carries on independently. `upTo`
counts messages and is clamped, so asking for more than exists means all of it.

pi has a session **tree** for this — entries with parent ids, lanes, branch
bounds — behind an 18-method `SessionStorage` interface. Implementing that over
SQLite to get one user-visible feature is the wrong trade here, because **a cell
already is a session**: its transcript is its storage, and a fork is another cell
holding a prefix.

A cell cannot write a sibling's SQLite — that isolation is the point — so the
parent reads its own messages and the child imports them over the Durable Object
binding. One RPC, no shared state.

Two refusals matter more than the happy path. Importing onto a session that
already has a transcript is a **409**: silently merging two conversations is
worse than failing, and a fork onto a live session is a mistake rather than an
intention. And the **op ledger is not copied** — those ids belong to calls the
parent made, and a child claiming them would have the daemon answer its retry
from the parent's result. The child gets one `fork` row saying where it came
from.

## Watching a session

Turns run in an alarm, so nothing is happening on the request that started them —
the WebSocket is how a client sees progress. A turn streams:

```
hello                       (state on connect: messages, pending turns)
turn_started turn=1
tool_start   tool=bash
tool_end     out="STREAMED\n\n[exit 0]"
tool_start   tool=write
tool_end     out="wrote a.txt"
turn_done    turn=1
```

The socket is accepted through `state.acceptWebSocket()` rather than
`accept()`, so it belongs to the runtime and not to the instance, and
`state.getWebSockets()` is what broadcasts — an instance field emptied on every
eviction. celld confirms the accept in its own log ("accepted hibernatable
WebSocket"), and `setWebSocketAutoResponse` answers keepalives in the runtime so
a ping does not wake the isolate. A parked session woken every 30 s by a
heartbeat is not parked.

Twelve claims cover it, and the one that would matter most if it were wrong is
**cross-session isolation**: a turn is driven on session A only, and a watcher on
session B must see its own turn and nothing of A's. Also checked — both watchers
on one session get the stream (not just the first), every watcher gets `hello` on
connect including a late joiner, a reconnecting client is served, a client that
drops mid-stream does not take the turn with it, and events arrive in order.

Mutation-checked: broadcasting to only the first socket, dropping `hello`, and
not broadcasting tool events each fail their own claim.

Prompts do **not** go over the socket. They go through `POST /prompt`, which is
durable, ordered and auditable; accepting work on the socket would be a second,
unqueued way in.

**One thing here is unverified, and it is the one the capacity argument needs.**
I could not make celld evict a cell that holds an open socket — not with
`CELLD_IDLE_EVICT_S=3` and twenty seconds of silence (which evicted nothing at
all, even a cell with no socket), and not with `CELLD_MAX_RESIDENT_CELLS=1` plus
traffic to a second cell. An earlier run of mine appeared to show a socket
surviving an eviction and did not: the eviction lines in the log belonged to a
different cell. So "a parked session costs a file descriptor, not an isolate"
rests on using the right API, not on a measurement I have taken.

## The Docker VM keeps dying, and it is not this code

On this machine the OrbStack VM is SIGKILLed after roughly four or five heavy
suites. Everything below was tested to find out why, and none of it reproduces
the crash:

| suspected | tested | result |
|---|---|---|
| host memory | sampled through a failing run | min **5.46 GB free** — not pressure |
| VM disk | `df` inside the VM | 34.5 GB free |
| celld churn | 25 cycles of a **working** node, real bucket traffic | survived |
| bind mounts | 20 cycles mounting `node_modules` (10,722 files) | survived |
| real deploys | 15 cycles of esbuild-in-container + S3 writes | survived |
| `docker kill` | 8 SIGKILLs of a live container | survived |
| short-lived containers | 16 `run --rm` | survived |
| published ports | 8 cycles idle, 8 with curl hammering | survived |
| host dialling | 8 to an open host port, 8 to a closed one | survived |

Only sustained multi-suite load does it, and OrbStack leaves no crash report in
`DiagnosticReports` — the VM is killed, the app does not crash. **OrbStack 2.2.3.**

Two things came out of it that are worth keeping regardless:

* `celldctl up` no longer restarts a node that is already serving the current
  bundle. Every suite called `up`, so a full run restarted the cell six or more
  times for no reason; celld 0.3.0 only needs a restart when the deployment
  actually changed, and the container is now labelled with the version it was
  started against.
* `npm test` runs every suite, checks the daemon before each one, brings it back
  with `orb start` (which does not need the GUI crash dialog dismissed), and
  retries a suite **once** if the daemon died underneath it. A recovered run is
  reported as recovered and the restart count is printed — a suite that only
  passes on the second attempt is a different fact from one that passes.

## What this is not

- **The daemon's ledger is on disk** (`.ledger.sqlite` in the work root).
  Completed results replay across a daemon restart; an op that was *in flight*
  when the daemon died is answered as an unknown outcome and never re-run — the
  same rule the cell applies from its side. Testing this found a second bug: a
  mistyped route returned 404 with a plain `return`, so the in-flight
  registration and the `running` row leaked, and every later retry of that id
  hung on a promise nobody owned. Routes are now validated before anything is
  registered.
- **The daemon is the security boundary** and belongs in a container. It is now
  tested like one (`npm run safety`, 15 claims, no Docker), and that testing
  found two real holes:

  **A symlink inside a session escaped it.** `resolve()` is textual — it
  collapses `..` and knows nothing about links — so a link pointing at `/etc`
  passed the containment check and `read escape/hosts` returned the host's
  `/etc/hosts`. The file's own comment had admitted this was possible and left
  it. Paths are now resolved with `realpath` (walking up to the deepest existing
  ancestor, so a write to a not-yet-existing file is still checked), and the
  containment test sees where a path actually *lands*.

  **Single flight had a race.** The in-flight registration sat after
  `await mkdir(...)`, and an await is exactly where three concurrent retries
  slip past each other: all three checked, all three found nothing, all three
  yielded, and only then did they register. Measured: three retries, **two
  executions**. Registration now happens before the first await.
- **No streaming.** The WebSocket route broadcasts event types only; token
  streaming is unnecessary while the cell hibernates between turns.
- **No compaction.** That transcript table is also the LLM bill — it is the
  first thing to build next, not the bundling or the sharding.

## A contract test that reads the other side of the contract

`platinum-shapes.mjs` pins what the tools send against what
`apps/api/src/api/sandboxes.ts` accepts — `timeout_ms` in milliseconds, a
100–300000 range, `path` as a query parameter. It used to assert those numbers
as **literals**, which is a copy of the contract and cannot notice the original
changing.

Verified, not assumed: with the route's ceiling changed to 120000 in `apps/api`,
the old suite still printed *"every request matches the route contract"*. The
agent would have broken in production against the route it was written to match,
with every claim green.

The same applies one layer deeper. `platinum-stub.mjs` imitates the platform's
routes by hand, and every claim in `execenv-platinum.mjs` runs against the stub —
so a rename on the platform side (`is_dir` → `isDir`, `mtime` → `modified_at`)
leaves all of them green while `fileInfo()` reports every directory as a file
and every mtime as 1970. `invmAgent.ts` declares those shapes as types on its
`rpcJSON` calls, so they are parsed and claimed too, including that **the stub
answers with the platform's own field names** rather than names of its own.

The schema is parsed out of `apps/api` now and the claims are made against that.
The parse is deliberately strict — **if the shape it expects is not found, the
claims fail rather than skip**. A contract test that quietly stops testing when
it cannot find the contract is the exact failure it exists to prevent, and
renaming `timeout_ms` triggers it.

## Which guards cannot fail?

Two auditors, because guards come in two shapes.

`npm run guards` removes each `throw` in turn and runs the suites. A guard whose
removal breaks nothing is untested or unreachable. Its first honest run — whole
statements, nothing excluded — found **6 of 14** untested: a 5xx from the daemon
that no test had ever produced, a failing `list` whose tempting answer is
`(empty)`, a half-configured Platinum backend that would have sent every request
to `undefined`.

`npm run conditions` does the same for `if` conditions, which is most of what
this code actually decides. `worker.js` has **zero** throws across 1002 lines, so
the first auditor said nothing whatsoever about it. The second found the base64
padding shim — a fix for a real celld bug — with no claim behind it at all.

Neither number is a score to drive to zero. Many survivors are branches whose
absence is invisible by design. The list is for reading: what matters is telling
a defensive bounds check apart from a documented behaviour nobody ever ran.

Both auditors state what they did **not** cover rather than leaving it implied —
a suite that is not run cannot fail, so every guard it covers would otherwise be
reported as a survivor. The first version of the bindings auditor had exactly
that defect, which is the thing these exist to find.
