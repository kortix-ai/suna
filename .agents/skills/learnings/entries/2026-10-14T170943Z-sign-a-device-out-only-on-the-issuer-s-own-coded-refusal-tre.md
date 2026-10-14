---
recorded: 2026-10-14T17:09:43Z
incident_date: 2026-10-14
---
# Sign a device out only on the issuer's own coded refusal; treat every other 401/403 as transient

**Rule:** A client that holds a long-lived credential (a device token, a refresh
token) gives it up only when the issuer answers with its own refusal code
(Capture: 401 `capture_device_unauthorized`). Any other 401/403 (a proxy, a
firewall, a load balancer, a state like `capture_disabled`) is transient: keep the
credential and retry with backoff. Even after a real refusal, keep asking on a
slow timer (Capture: every 15 min and at every process start) so a restored
device reconnects without a person.

**Trigger surface:** writing the error classification of any background client
that authenticates on its own: Kortix Capture's sync (`apps/capture/src/memory/sync/issuer.rs`),
the desktop app, kortixd, the CLI's stored hosts.

**Incident:** 2026-10-14, branch `capture-platform` before its first release
(near-miss). `issuer_error` mapped every 401/403 from `POST /v1/capture/credentials`
to `Auth`, and the first one latched `rejected_at_ms` for good: one 403 from
anything in between, or an organization switching Capture off and on, would have
left every rolled-out computer disconnected until someone signed it in by hand.
Fixed in `1d16fb88a3`.

**Enforcement:** `issuer_errors_have_classes` (unit, `issuer.rs`) asserts a plain
401/403 and `capture_disabled` are `Transient`; `issuer_device_grant_credentials_refresh_and_revocation`
(`apps/capture/tests/sync_s3.rs`) revokes a device, restores it, and asserts it
reconnects with no new sign-in.
