DO $$
BEGIN
  BEGIN
    CREATE TYPE "kortix"."project_access_request_status" AS ENUM ('pending', 'approved', 'rejected');
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;

  CREATE TABLE IF NOT EXISTS "kortix"."project_access_requests" (
    "request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
    "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE cascade,
    "requester_user_id" uuid NOT NULL,
    "requester_email" varchar(255) NOT NULL,
    "message" text,
    "status" "kortix"."project_access_request_status" NOT NULL DEFAULT 'pending',
    "reviewed_by" uuid,
    "reviewed_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS "idx_project_access_requests_project"
    ON "kortix"."project_access_requests" USING btree ("project_id");

  CREATE INDEX IF NOT EXISTS "idx_project_access_requests_account"
    ON "kortix"."project_access_requests" USING btree ("account_id");

  CREATE INDEX IF NOT EXISTS "idx_project_access_requests_requester"
    ON "kortix"."project_access_requests" USING btree ("requester_user_id");

  CREATE INDEX IF NOT EXISTS "idx_project_access_requests_status"
    ON "kortix"."project_access_requests" USING btree ("status");

  CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_access_requests_pending_unique"
    ON "kortix"."project_access_requests" USING btree ("project_id", "requester_user_id")
    WHERE "status" = 'pending';
END $$;
