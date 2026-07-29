-- Migration: usage_extends_sandbox_deadline
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- BOUNDED SANDBOX LIFETIME, step 7/7 -- W3a, the "observed billed progress"
-- extension, as a trigger rather than as application code.
--
-- WHY A TRIGGER. There are many turn-start paths that never present themselves
-- to the proxy as a classifiable prompt: PTY-driven runs, the in-box
-- turn-auto-resume, subagents, KORTIX_INITIAL_PROMPT delivered inside the box
-- at boot, /session/:id/command, a direct hit on :4096, /proxy/4096 nesting.
-- Every one of them burns tokens, so a trigger on usage_events covers all of
-- them at once. It also works regardless of WHICH service wrote the row (the
-- standalone gateway on ECS and the in-process gateway both insert here), and
-- it cannot be forgotten by a future caller.
--
-- WHY usage_events AND NOT gateway_request_logs. Measured: one leased box
-- emitted 1,194 gateway_request_logs rows -- every one an HTTP 502
-- upstream_error, ~59/hour for 20.1 continuous hours -- and exactly 0
-- usage_events. recordUsage is gated on billedTokenTotal > 0, so a wedged retry
-- loop provably cannot forge a usage_events row. The WHEN clause below
-- additionally excludes the zero-token billing-hold branch.
--
-- WHY THE account_id PREDICATE. usage_events.session_id is a bare text column
-- with no FK, and on the LEGACY router path it is still caller-supplied
-- (body.session_id / X-Session-ID) -- the schema documents this hazard itself,
-- in the origin_ref comment. Until every writer is server-derived, an
-- unqualified join would be a cross-tenant sandbox-life extender purchasable
-- for a fraction of a cent. Scoping the UPDATE by account_id makes forging
-- another tenant's session id useless.
--
-- WHY THE THIRD PREDICATE. Without `deadline_at < now() + grant - 2 minutes`
-- this fires a real UPDATE on every LLM call of every turn -- WAL volume and
-- dead-tuple churn proportional to LLM calls rather than to turns. With it, a
-- write happens only when it actually MOVES the deadline.
--
-- WHY THE EXCEPTION HANDLER. This trigger runs inside the usage_events INSERT's
-- transaction. Billing accuracy outranks deadline accuracy: a failure to extend
-- a deadline must never roll back the record of money spent. Worst case the box
-- is stopped early and the user's next prompt resumes it.
CREATE OR REPLACE FUNCTION "kortix"."extend_sandbox_deadline_on_usage"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    UPDATE kortix.session_sandboxes s
       SET deadline_at = LEAST(
             s.active_since + interval '24 hours',
             GREATEST(s.deadline_at, now() + interval '2 hours')
           ),
           updated_at = now()
     WHERE s.session_id = NEW.session_id
       AND s.account_id = NEW.account_id
       AND s.status = 'active'
       AND s.deadline_at < now() + interval '2 hours' - interval '2 minutes';
  EXCEPTION WHEN others THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "trg_usage_extends_sandbox_deadline" ON "kortix"."usage_events";

CREATE TRIGGER "trg_usage_extends_sandbox_deadline"
AFTER INSERT ON "kortix"."usage_events"
FOR EACH ROW
WHEN (NEW."session_id" IS NOT NULL AND (NEW."input_tokens" + NEW."output_tokens") > 0)
EXECUTE FUNCTION "kortix"."extend_sandbox_deadline_on_usage"();
