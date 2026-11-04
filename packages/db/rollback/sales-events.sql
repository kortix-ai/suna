-- Operator-only reversal, never picked up by the migration runner.
-- Stop the sales-outbox worker and unset delivery URL before running.
-- Preserves every payload and receipt in a restricted archive schema.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
CREATE SCHEMA sales_events_rollback;
REVOKE ALL ON SCHEMA sales_events_rollback FROM PUBLIC, anon, authenticated;
DROP TRIGGER sales_signup_confirmed ON auth.users;
DROP TRIGGER sales_demo_requested ON public.contact_forms;
DROP FUNCTION kortix.enqueue_confirmed_signup();
DROP FUNCTION kortix.enqueue_demo_requested();
ALTER TABLE kortix.sales_event_outbox SET SCHEMA sales_events_rollback;
COMMIT;
