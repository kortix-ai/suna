-- Migration: chat_pending_picker_project_nullable
--
-- A project-picker message (Slack and Teams) is parked before any project is
-- chosen, so the row has no project yet. Teams already wrote '' here, which
-- Postgres rejects as a uuid: every Teams picker message was dropped.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: old code always writes a non-null project_id and only reads picker rows by pending_id (Teams) or never (Slack, in-process Map), so it never sees a NULL it cannot handle.
-- squawk-ignore ban-drop-not-null
ALTER TABLE "kortix"."chat_pending_auth_messages" ALTER COLUMN "project_id" DROP NOT NULL;
