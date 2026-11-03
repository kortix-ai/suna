# Sales event delivery

Apply the two `sales_event_*` migrations before rolling out the API/web change. No production migration, configuration or deployment was performed by this PR.

## Configuration

- `SIGNUP_WEBHOOK_URL`: the Sales builder's deployed Convex HTTP ingest endpoint (both signup and demo events use it).
- `SIGNUP_WEBHOOK_SECRET`: shared secret matching the receiver. Use secure environment/secret management; do not put it in the URL.
- `SALES_RECONCILIATION_TOKEN`: separate high-entropy bearer secret for the read-only reconciliation endpoint. Give this to the daily Sales reconciliation job, not browsers.
- Run the existing API leader-worker process; its registered `sales-outbox` job polls every 30 seconds. Without URL/secret it leaves events queued.

Each delivery has `X-Kortix-Timestamp` (Unix seconds) and `X-Kortix-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + '.' + exact raw request body)>`. Receiver must validate freshness and signature before JSON parsing, then deduplicate atomically by `event_id`. Transport is at-least-once: an HTTP success followed by a process crash intentionally redelivers the same event.

Envelope: `{schema_version:1,event_id,type,occurred_at,data}`. Signup ID is `account.signup:<auth user UUID>`, demo ID is `demo.requested:<contact_forms UUID>`. Signup timestamps come from auth creation and email confirmation, never dispatch time. Existing confirmed users are available through reconciliation; migrations do not bulk-backfill auth users. Careers submissions are persisted/notified but excluded from the Sales outbox.

## Daily reconciliation

`GET /v1/system/confirmed-signups?from=<ISO>&to=<ISO>&cursor=<opaque>` with `Authorization: Bearer <SALES_RECONCILIATION_TOKEN>`. Range is confirmation time `[from,to)`, not creation time. First request may omit `to`; reuse returned `upper_watermark` as `to` on every subsequent request. Reuse unchanged `from` and `to` with `next_cursor` until it is null. Pages hold at most 100 events and break timestamp ties by user UUID. Ingest with the same event-ID deduplication as live delivery; overlap daily windows to tolerate concurrent transactions.

## Operations and rollback

`kortix.sales_event_outbox` stores immutable payloads and mutable delivery receipts. Failures retry exponentially from 30 seconds to a one-day cap, dead-lettering at 20 attempts. `last_error` contains only HTTP status or a generic network error, never receiver bodies. Alert on nonempty dead letters and overdue pending rows using existing DB monitoring. An authorized operator may replay a reviewed dead letter by clearing `dead_letter_at`, resetting `attempts=0` and setting `available_at=now()`; retain the original event ID. Replays require receiver deduplication.

To pause delivery unset the webhook URL; rows remain durable. Keep the additive table/triggers during rollback. Rolling API bootstrap back to old code would re-enable the legacy sender with its incompatible signature; do not point a rolled-back API at the new receiver. No Mailtrap or welcome-email behavior changes.
