# pi-worker — Phase 0 spike

A working Kortix **worker**: the agent harness, running in a 138 MB Alpine
image, with every file and shell operation routed over RPC into a separate
environment. Its own disk is never touched by any built-in tool.

Reference: `docs/specs/2026-08-26-harness-worker-split.md`.

> This is a spike. It is here to answer questions and produce numbers, not to
> ship. Nothing in `apps/` was changed.

---

## The result in one line

`pi-agent-core`'s built-in tools do not touch the filesystem directly — they
resolve it from an injected `ExecutionEnv`:

```ts
export interface ExecutionToolContext { env: ExecutionEnv }   // pi-agent-core
export interface ExecutionEnv extends FileSystem, Shell {}
```

So the worker does not rewrite, wrap, or forbid a single tool. It supplies one
object:

```ts
const tools = [createBashTool(), createReadTool(), createWriteTool(), createEditTool()]
  .map((t) => bindTool(t, { env: new KortixExecutionEnv({ baseUrl, cwd }) }));
```

That is the whole harness/environment split. One seam, not a policy.

---

## How to test it

### 0. Prerequisites

Docker, and `bun` for the local runs. Everything below works with **no Kortix
credentials and no API key** — the spike uses pi's built-in `fauxProvider`,
which is a real provider interface returning scripted assistant messages, so
the agent loop, the tool dispatch and the RPC are all genuinely exercised.

```bash
cd spikes/pi-worker
npm install
```

### 1. The proof — S0.1, "tool replacement holds"

```bash
bun test/proof.ts
```

Expected:

```
  PASS  every tool call crossed the RPC boundary  — 8 RPC ops: absolutePath, canonicalPath, writeFile, exec, exists, readBinaryFile
  PASS  shell executed through the environment, not locally
  PASS  write executed through the environment
  PASS  the file exists in the ENVIRONMENT
  PASS  the WORKER disk is byte-for-byte unchanged
  PASS  no agent artifact anywhere on the worker
6/6 passed
```

**Read the fifth assertion, not the fourth.** "The agent wrote a file" proves
nothing. "The agent wrote a file *and the worker's disk is byte-for-byte
unchanged*" is the claim — a run that does both the right thing and a local
write is a failure, because that is precisely how the split silently collapses
back into today's single box.

The test snapshots the worker's cwd (size + mtime, recursively) before and
after a real turn and diffs it.

### 2. Build and run the two containers

```bash
bun build src/worker.ts          --target=node --format=esm --minify --outfile dist/worker.mjs
bun build src/stub-environment.ts --target=node --format=esm --minify --outfile dist/environment.mjs

docker build -t kortix-worker:spike .
docker build -t kortix-env:spike -f Dockerfile.environment .

docker network create kx-spike
docker run -d --rm --name kx-env    --network kx-spike kortix-env:spike
docker run -d --rm --name kx-worker --network kx-spike --read-only -p 18080:8080 \
  -e KORTIX_ENV_URL=http://kx-env:8100 kortix-worker:spike
```

Note `--read-only`: the worker runs with an immutable root filesystem as an
unprivileged user. That is defence in depth *behind* the ExecutionEnv seam, not
instead of it.

### 3. Drive a turn

The `script` array scripts the faux model: `{"tool": …}` makes it emit a tool
call, `{"text": …}` makes it answer and stop.

```bash
curl -s -X POST localhost:18080/prompt -H 'content-type: application/json' -d '{
  "text": "write a report and inspect the machine",
  "script": [
    {"tool":"write","args":{"path":"/workspace/report.md","content":"# built by the worker\n"}},
    {"tool":"bash","args":{"command":"head -1 /etc/os-release; ls -la /workspace"}},
    {"tool":"read","args":{"path":"/workspace/report.md"}},
    {"text":"done"}
  ]}'
```

Returns the ops that crossed the boundary:

```json
{"ok":true,"result":{"messages":8},
 "rpcCalls":["absolutePath","absolutePath","canonicalPath","writeFile","exec","absolutePath","exists","readBinaryFile"]}
```

