---
recorded: 2026-08-27T20:38:20Z
commit: 88fdecd13b
---
# A down box has TWO proxy responses; the SDK must treat BOTH as wakeable

Found 2026-08-27 on dev: clicking a session in the sidebar showed "Couldn't
load this conversation." with a Retry that never recovered. Root cause: when a
session's sandbox is down, the sandbox proxy answers a data read
(`/p/<box>/8000/kortix/opencode/messages/<sid>`) in one of two ways depending on
the box's status, and only one was handled:

- status `stopped` → **503 JSON** `sandbox not ready (status: stopped)` — the SDK
  classified this as `SandboxNotReadyError` (a waking state), kept the loader up,
  retried, and the box woke via the `/start` the app fires on open. Recovered.
- status `not-running` → **404 HTML** `This sandbox URL is not active. /
  not-running` — NOT matched by `SANDBOX_NOT_READY_PATTERNS`
  (`packages/sdk/src/core/http/opencode-errors.ts`), whose closest pattern was
  `sandbox is not running` (the literal word "is"). So `readSessionMessagePage`
  (`session-sync-registry.ts`) threw a HARD error →
  `transcriptFreshness='error'` → the dead-end "Couldn't load" with no wake, no
  retry.

The `own-the-surface` reads cutover (#6987) routed the transcript read through
this classifier, which is what exposed it — before, the same box-down 404 went
down a different read path.

**Rules.**
1. A sandbox that is stopped/parked/idle is a WAKEABLE state, never a terminal
   transcript failure. If a proxy can return more than one status/shape for
   "box is down" (503 JSON vs 404 HTML state page here), the classifier must
   accept EVERY one of them — enumerate them from the live wire, not from the
   one you happened to see.
2. Capture the real response BODY before writing the pattern. The fix strings
   (`sandbox url is not active`, `not-running`) came from a captured dev 404,
   not a guess — and they are specific enough to never match a genuine
   `{"message":"Not found"}` 404 (asserted by a test).
3. A control-plane status (`/start` said `ready`) can be stale against the data
   proxy's live view (`not-running`). Do not trust one as proof of the other;
   the read that actually failed is the truth.
4. Follow-up recorded, not yet done: the proxy should return the SAME 503 for
   `not-running` as it does for `stopped`, so there is one down-box response
   instead of two. Classifier breadth is the belt; proxy consistency is the
   suspenders.

*Automation:* `packages/sdk/src/browser/session-sync/session-sync-registry.test.ts`
pins that the `not-running` 404 throws `SandboxNotReadyError` while a genuine
404 stays a hard error; `opencode-errors.test.ts` guards the pattern set.

*Incident:* PR #6999 (`7060b2b2cc`), merged + dev-deployed 2026-08-27. TDD
fix, no code change beyond two regex patterns. No data loss — messages sent at a
dead composer were always durable inbox rows; only the transcript READ
dead-ended.
