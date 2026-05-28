DO $$ BEGIN
  CREATE TYPE "kortix"."tunnel_status" AS ENUM('online', 'offline', 'connecting');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "kortix"."tunnel_capability" AS ENUM('filesystem', 'shell', 'network', 'apps', 'hardware', 'desktop', 'gpu');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "kortix"."tunnel_permission_status" AS ENUM('active', 'revoked', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "kortix"."tunnel_permission_request_status" AS ENUM('pending', 'approved', 'denied', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "kortix"."tunnel_connections" (
    "tunnel_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "account_id" uuid NOT NULL,
    "sandbox_id" uuid,
    "name" varchar(255) NOT NULL,
    "status" "kortix"."tunnel_status" DEFAULT 'offline' NOT NULL,
    "capabilities" jsonb DEFAULT '[]'::jsonb,
    "machine_info" jsonb DEFAULT '{}'::jsonb,
    "setup_token_hash" varchar(128),
    "last_heartbeat_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "kortix"."tunnel_permissions" (
    "permission_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "tunnel_id" uuid NOT NULL,
    "account_id" uuid NOT NULL,
    "capability" "kortix"."tunnel_capability" NOT NULL,
    "scope" jsonb DEFAULT '{}'::jsonb,
    "status" "kortix"."tunnel_permission_status" DEFAULT 'active' NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "kortix"."tunnel_permission_requests" (
    "request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "tunnel_id" uuid NOT NULL,
    "account_id" uuid NOT NULL,
    "capability" "kortix"."tunnel_capability" NOT NULL,
    "requested_scope" jsonb DEFAULT '{}'::jsonb,
    "reason" text,
    "status" "kortix"."tunnel_permission_request_status" DEFAULT 'pending' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "kortix"."tunnel_audit_logs" (
    "log_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "tunnel_id" uuid NOT NULL,
    "account_id" uuid NOT NULL,
    "capability" "kortix"."tunnel_capability" NOT NULL,
    "operation" varchar(100) NOT NULL,
    "request_summary" jsonb DEFAULT '{}'::jsonb,
    "success" boolean NOT NULL,
    "duration_ms" integer,
    "bytes_transferred" integer,
    "error_message" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "kortix"."tunnel_connections" ADD CONSTRAINT "tunnel_connections_sandbox_id_sandboxes_sandbox_id_fk"
    FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "kortix"."tunnel_permissions" ADD CONSTRAINT "tunnel_permissions_tunnel_id_tunnel_connections_tunnel_id_fk"
    FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "kortix"."tunnel_permission_requests" ADD CONSTRAINT "tunnel_permission_requests_tunnel_id_tunnel_connections_tunnel_id_fk"
    FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "kortix"."tunnel_audit_logs" ADD CONSTRAINT "tunnel_audit_logs_tunnel_id_tunnel_connections_tunnel_id_fk"
    FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_tunnel_connections_account" ON "kortix"."tunnel_connections" USING btree ("account_id");
CREATE INDEX IF NOT EXISTS "idx_tunnel_connections_sandbox" ON "kortix"."tunnel_connections" USING btree ("sandbox_id");
CREATE INDEX IF NOT EXISTS "idx_tunnel_connections_status" ON "kortix"."tunnel_connections" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_tunnel_permissions_tunnel" ON "kortix"."tunnel_permissions" USING btree ("tunnel_id");
CREATE INDEX IF NOT EXISTS "idx_tunnel_permissions_account" ON "kortix"."tunnel_permissions" USING btree ("account_id");
CREATE INDEX IF NOT EXISTS "idx_tunnel_permissions_capability" ON "kortix"."tunnel_permissions" USING btree ("capability");
CREATE INDEX IF NOT EXISTS "idx_tunnel_permissions_status" ON "kortix"."tunnel_permissions" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_tunnel_perm_requests_tunnel" ON "kortix"."tunnel_permission_requests" USING btree ("tunnel_id");
CREATE INDEX IF NOT EXISTS "idx_tunnel_perm_requests_account" ON "kortix"."tunnel_permission_requests" USING btree ("account_id");
CREATE INDEX IF NOT EXISTS "idx_tunnel_perm_requests_status" ON "kortix"."tunnel_permission_requests" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_tunnel_audit_tunnel" ON "kortix"."tunnel_audit_logs" USING btree ("tunnel_id");
CREATE INDEX IF NOT EXISTS "idx_tunnel_audit_account" ON "kortix"."tunnel_audit_logs" USING btree ("account_id");
CREATE INDEX IF NOT EXISTS "idx_tunnel_audit_capability" ON "kortix"."tunnel_audit_logs" USING btree ("capability");
CREATE INDEX IF NOT EXISTS "idx_tunnel_audit_created" ON "kortix"."tunnel_audit_logs" USING btree ("created_at");