### 4. Check where the work landed — this is the point

```bash
docker exec kx-env    sh -c 'ls -la /env-root/workspace && cat /env-root/workspace/report.md'
docker exec kx-worker sh -c 'find / -name "report.md" -not -path "/proc/*" 2>/dev/null'
```

The file is in the **environment**. The worker has no `/workspace` at all and
the `find` returns nothing.

### 5. Measure cold boot

```bash
for i in 1 2 3 4 5; do
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  docker run -d --rm --name kx-boot --network kx-spike --read-only -p 18081:8080 \
    -e KORTIX_ENV_URL=http://kx-env:8100 kortix-worker:spike >/dev/null
  until curl -sf localhost:18081/health >/dev/null 2>&1; do sleep 0.01; done
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  echo "run $i: $((t1-t0)) ms"
  docker rm -f kx-boot >/dev/null
done
```

### 6. Other endpoints

```bash
curl -s localhost:18080/health                 # boot ms, model mode, RPC count
curl -sN localhost:18080/events                # SSE: the live agent event stream
curl -s -X POST localhost:18080/interrupt      # abort the current turn
```

### 7. With a real model (needs your own key)

```bash
docker run -d --rm --name kx-worker --network kx-spike --read-only -p 18080:8080 \
  -e KORTIX_ENV_URL=http://kx-env:8100 \
  -e KORTIX_MODEL_MODE=real \
  -e KORTIX_API_KEY="$ANTHROPIC_API_KEY" \
  kortix-worker:spike

curl -s -X POST localhost:18080/prompt -H 'content-type: application/json' \
  -d '{"text":"Create /workspace/hello.txt with a haiku about sandboxes, then cat it."}'
```

Add `-e KORTIX_GATEWAY_URL=https://<gateway>` to route through the Kortix LLM
gateway instead of the provider directly — that single variable is the whole
gateway integration, because pi models `ModelAuth` as
`{ apiKey?, headers?, baseUrl? }`.

---

## Benchmark: real Daytona sandboxes

`bench/daytona-bench.ts` is standalone — no Kortix API, no database, no UI. It
builds a Daytona snapshot from the worker image, boots real sandboxes, measures,
and deletes everything it created.

```bash
bun bench/daytona-bench.ts --runs=5                     # faux model
bun bench/daytona-bench.ts --runs=5 --delete-snapshots  # also drop the snapshots
KORTIX_API_KEY=sk-... bun bench/daytona-bench.ts --real # absolute TTFT
```

Credentials are read with `dotenvx get` from `apps/api/.env` and never written
anywhere. `--keep` leaves the sandboxes up for poking; without it the `finally`
block deletes them even on failure.

### Results — 5 runs, Daytona `us`, 1 vCPU / 1 GB

```
daytona create() call      min  1205 ms   med  1410 ms   max  1633 ms
process start -> serving   min   211 ms   med   543 ms   max   759 ms
time to first token        min    12 ms   med    13 ms   max    16 ms
bash tool round trip       min    60 ms   med    67 ms   max   284 ms
```

**The tool round trip is the finding.** 67 ms median, worker → provider edge →
environment — the same shape production would use (worker → Kortix proxy →
sandbox daemon). At that cost **a 200-tool-call turn pays 13.3 s, on every turn,
forever**, against a `bash` that is a local fork today at roughly 1 ms.

That is larger than the one-off boot saving. The split is a clear win for
reasoning-heavy sessions and a regression for tool-heavy ones unless the RPC is
multiplexed and co-located. It is not a detail to schedule later; it decides
whether the architecture pays.

With the faux model, TTFT is infrastructure only — boot plus dispatch. That is
deliberate: provider latency is identical before and after the split, so
including it only adds noise to the decision.

### Two measurement traps this hit, both worth knowing

