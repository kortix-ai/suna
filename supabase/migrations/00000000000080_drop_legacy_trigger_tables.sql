-- Drop the legacy DB-backed trigger tables.
--
-- Triggers are now 100% file-defined in kortix.toml ([[triggers]]) — read live
-- from the manifest by the scheduler and the trigger routes. Runtime state
-- (last_fired_at) lives in kortix.project_trigger_runtime. The old DB-backed
-- fire path (fireProjectTrigger) and these tables are dead code; nothing reads
-- or writes them anymore (the sweep no longer scans project_triggers, and
-- git-backed fires never wrote project_trigger_events).
--
-- Order matters: project_trigger_events FKs project_triggers, so drop it first,
-- then the table, then the now-unused enum types.

DROP TABLE IF EXISTS kortix.project_trigger_events;
DROP TABLE IF EXISTS kortix.project_triggers;

DROP TYPE IF EXISTS kortix.project_trigger_event_status;
DROP TYPE IF EXISTS kortix.project_trigger_type;
