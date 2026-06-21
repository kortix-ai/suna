CREATE TYPE "kortix"."gateway_budget_action" AS ENUM('block', 'warn');--> statement-breakpoint
CREATE TYPE "kortix"."gateway_budget_period" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "kortix"."gateway_budget_scope" AS ENUM('project', 'member');--> statement-breakpoint
CREATE TABLE "kortix"."gateway_budgets" (
	"budget_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" "kortix"."gateway_budget_scope" NOT NULL,
	"subject_user_id" uuid,
	"limit_usd" numeric(12, 4) NOT NULL,
	"period" "kortix"."gateway_budget_period" DEFAULT 'month' NOT NULL,
	"action" "kortix"."gateway_budget_action" DEFAULT 'block' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."gateway_budgets" ADD CONSTRAINT "gateway_budgets_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gateway_budgets_project" ON "kortix"."gateway_budgets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_budgets_lookup" ON "kortix"."gateway_budgets" USING btree ("project_id","scope");