---
recorded: 2026-10-23T14:18:50Z
incident_date: 2026-10-23
---
# Reserve a model's output budget when setting the pi compaction threshold

**Rule:** Set pi's compaction reserve to the model's own output limit, floored at pi's 16,384 default and capped at half the window. Never leave pi's default reserve in place for a model whose `limit.output` is larger: the request then enters the window with less room left than the answer may use.

**Trigger surface:** Any change to the pi compaction settings (`pi/model.ts` `compactionSettings`, `pi/extensions/host.ts` global settings), to a model's catalog limits (`limit.context`, `limit.output`), or to the context meter that reports usage against a window.

**Incident:** 2026-10-23, a prod pi session reported `136,589 / 128,000` (107%) and ended a turn with `{"name":"UnknownError","code":"output_length","data":{"message":""}}`. Two defects combined. The session log meter added `reasoning` on top of `output`, but `reasoning` is a subset of `output`, so the meter read ~25k tokens high. pi compacted at `window - 16,384` = 111,616 while the model's real output limit was 32,768, so a request at 111k had 16k of output room and the provider cut the reply. pi's own length recovery was the only guard, and a second length stop in one turn is final. Blast radius: every pi session on a model whose output limit exceeds 16,384.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-model-limits.test.ts` pins the reserve per model (`compactionSettings`); `pi-harness.test.ts` (`compaction leaves the model its whole output budget, not pi default 16k reserve`) pins that a 128k/32k model compacts at 100k through the daemon HTTP routes; `packages/ui/src/session/composer/context-ring.test.ts` and `session-context-metrics.test.ts` pin that `reasoning` is never counted twice.
