# Daytona report: intermittent ~21–22s `create → running` spikes (container class, target `us`)

**Reporter:** Kortix · **Org ID:** `febf2c2a-8287-4de2-bb6c-7362a188fa09`
**SDK:** `@daytonaio/sdk@0.192.0` · **API:** `https://app.daytona.io/api`
**Date:** 2026-06-28

## TL;DR

`daytona.create({ snapshot })` for a **container**-class sandbox in **target `us`**
intermittently takes **~21–22 seconds** to reach `running` instead of the normal
**~1.3s** — i.e. **~15–25× slower**. It is **bursty**: across separate runs we saw
**0%, ~10%, and 26%** spike rates. Spikes cluster tightly at **~21–22s** (a few
outliers to 25s and 37s), which looks like a **~20s internal timeout that then
succeeds on retry**. The **same workload on the `linux-vm` class in `us-west-2`
never spikes** (max 1.4s over 20 runs), which points at the container
runner-assignment / create path in `us` specifically.

## Environment & workload

- Snapshot: a trivial `image: "ubuntu:22.04"`, `sandboxClass: CONTAINER` snapshot
  (pre-built, reused — so this is **not** a build delay).
- Call: `await daytona.create({ snapshot }, { timeout: 120 })`, which resolves when
  the sandbox reaches `running`. We time that call. One create at a time,
  sequential, ~1.2s gap between iterations (no concurrency).
- Each created sandbox is deleted immediately after.

## Data — one run, N=50, target `us`, container

```
n=50  min=658ms  median=1431ms  max=37061ms
spikes(>=8000ms): 13/50 (26%)
```

Normal creates: **0.66–2.0s**. The 13 slow creates (with sandbox IDs + UTC
timestamps for log correlation):

| # | timestamp (UTC) | create→running | sandbox id |
|---|---|---|---|
| 1 | 2026-06-28T02:01:31.302Z | 21241ms | a2492db5-3a88-4831-81df-064052af8af2 |
| 2 | 2026-06-28T02:01:54.250Z | 22087ms | e0d8d056-6c3b-46a5-ad08-ba81e710bf48 |
| 10 | 2026-06-28T02:02:39.197Z | **37061ms** | 829d3826-0edf-4dbd-8d55-72a783897930 |
| 13 | 2026-06-28T02:03:26.265Z | 21600ms | dc4b0653-d7e5-4d3e-af14-1fa6b0b083cb |
| 15 | 2026-06-28T02:03:52.895Z | 21448ms | c1692b4e-5237-43e5-b571-5290424a8789 |
| 17 | 2026-06-28T02:04:22.784Z | 25122ms | 681ebe35-06e8-41bf-969b-c1d8834f8d51 |
| 18 | 2026-06-28T02:04:49.880Z | 21503ms | 6e5df2aa-b60d-4cbd-917d-a85d3eb5cc49 |
| 23 | 2026-06-28T02:05:28.059Z | 22121ms | 60c64b2c-0636-4280-b8c7-d8aa5d97bd0d |
| 27 | 2026-06-28T02:05:59.491Z | 22146ms | a5f0b127-2101-4555-8d10-e51181b8e695 |
| 29 | 2026-06-28T02:06:26.861Z | 22196ms | 0de3f816-a008-4722-a8b8-16c4b918e406 |
| 32 | 2026-06-28T02:06:56.544Z | 22242ms | e04c9df4-4c35-425c-8420-001f6a54753f |
| 43 | 2026-06-28T02:07:53.542Z | 10156ms | 60aa4906-626e-40ed-9d71-1c997e8388f2 |
| 48 | 2026-06-28T02:08:17.352Z | 22034ms | 2bc1545d-476b-481d-92e0-95598d0aa13e |

The strong clustering at **~21–22s** (ten of thirteen) is the key signal — it reads
like a fixed ~20s timeout on some create sub-step (runner assignment? image
resolve? scheduling?) that then retries and succeeds (~20s + the normal ~1.5s).

## Contrast — `linux-vm` (microVM) in `us-west-2` never spikes

Identical harness, `sandboxClass: LINUX_VM`, target `us-west-2`, N=20:

```
n=20  min=0.79s  median=1.1s  max=1.4s   spikes: 0
```

So the spike is specific to the **container path in `us`**, not our code or the
network (same machine, same SDK, same trivial snapshot).

## Minimal repro

```js
import { Daytona, SandboxClass } from '@daytonaio/sdk'; // 0.192.0
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, target: 'us' });
await d.snapshot.create({ name: 'spike-ubuntu', image: 'ubuntu:22.04', sandboxClass: SandboxClass.CONTAINER }).catch(() => {});
for (let i = 0; i < 50; i++) {
  const t = Date.now();
  const sb = await d.create({ snapshot: 'spike-ubuntu' }, { timeout: 120 });
  const ms = Date.now() - t;
  console.log(new Date().toISOString(), ms + 'ms', sb.id, ms >= 8000 ? 'SPIKE' : '');
  await d.delete(await d.get(sb.id), 30);
  await new Promise(r => setTimeout(r, 1200));
}
```

(Full version: `tests/performance/session-start/daytona-spike-repro.mjs`.)

## Impact on us

This is the dominant tail-latency source for new-session creation in our product —
a user creating a session randomly waits 20s+ instead of ~1s. We're working around
it by moving toward microVMs, but the container path in `us` is what most traffic
hits today.

## Asks for Daytona

1. With the sandbox IDs + timestamps above (org `febf2c2a-…`), can you trace where
   the ~20s goes inside the create path (state transitions: which sub-step stalls)?
2. Is there a ~20s timeout/retry on runner assignment / scheduling in `us` for the
   container class that this triggers?
3. Is the burstiness capacity/runner-pool related (it clusters in time)?
4. Anything we can pass on `create` to avoid it (region pin, runner hint, retry
   tuning)?
