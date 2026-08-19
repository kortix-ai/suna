set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE TABLE "kortix"."executor_attachments" (
	"attachment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text,
	"user_id" uuid NOT NULL,
	"object_path" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"content_disposition" varchar(16) DEFAULT 'attachment' NOT NULL,
	"content_id" text,
	"size_bytes" integer NOT NULL,
	"status" varchar(16) DEFAULT 'uploaded' NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "executor_attachments_object_path_unique" UNIQUE("object_path"),
	CONSTRAINT "executor_attachments_disposition_check" CHECK ("kortix"."executor_attachments"."content_disposition" IN ('attachment', 'inline')),
	CONSTRAINT "executor_attachments_status_check" CHECK ("kortix"."executor_attachments"."status" IN ('uploaded', 'claimed', 'consumed')),
	CONSTRAINT "executor_attachments_size_check" CHECK ("kortix"."executor_attachments"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE INDEX "idx_executor_attachments_scope" ON "kortix"."executor_attachments" USING btree ("project_id","session_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_executor_attachments_expiry" ON "kortix"."executor_attachments" USING btree ("expires_at");