1. **Daytona isolates sandboxes from each other.** A worker cannot reach an
   environment by private IP — `EHOSTUNREACH`. The first run reported a
   suspiciously constant "3.07 s round trip" which was a TCP connect timeout
   times one retry, not latency. The reachable path is the provider's edge,
   which is also the production topology.
2. **`/proc/uptime` is virtualized in Daytona** and disagrees with the process
   clock read microseconds later (280 ms vs 513 ms), so "VM boot → serving"
   cannot be measured from inside the sandbox at all. That gap is precisely
   what P1.0's API-side clock exists to measure — independent evidence that it
   is needed, not optional.

---

## Head to head against the sandbox we ship today

`bench/compare.ts` boots both on Daytona, same region, same account, same spec
(2 vCPU / 6 GB / 20 GB — production's `DEFAULT_*` from
`apps/api/src/snapshots/build-context.ts`), and asks the new one a real question
through OpenRouter, the path production uses.

```bash
cd spikes/pi-worker
bun bench/compare.ts --runs=5
bun bench/compare.ts --runs=3 --say "Write a haiku about cold starts."
bun bench/compare.ts --runs=3 --model=openai/gpt-5 --keep
```

Everything it creates it deletes, including on failure. `--delete-snapshots`
also removes the worker snapshot it built.

### What it prints

```
run 2/5
  NEW      create    986 ms   serving   1159 ms   ANSWERED   3800 ms
           first token after prompt   1988 ms
           > A sandbox is an isolated testing environment where code can run
             safely without affecting the main system or production environment.
  CURRENT  create    872 ms   daemon alive    972 ms   RUNTIME READY   2272 ms
```

Both arms are held to the same bar: `runtimeReady:true` on the current box's
`/kortix/health` is the point it could actually serve a prompt, which is the
honest equivalent of the worker being able to answer.

### Result — 8 runs

| | worker (140 MB) | today (6.2 GB) |
|---|---|---|
| ready to take a prompt, median | **1.45 s** | 2.72 s |
| ready to take a prompt, worst | **2.08 s** | **22.7 s** |
| answered a real model prompt | 3.7 s (incl. ~1.7 s model latency) | not reached in-window |

**The median win is ~1.9x. The tail win is ~11x, and the tail is the point.**
The worker's spread across every run was 1.16–2.08 s. Today's sandbox ranged
2.3–22.7 s on identical infrastructure with identical inputs. That 22-second
outlier is the "intermittently slow start" from the huddle, reproduced and
measured.

### The premise correction

The huddle assumed the 6–8 GB image *is* the boot cost — restore from object
storage at ~50 MB/s. **On Daytona's warm-snapshot path that is not what
happens.** A 6.2 GB active snapshot typically boots in ~1.5 s, and the 44x
image-size ratio buys roughly 1.9x, not 44x.

So the case for the split is not "the image is huge". It is:

1. **Predictability** — a bounded, boring 1.2–2.1 s instead of a distribution
   with a 22-second tail.
2. **Decoupling** — harness upgrades stop requiring image turnover.
3. **Zero-compute sessions** — a session that only reasons never provisions
   the fat box at all.

Speed is real but modest. Determinism is the product. That reframing should
reach the plan before Phase 1 is scoped, and it makes P1.0's clock more
important, not less: the number that justifies this work is a p99, not a
median.

---

## Resume from ARCHIVED — the case the huddle argued about

Daytona's own docs: archiving moves *"the entire filesystem state to
cost-effective object storage… starting an archived sandbox takes more time,
**depending on its size**."* That is the Marko/Kubet disagreement, stated by the
provider. `bench/resume.ts` puts both arms through the identical journey —
create → fully warm → stop → archive → **start** — and times that last step.

```bash
bun bench/resume.ts --runs=2                     # ~10 min: archiving 6.2 GB is slow
bun bench/resume.ts --runs=2 --delete-snapshots
```

### Result — 4 cycles each

| archived → able to serve | worker (140 MB) | today (6.2 GB) |
|---|---|---|
| `start()` returns | 2.7 s | 3.0–6.3 s |
| VM reports started | 3.1 s | 3.3–6.6 s |
| **able to serve a prompt** | **3.2 s** (2.77–3.46) | **6.0 s** (4.85–8.12) |

