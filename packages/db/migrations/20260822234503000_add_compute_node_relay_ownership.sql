CREATE TABLE "kortix"."compute_node_rpc_forwards" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"requester_relay_owner_id" text NOT NULL,
	"target_relay_owner_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_node_rpc_forwards_status_check" CHECK ("kortix"."compute_node_rpc_forwards"."status" IN ('pending', 'processing', 'completed', 'error'))
);
--> statement-breakpoint
SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "kortix"."compute_nodes" ADD COLUMN "relay_owner_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."compute_nodes" ADD COLUMN "relay_owner_instance" text;--> statement-breakpoint
ALTER TABLE "kortix"."compute_nodes" ADD COLUMN "relay_owner_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."compute_nodes" ADD COLUMN "relay_owner_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_rpc_forwards" ADD CONSTRAINT "cn_rpc_forwards_node_fk" FOREIGN KEY ("node_id") REFERENCES "kortix"."compute_nodes"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_rpc_forwards" ADD CONSTRAINT "cn_rpc_forwards_account_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compute_node_rpc_forwards_target_idx" ON "kortix"."compute_node_rpc_forwards" USING btree ("target_relay_owner_id","status");--> statement-breakpoint
CREATE INDEX "compute_node_rpc_forwards_expiry_idx" ON "kortix"."compute_node_rpc_forwards" USING btree ("expires_at");
