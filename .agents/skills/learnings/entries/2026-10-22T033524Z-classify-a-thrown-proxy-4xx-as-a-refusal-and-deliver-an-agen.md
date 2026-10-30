---
recorded: 2026-10-22T03:35:24Z
incident_date: 2026-10-21
---
# Classify a thrown proxy 4xx as a refusal, and deliver an agent's reminder as someone who can open its session

**Rule:** A server-side delivery runs as a principal that passes the session-visibility gate. For a reminder with no `promptAuthorUserId`, that is the session's creator while they are a member, never the account owner by default. A catch around `forwardToSandbox` treats a thrown `HTTPException` 4xx as the proxy's refusal (`PromptDeliveryRefused`), never as `unreachable`. `unreachable` means only a 502/503/504 or a network failure.

**Trigger surface:** Choosing the actor of a trigger, reminder or other automated prompt. Writing a `catch` around `forwardToSandbox` or any proxy call whose gates throw (`assertPreviewSandboxAccess`, `refuseSessionOrControlAccess`).

**Incident:** 2026-10-21 and 2026-10-22, dev. An agent set a daily reminder on an admin's private session. Each fire was delivered as the account owner. The proxy threw 403 `Not authorized to access this session`, `postPrompt` caught it as `unreachable`, and the prompt waited out the runtime-down ladder (30 s / 2 min / 8 min). It dead-lettered as "the session's machine could not be reached after 3 attempts" while the box was up and idle. Both daily fires were lost. The successor path (`fireReminderSuccessor`) had the same owner fallback.

**Enforcement:** `apps/api/src/projects/session-lifecycle/runtime-client-turn-verbs.test.ts` (a thrown 403 is `PromptDeliveryRefused`; a thrown 503 or a network error stays `unreachable`). `apps/api/src/__tests__/integration-session-reminders.test.ts` (an agent's reminder on a member's session queues as the creator; a creator who left falls back to the owner). Flow `REM-6` (an agent's reminder on an admin's private session reaches the transcript on a real box).