**~2x, and size does matter here** — unlike create-from-snapshot, where it
barely did. But it is still 2x off a 44x image-size ratio, so "the image is
huge" remains the wrong headline.

### Where the 2x actually comes from

Split the resume into provider restore and software re-init:

| | provider restore | software re-init | total |
|---|---|---|---|
| worker | ~2.7 s | **0.16 s** | 3.2 s |
| today | ~3.0–6.3 s | **1.5–1.8 s** | 6.0 s |

Roughly half the gap is Daytona pulling more bytes back. The other half is
kortixd and OpenCode re-initialising after the VM is already up — **0.16 s
versus 1.5–1.8 s**. The worker `exec`s one pre-bundled `.mjs` and is done;
today's box has to bring a runtime back to life.

That second column is the part the split actually controls, and it is the
better argument: not "our image is smaller" but "our box has almost nothing to
do once it exists".

### Side finding: archiving costs minutes

| | archive → archived |
|---|---|
| worker | 24–31 s (median 28 s) |
| today | **121–199 s** (median 135 s) |

~5x. A box being archived is unavailable for over two minutes today. Nothing in
the plan accounts for that, and it is worth checking whether the reaper's
archive path can collide with a wake.

### One honest wrinkle in the output

Asked what it had just resumed from, the worker answered *"I didn't resume from
anything — this is the start of our conversation."* Correct, and a problem: the
spike uses `InMemorySessionRepo`, so conversation state does not survive the
archive. That is exactly what **S0.4** (a durable session store) exists to fix,
and this is the first time it has bitten in a measurable way.

---

## Measured locally

| | today (`apps/sandbox`) | this worker |
|---|---|---|
| image | ~6–8 GB | **138 MB** |
| bundle | n/a — clone + resolve at boot | **one 516 KB `.mjs`**, 907 modules inlined |
| container start → serving | — | **226–274 ms** |
| harness construction | — | **56–88 ms** |
| runtime module resolution | npm/plugin load at boot | **none** |

Docker on macOS, so these are a proxy for a micro-VM, not a substitute — see
the Daytona benchmark above for numbers on real infrastructure. The number the
plan still needs is P1.0's: `POST /sessions` → first token, on dev, against
today's warm-pool hit.

---

## What the spike found

1. **`ExecutionEnv` is the seam** — one injected object moves the agent's entire
   world. Better than the per-tool override the plan assumed.
2. **Build on `pi-agent-core`, not `pi-coding-agent`.** The full package drags in
   `jiti` (runtime module loading, fights a hermetic bundle) and
   `@silvia-odwyer/photon-node` (WASM/native, a musl risk). `pi-agent-core` has
   neither and bundles clean.
3. **`AgentHarness` is not implemented in 0.84.3** — all 23 methods throw
   `HarnessNotImplemented`. The working orchestrator is `Agent`
   (`prompt` / `steer` / `followUp` / `abort` / `subscribe`, plus
   `beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` hooks). Pin the
   version and watch this.
4. **The gateway is a `baseUrl`** — `ModelAuth { apiKey?, headers?, baseUrl? }`.
   S0.2's kill condition does not fire.
5. **The tool RPC tax is measured, and it is the deciding number.** 67 ms
   median per call on Daytona. See the benchmark section.
6. **Per-call HTTP is already fragile at three calls.** The first end-to-end run
   died on `"The socket connection was closed unexpectedly"` — a keep-alive
   socket retired between RPCs. It is patched here with a longer server timeout
   and one client retry, which is a plaster. The plan's requirement for a single
   multiplexed connection is not an optimization; it showed up as a correctness
   bug at trivial scale.

## S0.5 — the event stream vs the frontend we already have

The gate is not "pi emits events". It is: does every event `packages/sdk`
narrows and classifies have a pi source, and does pi's output survive the SDK's
**own** code unchanged?

