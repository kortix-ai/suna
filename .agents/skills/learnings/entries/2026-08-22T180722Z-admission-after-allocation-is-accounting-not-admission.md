---
recorded: 2026-08-22T18:07:22Z
commit: 4fd71b3ad6
---
# Admission after allocation is accounting, not admission

2026-08-22. A 28.37 MB multimodal request repeatedly OOM-killed a 512 MiB
standalone gateway. The existing in-flight budget did not protect the process.
Both gateway hosts called `readBoundedBody()` before `InflightBudget.admit()`.
Concurrent requests therefore allocated complete JavaScript strings before the
budget could reject them. The hosts also released the lease when the handler
returned a streaming `Response`. Parsed request data could remain reachable
until the response stream ended.

**The rule.** Reserve declared bytes before the first body read. Grow a chunked
request's reservation before retaining each chunk. Hold the lease until response
EOF, error, or cancellation. A test that asserts only `503` counts does not prove
a memory bound. It must assert allocation order and lease lifetime.

**Remove amplification sources before raising memory.** The same request existed
as HTTP chunks, a JavaScript string, a parsed object, an AI SDK request graph, a
serialized provider payload, and trace capture. The gateway now clears the raw
string after parsing, uses direct `fetch` for OpenAI-compatible providers, loads
protocol translators lazily, retains no response body, and stores metadata-only
traces. A container memory increase can raise throughput. It cannot repair an
unbounded allocation path.

*Incident:* SampleCo standalone gateway, repeated cgroup OOM kills and Caddy
`502 Bad Gateway`. Enforcement: `readAdmittedBody` allocation-order tests,
response-lifetime lease tests, one-dispatch tests, and a mounted 28 MiB request
test that asserts one provider call and an intact response.
