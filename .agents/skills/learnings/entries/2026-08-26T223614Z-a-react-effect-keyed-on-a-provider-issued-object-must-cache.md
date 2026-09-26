---
recorded: 2026-08-26T22:36:14Z
incident_date: 2026-08-26
commit: 248ebd2b9d
---
# A React effect keyed on a provider-issued object must cache its work by id, never bail — and only the deployed page proves it

**When:** an effect does one-shot async work (a consent read + approve, an
exchange, anything consumed server-side) and its deps include an object the
auth/data provider re-issues (`user`, `session`). The re-run cancels run #1
via cleanup; a "started already" guard then makes run #2 bail, and the page
holds its loading state forever. Cache the PROMISE per id and let whichever
run is current apply it; a redirect after a consumed request fires
unconditionally.
*Incident:* Sign in with Kortix consent page (#6945) spun forever on
dev.kortix.com for a fresh client while `/v1/oauth/authorize/consent/:id`
answered 200; local Chromium never re-issued `user` in that window, so the
local run passed. Fixed in #6949 the same evening; dev only.
*Enforcer:* none — the rule is: drive the deployed page for any auth flow.