```bash
bun test/proof-s05.ts   # 9/9
```

So the test asserts nothing by hand. It runs a real turn — text, a tool call, a
tool result, more text — through `src/chat-events.ts`, then through the shipped
`narrowChatEvent()` (`packages/sdk/src/core/stream/chat-events.ts`),
`classifyPart()` and `toolViewModel()` (`.../core/turns/`). If the frontend can
render it, those three accept it.

```
  PASS  every adapter event is accepted by the SDK narrowChatEvent()  — 20 events
  PASS  every part classifies to a known kind  — kinds: tool, text
  PASS  text arrives incrementally (streaming works)  — 4 text part updates
  PASS  tool lifecycle reaches a terminal state  — statuses seen: running -> done
  PASS  pi tool names drive the UI's per-tool rendering unchanged  — kinds: shell
  PASS  the completed shell view-model carries command AND stdout
                                            — command="echo hi" stdout="hi"
  PASS  session goes running -> idle
9/9
```

### Coverage of the whole chat surface

| consumer | source | status |
|---|---|---|
| `message.updated` | pi `message_start` / `message_end` | adapter |
| `message.part.updated` | pi `message_update` + `tool_execution_*` | adapter |
| `session.status` | pi `agent_start` / `agent_end` | adapter |
| `session.idle` | pi `agent_end` | adapter |
| `session.error` | `message_end` with `stopReason: 'error'` | adapter |
| `permission.asked` / `.replied` | pi `Agent.beforeToolCall` hook | hook to write |
| `question.asked` / `.answered` | a Kortix `ask_question` tool | tool to write |
| `todo.updated` | a Kortix todo tool | tool to write |
| `connection`, `heartbeat-gap` | SSE transport, never the harness | already ours |
| `message.removed`, `message.part.removed` | **no Agent-layer deletion** | **gap** |

### The one real gap

`message.removed` and `message.part.removed` have no Agent-layer source. Kortix
uses them for revert and compaction. pi's `Session` tree does have branching
(`navigateTree`, `branch`), so the capability exists — it just is not wired to
`Agent`, because the thing that would wire it is `AgentHarness`, and that is
unimplemented in 0.84.3. Scope it as frontend-visible work in Phase 1 or accept
that revert lands later.

### Two findings, one of them a correction

1. **pi's builtin tool names are already the UI's names.** `bash`, `read`,
   `write`, `edit`, `grep`, `glob` are exactly what `toolViewModel()` switches
   on, so shell / file-read / file-write / file-edit / search rendering works
   with **no remapping layer**. That is a larger piece of luck than it looks:
   per-tool rendering is where a harness swap usually costs a frontend rewrite.

2. **A correction to an earlier entry in this file.** I recorded that
   `Agent.subscribe` emits no text deltas and that streaming would have to tap
   the pi-ai layer. That was wrong. `AgentEvent` includes `message_update`,
   carrying both the accumulating message and the raw `assistantMessageEvent`;
   a 30-word answer produces 21 of them (`text_start`, 19x `text_delta`,
   `text_end`). Measuring it is what caught it. Streaming works straight off
   Agent events.

---

## Gate G0 — the RPC tax

Runs **after** Phase 0 and **before** P1.1. Phase 0 answers "can this be
built"; G0 answers "should it be", and it is the only thing that can still kill
the design once Phase 0 passes.

```bash
bun bench/rpc-tax.ts              # on Daytona, through the provider edge
bun bench/rpc-tax.ts --local      # loopback floor
```

| verdict | p50/call | 200-call turn |
|---|---|---|
| pass | ≤ 10 ms | ≤ 2 s |
| warn | ≤ 25 ms | ≤ 5 s |
| fail | > 25 ms | > 5 s |

### Result: WARN

| transport | p50 | p95 | per 200-call turn |
|---|---|---|---|
| `fetch` per call | 20.3 ms | 26.8 ms | 4.1 s |
| pooled keep-alive | 19.2 ms | 23.9 ms | 3.8 s |
| multiplexed WebSocket | **16.0 ms** | 17.9 ms | **3.2 s** |

