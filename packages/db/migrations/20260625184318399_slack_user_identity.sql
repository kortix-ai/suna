CREATE TABLE "kortix"."chat_user_identities" (
	"identity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(32) NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"platform_user_id" varchar(128) NOT NULL,
	"user_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_user_identities_platform_user" ON "kortix"."chat_user_identities" USING btree ("platform","workspace_id","platform_user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_user_identities_user" ON "kortix"."chat_user_identities" USING btree ("user_id");