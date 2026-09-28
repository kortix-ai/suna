---
recorded: 2026-09-05T17:23:19Z
incident_date: 2026-09-05
commit: 3cfcc3be99
---
# A failed content-addressed template must change the next create idempotency key

PR #7109 could not deploy its branch preview. Platinum returned two failed
records for `kortix-ci-v11-03a0eb30070ddb14-base`. The controller correctly
rejected both records as reusable, but retried `POST /v1/templates/from-spec`
with the original idempotency key. Platinum returned the same failed create
result. The branch environment could not fall back to Daytona because that
would change its stable origin.

**The rule.** A content-addressed resource can reuse its normal idempotency key
until the provider records a terminal failure. The next create key must include
a deterministic fingerprint of the known failed resource IDs. Concurrent
retries for the same failure set still deduplicate. A newly failed retry changes
the failure set and therefore changes the next create key.

*Fix:* `platinumTemplateCreateIdempotencyKey()` fingerprints failed template
IDs for base and warm template creation. *Enforcer:*
`tests/unit/platinum-ci.test.ts` verifies stable concurrent retry keys and a new
key after another terminal failure.