Two conclusions, and the second matters more:

1. **Transport is worth 21%, not an order of magnitude.** A multiplexed socket
   beats naive per-call `fetch` by 4 ms. Take it anyway — per-call HTTP already
   produced a *correctness* bug in this spike when a keep-alive socket was
   retired between calls — but it is not the lever.
2. **The tax is set by the provider's topology, not by us.** Both sandboxes sit
   in one Daytona region, yet traffic leaves through the public edge because
   Daytona isolates sandboxes from each other. The lever is **co-location**, and
   that is a provider-selection criterion the plan did not previously have.

Sensitivity — 5 calls costs 0.08 s, 30 costs 0.5 s, 100 costs 1.6 s, 200 costs
3.2 s. Against boot savings of 1.3 s (create) and 2.8 s (archived resume), the
split wins clearly up to ~100 tool calls per turn and is roughly break-even
beyond. Most sessions are nowhere near that; large refactors are.

One correction: the 67 ms figure reported earlier was a whole `/prompt`
round trip including harness work, not a raw RPC. The raw RPC is 16–20 ms.

---

## Cold time-to-first-token — the number that isolates the architecture

Total task time buries the signal: ~8 of ~11 seconds are the model thinking,
which is identical on both sides. This measures only the part the split can
move — **cold create to the agent's first token**.

```bash
bun bench/ttft-cold.ts --runs=3
```

Both arms cold, same model, same provider, same region. Each is timed in two
sequential segments: `create` on the host's clock, then a measurer running
*inside* the sandbox that waits for readiness, sends the prompt, and stops at
the first streamed token. The exec that starts that measurer is charged to both
arms identically.

### Result — 3 runs

| | create | ready | **first token** |
|---|---|---|---|
| today — one 6.2 GB box | 992 ms | 2440 ms | **4999 ms** |
| worker | 1308 ms | 1319 ms | **3037 ms** |

**1.65x — the agent starts speaking 1.96 s sooner.** Across all four runs taken
the range was 1.7–2.3x (2.0–3.7 s sooner).

### Where the gap comes from

| | boot to ready | ready → first token |
|---|---|---|
| today | 2440 ms | 2559 ms |
| worker | 1319 ms | 1718 ms |

Two roughly equal halves, and only one of them is about image size:

- **~1.1 s of boot** — the 6.2 GB restore versus 140 MB.
- **~0.8 s of pre-model work** — after `runtimeReady:true`, today's box still
  creates a session and loads plugins before the first model call goes out (the
  live capture shows a `plugin.added` flood at 2075 ms). The worker has a
  bundled agent already in memory and calls the model immediately.

The second half is the more durable win: it does not depend on the provider,
the image, or how warm anything is.

### Two measurement traps, both hit

1. **The naive "first event containing text" detector is wrong for opencode.**
   It echoes the USER message over the same stream the moment the prompt is
   accepted — user text at 1975 ms, assistant announced at 2013 ms, its first
   real token later still. Detecting that as the first token undercounted the
   old arm by seconds and briefly made it look *faster*. The fix latches the
   assistant message id and only counts parts belonging to it. The same class
   of bug existed on the worker side (agent events carry the accumulating
   message, so a loose check matched the user's own text and reported a first
   token 35 ms after ready — before any model call could have returned).
2. **Three layers of escaping ate a `\n`** and turned the old arm's measurer
   into a SyntaxError, which read as "the old architecture produced no
   measurement". Both measurers are now real files in `bench/measure/`,
   uploaded verbatim.

---

## One task, both architectures, from cold

Every other benchmark here measures a piece — boot, resume, per-call RPC. This
measures what a user experiences: they ask for something that needs real
compute, and they wait until it is done.

```bash
bun bench/task-e2e.ts --runs=3
```

Task: *create a file in the workspace, read it back, report its contents.* Same
model, same provider (OpenRouter), both arms. Clock starts at "create the
sandbox" and stops when the answer is in hand.

