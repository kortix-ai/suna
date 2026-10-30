---
recorded: 2026-10-20T07:19:45Z
incident_date: 2026-10-16
---
# Answer a live question before queueing a recovery turn

**Rule:** Try the runtime question reply endpoint before enqueueing a durable answer follow-up. A successful reply continues the existing turn; do not send a second prompt. Use the durable queue when the runtime has lost the question or cannot be reached.

**Trigger surface:** Answering a persisted session question from the dashboard or session question API.

**Incident:** KRTX-2544. A synthetic create-in-chat wizard remained on its question after the user answered. The durable answer route assumed every question came from a parked runtime and sent a new prompt rather than releasing the live blocking call.

**Enforcement:** `apps/api/src/projects/routes/turn-question-answer.test.ts` exercises the HTTP handler: live reply without another prompt, cold/unreachable fallback, repeated and concurrent submissions.
