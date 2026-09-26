---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-05
commit: 3caec60726
---
# The queue row must carry every field a bubble draws, INCLUDING per-file upload state

**When:** a durable row stands in for an optimistic bubble across a reload or a
warm-box handover. The prompt row exposed `text` + `attachments` names but not a
usable upload STATE, and three client sites derived "failed" from `last_error`
alone. The API writes `last_error` on rows it keeps `queued` and RETRIES and
never clears it on success, so a transient `runtime_unreachable` retry rendered
as "upload failed". **The rule:** derive failure from `state === 'failed'`,
never from the presence of `last_error`; a queued row with an error is
retrying, not failed. Also: a refused landing proof must re-send under a FRESH
attempt (fresh `Idempotency-Key` + wire id via `withNextDeliveryAttempt`),
never `return false` into `deliverWithRetry` — the proxy's 10-minute dedupe
claim answers the same-key retry `duplicate`, which closes the row as delivered
(the exact silent loss the proof exists to stop). *Enforcer:*
`queue-projection.test.ts` (stale-error row still uploading), the two
"never wrote" cases in `queued-continue-inbox-delivery.test.ts` (fresh-key
requeue + dead-letter), `user-message.test.tsx` (pending tiles without doubling).
These seven defects were found by an adversarial multi-agent review of the first
fix set — review your own fixes before shipping.