Today's approach is ONE box that is both harness and compute; the new approach
is TWO. Counting only the worker would flatter it, so the new arm is measured
twice — with the environment cold (worst case, first-ever session) and warm
(the pooled steady state the plan designs for).

### Result — 3 runs

| | create | ready | **answered** |
|---|---|---|---|
| today — one 6.2 GB box | 1781 ms | 3423 ms | **11745 ms** |
| worker + cold environment | 2694 ms | 2924 ms | **11311 ms** |
| worker + warm environment | 1621 ms | 1785 ms | **9758 ms** |

**0.4 s faster cold, 2.0 s faster warm — on an ~11 s task.** That is 3–17%,
not the 1.9x the infrastructure numbers suggest.

### Why, and what it means

About 8 of those 11 seconds are the model thinking, and the split does not
touch that. The infrastructure half genuinely is ~1.9x better (1785 ms vs
3423 ms to ready), but it is the minority of what the user waits for on a task
like this.

So the case for the split does not rest on total task time. It rests on:

- **Time to first token**, which is what a user feels first: 1.45 s vs 2.72 s
  measured earlier. The answer starts arriving sooner even when it finishes at
  a similar moment.
- **The tail.** Today's box ranged 2.3–22.7 s to ready across runs; the worker
  stayed inside 1.16–2.08 s.
- **Sessions that never touch compute**, which under the split never provision
  the fat box at all — the entire 6.2 GB cost disappears rather than shrinking.
- **Decoupling** harness upgrades from image turnover.

And against it: the RPC tax, which grows with tool calls while all of the above
are fixed wins.

One caveat in the numbers above: the two arms produced different-length answers
(*"The file says kortix."* versus a fuller sentence), so a few hundred
milliseconds of the gap is output tokens, not architecture. The `ready` column
is the clean infrastructure comparison; `answered` is the honest user-facing
one with that noise included.

---

## kx — a terminal for the worker

No UI, no browser, no Kortix API. Brings up store, environment and worker in one
process and gives you a prompt.

```bash
pnpm kx                      # or: bun bin/kx.ts
bun bin/kx.ts --faux         # no credentials needed
bun bin/kx.ts --session my-work   # resume a previous conversation
bun bin/kx.ts --transport=ws      # pick the RPC transport
```

It is also scriptable — piped input runs as a script, which is how the smoke
test drives it:

```
$ printf 'Create /workspace/hello.txt containing exactly the word kortix, then read it back.\n/env\n/rpc\n' | bun bin/kx.ts

› Create /workspace/hello.txt containing exactly the word kortix, then read it back.
  I'll create the file with "kortix" and then read it back.
  ⚙ write  /workspace/hello.txt  ✓ 9ms
  ⚙ read   /workspace/hello.txt  ✓ 5ms
  The file `/workspace/hello.txt` contains exactly the word "kortix".
  7316ms
› /env
  hello.txt  6b
› /rpc
  8 RPCs to the environment: {"absolutePath":3,"canonicalPath":1,"writeFile":1,
                              "exists":1,"readBinaryFile":1,"listDir":1}
```

Commands: `/tools` (and where they execute) · `/history` · `/transcript` (reads
the durable store directly, no worker involved) · `/env` · `/rpc` · `/stats` ·
`/quit`.

The per-tool timings and the RPC counter are there on purpose: they make the
architecture's one real cost visible while you use it, rather than only in a
benchmark.

---

## Still open in Phase 0

- **S0.4** — a custom session store read back with no Pi process running. The
  interfaces exist (`SessionStorage`, `SessionRepo`, `InMemorySessionRepo`,
  `JsonlSessionRepo` with an injectable filesystem); not yet exercised.
- ~~**S0.5**~~ — done, see below.
- **S0.2 end-to-end** — a real turn through the deployed Kortix gateway with
  attribution visible in its log. The wiring is in `src/worker.ts`; it needs a
  key and a gateway URL to run.
