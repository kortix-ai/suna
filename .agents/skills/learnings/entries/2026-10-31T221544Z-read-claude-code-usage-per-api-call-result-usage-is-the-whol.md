---
recorded: 2026-10-31T22:15:44Z
incident_date: 2026-10-31
---
# Read Claude Code usage per API call; result.usage is the whole turn's sum

**Rule:** A context size comes from ONE model call's input (`input + cache_read + cache_write` of its `message_start`/`message_delta`). Never fold Claude Code's `result.usage` into a step's context: it sums every call of the Claude turn, and in kortixd one Claude turn spans every pi step since the user's message, because tool calls park it.

**Trigger surface:** Converting a provider's usage into pi's `Usage` (`harness/pi/claude/stream.ts`), or any adapter whose turn spans several model calls.

**Incident:** 2026-10-31, #11283 to #11369. A dev session on Claude Opus 5.5 compacted at about 175k tokens of a 1M window: the last step of a 6-call turn reported 998k cache reads + 175k cache writes. Fixed in #11369.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-claude-agent.test.ts` ("the last step of a parked Claude turn reports its own call's context, not the turn's total").
