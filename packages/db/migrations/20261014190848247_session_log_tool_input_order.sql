-- Migration: session_log_tool_input_order
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The key order of each tool_call input in `record` (jsonb sorts object keys).
-- The restore puts the keys back in this order (session-log-input-order.ts in
-- apps/api). A nullable column without a default: a catalog-only change, no
-- table rewrite. Old code does not read or write it; its rows stay null and
-- restore as before.
ALTER TABLE "kortix"."session_log_messages" ADD COLUMN "tool_input_order" json;
