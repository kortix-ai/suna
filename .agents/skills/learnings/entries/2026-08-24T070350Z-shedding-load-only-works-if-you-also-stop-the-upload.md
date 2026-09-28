---
recorded: 2026-08-24T07:03:50Z
commit: aaeec6b3ee
---
# Shedding load only works if you also stop the upload

2026-08-24, found by stress-testing the gateway in its real container. Three
separate defects, each of which alone breaks the "never OOM, never 502"
promise, and none of which unit tests could see:

1. **A refused request keeps arriving.** Admission correctly returned 503 for
   60 concurrent 27 MiB uploads and the 2 GiB container was OOM-killed anyway:
   ~1.3 GB of refused body was still buffered on the way in. A rejection must
   `cancel()` the request body, not just answer.
2. **A client that vanishes mid-upload strands its reservation.** Bun never
   settles a pending `reader.read()` on abort, so the read awaited forever
   holding the lease. One aborted 2.8 MB upload leaked 8,521,827 reserved
   bytes permanently; enough of them and an idle process 503s everything.
   Cancel the reader from an `abort` listener.
3. **An amplification constant measured on ONE request is wrong.** Isolated, a
   27 MiB request peaks at 2.3x. Under concurrency the transients overlap and
   GC lags, and 3x OOMs. The default is now 6x.

**The rule.** Test admission control with a real container under a real memory
limit and hostile clients — overload, abort storms, slow consumers. A unit test
that asserts "returns 503" proves nothing about survival: all three defects
above passed every unit test in the suite. Assert the process afterwards:
`OOMKilled=false`, `RestartCount=0`, and the admission counter back at zero.

*Evidence:* 1074/1074 200s at 12 rps mixed (p99 0.32s, peak 322 MiB/2048, no
leak); the 60x27 MiB overload that killed the container now peaks at 827 MiB
and stays healthy. Enforcement: `read-bounded-body.test.ts` abort cases,
`memory-envelope.test.ts` backpressure case.
