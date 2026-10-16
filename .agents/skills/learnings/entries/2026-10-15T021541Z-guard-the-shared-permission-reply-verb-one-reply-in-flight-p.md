---
recorded: 2026-10-15T02:15:41Z
incident_date: 2026-10-12
---
# Guard the shared permission-reply verb: one reply in flight per request id, and answer the runtime's already-answered 404 as success

**Rule:** Every permission reply affordance in a web host (the composer prompt, the tool-part inline card, "allow everything for this session", the auto-approve backstop, `allowInConfig`) funnels into one SDK verb, `replyToPermission`. Guard that verb where all callers meet: keep one reply in flight per permission request id (a second caller joins the first promise) and resolve — do not throw — when the runtime answers `404` with `permission request not found` in the body (a case-insensitive match on status AND phrase; a bare 404 must still throw). A caller must never see an unhandled rejection from an already-answered permission, and must never send a second POST for the same request id.

**Trigger surface:** A double reply for one permission request id: two affordances clickable while the card is pending (composer card and tool-part card), an affordance that does not disable on click, `allowAllForSession` racing a manual reply, or a stale reply arriving after the runtime already resolved the request. Any of these turns the losing call into `Error: Permission request not found: per_<id>`, which pages as an unhandled promise rejection (`auto.browser.global_handlers.onunhandledrejection`) when the caller ignores the promise.

**Incident:** 2026-10-12, two occurrences in prod (Better Stack group "Error: Permission request not found: per_<id>"). Sentry events show two POSTs to the same `/permission/{id}/reply` within ~1.6 s: the first `200`, the second `404`, and the second surfaced as an unhandled rejection. Root cause: `replyToPermission` had no per-id guard and threw the runtime's 404 on every caller path; the web composer's fire-and-forget reply callback dropped the promise, so the loss became a page instead of a no-op.

**Enforcement:** `packages/sdk/src/react/use-opencode-sessions/permissions.ts` keeps `repliesInFlight` (one promise per request id) and `permissionAlreadyAnswered` (typed 404 check); `packages/sdk/src/react/use-session.test.ts` pins the resolve-on-404, the not-matching-404-still-throws negative control, the concurrent join and the cleared in-flight entry. A future web affordance that calls the react `answerPermission`/`replyToPermission` wrappers inherits both guards; bypassing the SDK verb (talking to `client.permission.reply` directly) re-opens this class — don't.
