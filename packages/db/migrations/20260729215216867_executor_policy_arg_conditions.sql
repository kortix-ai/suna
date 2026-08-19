-- Migration: executor_policy_arg_conditions
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Tool-call policies could gate a tool NAME but not its ARGUMENTS: a rule could
-- say "the agent may call gmail.send_email" and not "...but only to these
-- addresses". `conditions` stores the optional argument predicates a rule must
-- also satisfy to apply (shape: [{arg, match, negate?}] -- see
-- ExecutorPolicyCondition in src/schema/kortix.ts; evaluation semantics in
-- apps/api/src/executor/policy.ts).
--
-- Purely additive and nullable, so it is mixed-version safe by construction:
-- NULL means "no argument conditions", which is exactly how every pre-existing
-- row already behaves. Old API instances ignore the column; new instances read
-- NULL as an unconditional rule. No backfill, no rewrite -- ADD COLUMN with no
-- DEFAULT is a catalog-only change in Postgres 11+.

ALTER TABLE "kortix"."executor_connection_policies" ADD COLUMN "conditions" jsonb;
ALTER TABLE "kortix"."executor_connector_policies" ADD COLUMN "conditions" jsonb;
ALTER TABLE "kortix"."executor_project_policies" ADD COLUMN "conditions" jsonb;
