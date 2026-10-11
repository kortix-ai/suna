-- Order-independent structural signature of the managed `kortix` schema:
-- columns, enums, indexes, constraints. Used by the drift sentinel to compare a
-- freshly-built schema (from migrations) against a live environment. Run with:
--   psql "$URL" -X -At -f scripts/schema-signature.sql | sed -e 's/kortix\.//g' -e 's/public\.//g' | sort
-- Weekly audit_events partitions (audit_events_pYYYYMMDD) are created at runtime by
-- kortix.audit_events_ensure_partitions, not by a migration, so their set differs
-- between a fresh build and a live database. They are excluded by name below.
-- (the sed strips schema-qualification, which renders differently depending on
--  the search_path a column/constraint was created under — not a real diff.)
SELECT 'COL|'||table_name||'.'||column_name||'|'||data_type||'|'||is_nullable||'|'||coalesce(column_default,'')
FROM information_schema.columns WHERE table_schema='kortix' AND table_name !~ '^audit_events_p[0-9]{8}$';
SELECT 'ENUM|'||t.typname||'|'||string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname='kortix' GROUP BY t.typname;
SELECT 'IDX|'||indexname||'|'||regexp_replace(indexdef,'^CREATE','C') FROM pg_indexes WHERE schemaname='kortix' AND tablename !~ '^audit_events_p[0-9]{8}$';
SELECT 'CON|'||c.conrelid::regclass::text||'|'||c.conname||'|'||pg_get_constraintdef(c.oid)
FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='kortix' AND c.conrelid::regclass::text !~ '^(kortix\.)?audit_events_p[0-9]{8}$';
