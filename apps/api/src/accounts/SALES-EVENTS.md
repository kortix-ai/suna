# Sales event delivery

Apply all three Sales migrations (outbox, producers, and trusted-writer) before rolling out the API/web change. No production migration, configuration or deployment was performed by this PR.

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

### Trusted demo persistence

The web server must have `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`)
in its server-only runtime environment. Never expose this key through a
`NEXT_PUBLIC_` variable. Missing server credentials return retryable 503; the
route never falls back to the public anonymous key. The trusted-writer migration
keeps direct `anon`/`authenticated` contact inserts as storage only: they cannot
produce signed Sales events. Deploy the server credential before switching the
web route. Keep delivery paused until both the trusted-writer migration and the
server-side route are present. Rollback must keep the anonymous-role exclusion;
restoring the anonymous web writer disables demo events rather than weakening
that boundary.

### Reviewed operator database reversal

Operator-only SQL lives in `packages/db/rollback/sales-events.sql`, outside the
migration runner. Stop the outbox worker and unset the delivery URL first. Roll
application code back before executing it; the new worker needs the live table.
This transaction drops only the two Sales triggers/functions and moves the entire
outbox table, indexes, payloads and receipts to `sales_events_rollback`. Anonymous
and authenticated roles cannot access that archive. Auth users/contact forms are
untouched. The archive schema must not already exist: a second execution fails
closed instead of replacing an earlier backlog. No production reversal was run.

Capture stops after reversal; record its time and reconcile signups and persisted
contact submissions before resuming delivery. Never connect the old incompatible
sender to the v1 sink. To restore: move the archived table back to `kortix`, drop
the now-empty archive schema, then reapply the producer and trusted-writer SQL
under review (do not rerun the create-table migration or erase migration history).
An isolated PostgreSQL reversal verified exact full-row backlog equality and the
absence of the live table; restoration reapplied both producers and trusted-writer
restriction, then reran the integration suite.
