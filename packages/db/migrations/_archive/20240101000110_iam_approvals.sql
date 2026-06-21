-- Approval workflows for sensitive IAM actions. Two-phase:
--   1) sensitive endpoint stores request + returns 202
--   2) a different super-admin approves → action runs server-side
-- Requester can't approve their own request; gated by approvals
-- toggle on the account.

ALTER TABLE "kortix"."accounts"
  ADD COLUMN IF NOT EXISTS "iam_approvals_required" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "kortix"."iam_approval_requests" (
  "request_id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"        uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "action"            varchar(128) NOT NULL,
  "target_id"         uuid,
  "payload"           jsonb NOT NULL DEFAULT '{}'::jsonb,
  "requester_reason"  text,
  "requested_by"      uuid NOT NULL,
  "requested_at"      timestamptz NOT NULL DEFAULT now(),
  "expires_at"        timestamptz NOT NULL,
  "status"            varchar(16) NOT NULL DEFAULT 'pending',
  "decided_by"        uuid,
  "decided_at"        timestamptz,
  "decision_reason"   text,
  "execution_result"  text
);

CREATE INDEX IF NOT EXISTS "idx_iam_approval_requests_account"
  ON "kortix"."iam_approval_requests" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_iam_approval_requests_status"
  ON "kortix"."iam_approval_requests" ("account_id", "status");
CREATE INDEX IF NOT EXISTS "idx_iam_approval_requests_requested_by"
  ON "kortix"."iam_approval_requests" ("requested_by");
