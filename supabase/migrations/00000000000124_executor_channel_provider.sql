-- Add the `channel` provider to the executor connector provider enum.
-- Channel connectors (Slack, later Telegram/Teams) are first-class Executor
-- connectors: a fixed per-platform action catalog whose credential is the
-- platform's existing install token (resolved server-side from project_secrets
-- via the install-store — no executor_credentials row). See KORTIX-206.
--
-- ALTER TYPE ... ADD VALUE is non-transactional and idempotent here via
-- IF NOT EXISTS, so this is safe to re-run.
ALTER TYPE "kortix"."executor_connector_provider" ADD VALUE IF NOT EXISTS 'channel';
