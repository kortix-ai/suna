---
recorded: 2026-09-27T19:03:01Z
incident_date: 2026-09-16
---
# Page an OpenCode transcript with before, and prove a full walk reaches the head against a real runtime

**Rule:** Ask OpenCode for the next page of `/session/:id/message` with `before=<x-next-cursor>` (`transcriptPageUrl`). OpenCode ignores `cursor=` and answers page one again with the same cursor. A pager tested only against fakes or the pi runtime (which reads both spellings) cannot see this: prove a full walk against a real OpenCode runtime.

**Trigger surface:** Changing `session-transcript-capture.ts`, `session-transcript-pages.ts`, or any server-side reader that pages a sandbox transcript.

**Incident:** Since the full-history capture shipped (`886afa4016`, 2026-09-16), the capture sent `cursor=`. On OpenCode sandboxes every full walk stopped after the newest 80 messages as "not advancing": no flagged session longer than 80 messages ever proved its head, so rewinds were never deleted, wake backfills saved only the newest 80, and stripped rows older than that could never be re-captured. Found on 2026-09-27 by a read-only dry run against a dev sandbox: `cursor=` returned the same 10 rows, `before=` the 4 older ones. Fixed in PR #7853.

**Enforcement:** `apps/api/src/projects/lib/session-transcript-pages.test.ts` ("the next page is asked for by `before`, the spelling OpenCode reads"). The real-runtime proof is manual: none yet for CI, because no CI lane runs an OpenCode sandbox.
