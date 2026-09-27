---
recorded: 2026-09-27T05:38:34Z
incident_date: 2026-09-27
---
# A raw upstream SSE relay must check for a terminal marker before closing, and two independent fixes to the same relay must be read as a union, not a pick

**Rule:** Any code that relays an upstream byte stream toward a client (an
LLM-gateway SSE relay, a proxy, a translation layer) must (1) never forward a
partial `data:` line straight from a `read()` chunk — buffer by complete line
and drop an incomplete trailing fragment on termination; (2) track whether the
upstream reached a well-defined end (`[DONE]`, a populated `finish_reason`, or
an in-band `error` frame) and treat any other termination — clean EOF, a read
exception, or an inactivity timeout — as INCOMPLETE, not success; (3) for an
incomplete termination with zero bytes forwarded, retry transparently against
a fresh candidate (bounded, short backoff, prefer the next pooled key); (4)
once any byte has been forwarded, never retry — emit an explicit, well-formed
terminal frame (`error` + `[DONE]`) instead of closing silently.

Separately: before opening a PR that patches a hot, actively-worked file
(`streaming.ts`, `simple-handler.ts` in this package), `git fetch` and diff
`HEAD..origin/main` on that exact file. A worktree cut hours earlier can
already be stale against a same-day independent fix to the identical function.
Textual merge conflicts on the same lines are not a signal to pick a side —
read BOTH diffs' intent first. Two real, non-overlapping fixes had landed on
`packages/llm-gateway/src/pipeline/streaming.ts` in one day: #7679 repairs
SSE event boundaries between complete-but-unseparated `data:` lines (a
JOINING/framing bug) and unifies retry ladders into `pipeline/dispatch.ts`
(#7620) — neither detects or reacts to "the upstream stopped sending bytes
with no finish signal at all" (a SILENCE/truncation bug, this fix's subject).
`git merge origin/main` produced content conflicts in all three touched
source files plus both matching test files; resolving by rebuilding each file
from `origin/main`'s version and re-applying this fix's diff on top (rather
than fighting the 3-way diff noise) was faster and less error-prone than
hunk-by-hunk resolution.

**Two more traps found while integrating the union:**
- A retry-body clone captured for the WHOLE streaming response lifetime is an
  unbounded per-request memory cost, not a bounded one — cloning a 28 MB
  multimodal request body "just in case a retry is needed" held that clone
  alive for the entire completion (measured regression: baseline 0.6x → 4.2x
  of wire size in `memory-envelope.test.ts`). Bound it: clone fresh only below
  a size threshold and only when the request has no inline images.
- Pre-existing unit tests that assert framing-repair behavior in isolation
  (fixtures with no `finish_reason`/`[DONE]` at all, because they only cared
  about boundary repair) start failing once completion detection exists,
  because they now read as "incomplete" streams. Give the fixture a genuine
  completion signal (add `finish_reason` to the JSON payload) rather than
  weakening the new completion check — the fixture's ORIGINAL assertion
  (framing was repaired) still holds unchanged.
- A gateway-side memory GUARD RAIL (a single SSE line exceeding the buffer
  cap) is a different class of failure than "the upstream told us nothing" —
  it must keep rejecting the response body (the pre-existing contract), not
  get reframed as a well-formed retryable stream-incomplete error.

**Incident:** PR #7804 (`gw-stream-incomplete`, base commit `1cff82b25b`,
~2 days stale against `origin/main` by the time its preview CI ran). Preview
`Deploy full self-host preview and run end-to-end tests` job failed; a
coordinator review comparing the PR's 24 e2e failures against an independent
contemporaneous baseline run (a different, unrelated branch, same ~1 h window)
found 18 of 24 identical by flow ID (GitHub secondary rate limit on managed
repo creation, Platinum sandbox pool/boot-time congestion producing 180–600 s
zero-step or partial-step flow timeouts, and one unrelated warm-session-claim
409 race) — confirming none of the 24 were caused by the gateway change. The
`git merge origin/main` run immediately after that review is what surfaced
#7679/#7620 as already-landed, overlapping work.

**Enforcement:** `packages/llm-gateway/src/usage/sse-scanner.test.ts`
("terminal detection": `[DONE]`, `finish_reason`, in-band error, and a
truncated trailing line never flips terminal — merged alongside the
pre-existing "error frames retain upstream detail" suite from #7618/#7679);
`packages/llm-gateway/src/pipeline/streaming.test.ts` (retry-before-first-byte
is transparent; cut-after-first-byte forwards no partial line and emits the
terminal frame; bounded retry attempts; `[DONE]` appended after a doneless
error frame; the line-limit guard still rejects; all three #7679 framing
tests updated with a `finish_reason` and still green);
`packages/llm-gateway/src/pipeline/simple-handler.test.ts` (the same shapes
end-to-end through `handleChatCompletions`, the pool cooldown call, and that
an image-bearing body gets no transparent retry);
`packages/llm-gateway/src/pipeline/memory-envelope.test.ts` (pre-existing;
pins the streaming steady-state memory floor — this is what caught the
retry-body-clone regression above, twice, once before this merge and once
during it).
