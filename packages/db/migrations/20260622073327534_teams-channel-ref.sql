-- 20260622073327534_teams-channel-ref.sql
-- Microsoft Teams live-status support: a nullable, additive JSONB column on
-- kortix.chat_turn_streams holding the platform-specific conversation reference
-- for non-Slack channels. Teams stores
--   { platform, serviceUrl, conversationId, activityId, streamId, streamSequence }
-- so a live-turn relay landing on any replica can update/stream the same Teams
-- message. Slack rows leave it null and keep using the existing
-- channel / message_ts / team_id columns.
--
-- Purely additive + nullable → zero-downtime safe: old code ignores the column,
-- new code reads it only for Teams turns. No backfill, no NOT NULL, no default.

ALTER TABLE "kortix"."chat_turn_streams" ADD COLUMN IF NOT EXISTS "channel_ref" jsonb;
