DO $$ BEGIN
  CREATE TYPE "kortix"."tunnel_device_auth_status" AS ENUM('pending', 'approved', 'denied', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "kortix"."tunnel_device_auth_requests" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "device_code" varchar(9) NOT NULL,
    "device_secret_hash" varchar(128) NOT NULL,
    "status" "kortix"."tunnel_device_auth_status" DEFAULT 'pending' NOT NULL,
    "machine_hostname" varchar(255),
    "account_id" uuid,
    "tunnel_id" uuid,
    "setup_token" varchar(64),
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "kortix"."tunnel_device_auth_requests"
    ADD CONSTRAINT "tunnel_device_auth_requests_tunnel_id_tunnel_connections_tunnel_id_fk"
    FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_tunnel_device_auth_code" ON "kortix"."tunnel_device_auth_requests" USING btree ("device_code");
CREATE INDEX IF NOT EXISTS "idx_tunnel_device_auth_status" ON "kortix"."tunnel_device_auth_requests" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_tunnel_device_auth_expires" ON "kortix"."tunnel_device_auth_requests" USING btree ("expires_at");
