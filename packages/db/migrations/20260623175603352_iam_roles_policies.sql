CREATE TABLE "kortix"."iam_policies" (
	"policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"principal_type" varchar(16) NOT NULL,
	"principal_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"scope_id" uuid,
	"expires_at" timestamp with time zone,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."iam_role_actions" (
	"role_id" uuid NOT NULL,
	"action" varchar(96) NOT NULL,
	CONSTRAINT "iam_role_actions_role_id_action_pk" PRIMARY KEY("role_id","action")
);
--> statement-breakpoint
CREATE TABLE "kortix"."iam_roles" (
	"role_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"scope_type" varchar(16) DEFAULT 'project' NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."iam_policies" ADD CONSTRAINT "iam_policies_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_policies" ADD CONSTRAINT "iam_policies_role_id_iam_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "kortix"."iam_roles"("role_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_role_actions" ADD CONSTRAINT "iam_role_actions_role_id_iam_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "kortix"."iam_roles"("role_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_roles" ADD CONSTRAINT "iam_roles_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_iam_policies_account_principal" ON "kortix"."iam_policies" USING btree ("account_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "idx_iam_policies_scope" ON "kortix"."iam_policies" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "idx_iam_policies_role" ON "kortix"."iam_policies" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_iam_roles_account" ON "kortix"."iam_roles" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_iam_roles_account_key" ON "kortix"."iam_roles" USING btree ("account_id","key");