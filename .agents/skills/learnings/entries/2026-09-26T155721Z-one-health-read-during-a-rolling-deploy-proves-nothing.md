---
recorded: 2026-09-26T15:57:21Z
incident_date: 2026-09-02
---
# One health read during a rolling deploy proves nothing

**Rule:** never gate a promote, verification, or "is it deployed?" decision on
a single HTTP health response. ECS rolls tasks gradually behind one load
balancer, so old and new code answer the same URL concurrently for a window.
Require the deploy run to be `completed/success` AND N consecutive reads
(≥8) agreeing on the expected SHA before treating a rollout as settled. The
same shape applies to browser assertions: a redirect chain commits only its
FINAL URL, so `framenavigated` cannot see an intermediate hop — observe
navigation REQUESTS instead. Any negative assertion ("it did NOT redirect")
needs a positive control arm proving the mechanism fires at all, or it can
pass against dead code.

**Trigger surface:** any promote gate, deploy verification script, or browser
journey that reads a health endpoint or navigation event once and treats it as
final.

**Incident:** v0.13.10 release, 2026-09-02: 10 consecutive `/v1/health` reads
during a rolling staging deploy returned `8d5cf2ac, 8d5cf2ac, 8d5cf2ac,
3693c556, 3693c556, 3693c556, 3693c556, 3693c556, 3693c556, 8d5cf2ac`. A
single read had already fired a promote gate that then had to be revoked.
Caught pre-promote; no outage.

**Enforcement:** none automated — the ≥8-consecutive-reads rule is manual
practice; a shared helper enforcing it in the release/verification tooling is
the TODO.
