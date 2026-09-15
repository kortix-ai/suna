# Pi and OpenCode in the same environment

Measured on 2026-09-07. Pi starts its process sooner. These measurements do not
show a general improvement in warm response latency.

Both runtimes ran in one disposable Daytona environment with 2 CPUs and 4 GiB of
memory. The session's separate Pi worker was stopped at the provider during each
direct run. It was started again afterward. The browser then rendered a normal
worker response incrementally through one SSE connection.

## Results

Two runs each contain five samples per runtime and scenario. All 60 samples
passed. Each runtime also completed one excluded warmup per run. Samples execute
serially. The first runtime alternates between rounds.

The table combines both runs. Each cell is the median of ten samples.

| Scenario | Pi first text | OpenCode first text | Pi completed | OpenCode completed |
|---|---:|---:|---:|---:|
| Short answer | 1,134 ms | 1,137 ms | 1,337 ms | 1,326 ms |
| Streamed explanation | 1,170 ms | 1,081 ms | 4,247 ms | 4,596 ms |
| Shell command and answer | 2,793 ms | 2,737 ms | 3,002 ms | 2,972 ms |

A separate process-start probe contains five starts per runtime. Its median
readiness time is **104 ms for Pi** and **1,352 ms for OpenCode**. This measures
process launch through HTTP health readiness in an existing environment. It
does not include VM provisioning, repository checkout, or the first model call.
The filesystem and installed dependencies remain warm between starts.

The first run's tool completion medians were 2,999 ms for Pi and 3,148 ms for
OpenCode. The second run's medians were 3,662 ms and 2,889 ms respectively. Keep
both runs when comparing results; selecting either one would misrepresent the
observed variability.

## What this comparison controls

- Pi 0.84.3 and OpenCode 1.18.23 run in the same environment. The benchmark
  runner and Pi use Node 22.23.1; OpenCode uses its installed executable.
- Both use `gpt-5.6-luna`, the same account credential, and the same Kortix gateway.
- Every sample starts a fresh conversation with the same user prompt.
- Both receive the same system instruction and six workspace tool names.
- Pi binds the production workspace tools to `NodeExecutionEnv`. File and shell
  operations execute locally. No worker or environment RPC participates.
- Both expose HTTP messages and global SSE. The first text measurement excludes
  user echoes, reasoning, and unrelated assistant messages.
- The streamed case must emit more than one text delta. The shell case must
  expose a completed tool result and a matching file read-back.
- The final run removes the proof file before each shell sample. The preliminary
  run performs the same read-back but does not remove the previous proof first.

## Limits

The Pi process is a benchmark harness built from the production event adapter,
production workspace tools, and pinned Pi libraries. It is not a deployment of
the full Kortix session worker. It writes messages to local JSONL with `fsync`;
OpenCode uses its native SQLite storage. The startup result cannot stand in for
full product startup with every parity feature enabled.

OpenCode adds runtime instructions and uses different tool schemas. The actual
input token counts and cache behavior differ. Response lengths also vary in the
explanation case. The JSON records output, token usage, first text, completion,
tool result, session creation, and incremental event counts for each sample.

These are small samples from one environment and model. They do not establish
p95 latency, cold VM latency, or the cost of the split worker architecture.
Use `ttft-session.ts` for product session creation and external SSE timing.

## Reproduce

Use Node 22 and the pinned dependencies from `apps/kortix-worker`. The spike is
outside the pnpm workspace. When it has no `node_modules`, link the worker's
installed dependencies into `spikes/pi-worker/node_modules`.

```sh
bun test spikes/pi-worker/bench/direct-environment.test.ts spikes/pi-worker/bench/ttft-session-protocol.test.ts
bun build spikes/pi-worker/bench/direct-environment.ts --target=node --format=esm --outfile /tmp/direct-environment.mjs
```

Copy that bundle into an owned Linux environment containing OpenCode 1.18.23.
Pass its existing session credential through `KORTIX_TOKEN`. Do not put the
credential in a command argument or tracked file. Set these non-secret values:

```sh
export KORTIX_BENCH_DIR=/tmp/kortix-direct-benchmark
export KORTIX_BENCH_GATEWAY=https://pi.kortix.com/v1/llm
export KORTIX_BENCH_MODEL=gpt-5.6-luna
export KORTIX_BENCH_ROUNDS=5
node /tmp/direct-environment.mjs
```

The runner uses loopback ports 18081 and 18082 and closes both child processes.
Use a different output directory with `--startup-only` for the readiness probe.
Stop only the owned test worker. Restore it in a `finally` cleanup and verify a
normal worker session afterward.

Raw evidence: [preliminary run](results/2026-09-07/direct-preliminary.json),
[final run](results/2026-09-07/direct-final.json), and
[process startup](results/2026-09-07/direct-startup.json). The final run records
the executed bundle's SHA-256 and the repository base SHA.
