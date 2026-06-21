-- Per-account audit webhooks for SIEM streaming (Splunk, Datadog, generic).
-- Each row carries the destination URL + HMAC-SHA256 signing secret. The
-- delivery worker fires on every recordAuditEvent and writes last_error /
-- last_delivered_at back to the row so admins can spot broken endpoints.
-- Idempotent — re-runnable.

CREATE TABLE IF NOT EXISTS "kortix"."audit_webhooks" (
  "webhook_id"        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"        uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "url"               text NOT NULL,
  "secret"            text NOT NULL,
  "name"              varchar(128) NOT NULL,
  "enabled"           boolean DEFAULT true NOT NULL,
  "action_prefix"     varchar(128),
  "last_delivered_at" timestamp with time zone,
  "last_error_at"     timestamp with time zone,
  "last_error"        text,
  "created_by"        uuid,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"        timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_audit_webhooks_account"
  ON "kortix"."audit_webhooks" ("account_id");

CREATE INDEX IF NOT EXISTS "idx_audit_webhooks_enabled"
  ON "kortix"."audit_webhooks" ("account_id", "enabled");

GRANT ALL ON TABLE "kortix"."audit_webhooks" TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kortix"."audit_webhooks" TO authenticated;
