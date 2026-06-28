CREATE TABLE IF NOT EXISTS "kortix"."account_model_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text DEFAULT '' NOT NULL,
	"model" varchar(128) NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "kortix"."account_model_preferences" ADD CONSTRAINT "account_model_preferences_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_model_preferences_account" ON "kortix"."account_model_preferences" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_model_preferences_scope" ON "kortix"."account_model_preferences" USING btree ("account_id","scope","scope_key");
