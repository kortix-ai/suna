---
recorded: 2026-08-21T22:05:46Z
commit: 55b535cda9
---
# A limit larger than the thing it protects is not a limit — and a rendered file is not a deploy

2026-08-21. The dev API was OOM-killed three times in eleven minutes (`exit 137`,
"OutOfMemoryError: container killed due to memory usage") during an image-heavy
agent session. Cloudflare answered the dead origin with its own page, so the
product showed **"Bad Gateway · Retrying in 53s"** and everyone — including me —
went looking for a code regression in the LLM gateway. There wasn't one.

**Diagnosis, in the order that worked.** `/v1/health` was failing 10–40% with
`server: cloudflare` and NO `x-kortix-*` or `x-amzn-*` header, so the response
never came from our code. That route runs no database query and no gateway
logic, which eliminated every application-level suspect at once. ECS then named
it outright: `exit 137`, three times.

**The metric that proved it was provisioning, not a regression.** Daily maximum
memory held a 65–70% band for ten consecutive days and broke it only that day
(85.5%) — while the AVERAGE stayed at ~37%, unchanged all month. *Peak without
drift is a few large allocations, never a leak and never load growth.* Learn to
read that pair; it is the whole diagnosis in two numbers.

**Three compounding causes, each its own rule.**

1. **A ceiling above the container is decoration.** `DEFAULT_MAX_REQUEST_BYTES`
   was 1 GiB inside a 1024 MiB task and a 640 MiB self-host container — a single
   *permitted* request could exceed all the memory there was. A request-size cap
   is only meaningful as a FRACTION of process memory.

2. **Bounding one request is not bounding memory.** Per-request caps with
   unbounded concurrency still OOM; the crash just arrives later. Memory must be
   `O(concurrency)`, because concurrency is the only term a scaling policy
   controls. Shed with `503 + Retry-After` — a refusal costs one request, an OOM
   costs every request in flight plus the container. And a 503 is a pressure
   signal the autoscaler can SEE; an OOM looks like a task that stopped existing.

3. **Autoscaling on averages cannot see a single-task peak.** All three policies
   (average memory 70%, average CPU 60%, requests/target 600) sat idle through
   all three kills: the mean never moved, and requests peaked at 461 of 600.
   Alarm on `MemoryUtilization / Maximum`, never only `Average`.

**A rendered file is not a deploy.** A self-host `docker-compose.yml` is written
ONCE. `kortix self-host update` re-renders it, but the background
`kortix-updater` container only pulls images — so a box kept current by the
updater freezes its memory limits at the original render. Measured: a box
rendered while `llm-gateway` was a literal `512m` still had 512m months later,
straight through the update that raised the default to 2048m. **The fix shipped
and could not land.** `kortix-api` escaped only because it happened to be
`${KORTIX_API_MEMORY_LIMIT:-640m}` and could be moved from `.env`.

**The rule that follows: derive limits from reality, don't write them down.**
The process now reads its own cgroup limit at boot and takes a fraction. A stale
render becomes harmless, and more container memory becomes more throughput with
nothing to re-render.

**Corollary — parity is a safety property.** Dev ran `task_memory 1024` while
prod and staging ran `4096`, unchanged since at least Aug 15. Dev was the only
place this could surface first, and it surfaced in a founder's live session.

*Incident:* dev + one self-host box; no production impact (prod predated the
change). Fixed by #6705 (ceilings), #6708 (bounded memory + admission control),
#6712 (self-sizing). Verification that settles it: drive 60 concurrent 8 MiB
bodies at the REAL mounted routes and assert most are shed, every response is a
real status, no `unhandledRejection`/`uncaughtException`, and the process still
serves afterwards with the budget released.
