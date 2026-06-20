-- Automation sessions (trigger fires + Slack/Telegram channel threads) used to
-- be created visibility='private' owned by the account's first owner, making
-- them invisible to everyone else on the team. New ones are now created with
-- visibility='project' (see createProjectSession callers); this backfills the
-- existing rows so historical Slack/scheduled/webhook threads show up too.
-- Idempotent: only flips rows still sitting at 'private' (explicitly
-- restricted/shared rows are left alone).
UPDATE "kortix"."project_sessions"
SET "visibility" = 'project'
WHERE "visibility" = 'private'
  AND (
    "metadata" ->> 'source' IN ('slack', 'telegram')
    OR "metadata" ? 'trigger_source'
  );
