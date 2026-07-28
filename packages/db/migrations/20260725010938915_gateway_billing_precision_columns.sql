SET lock_timeout = '5s';
SET statement_timeout = '30min';

ALTER TABLE "kortix"."credit_ledger" ALTER COLUMN "amount" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "kortix"."credit_ledger" ALTER COLUMN "balance_after" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "balance_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "lifetime_granted_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "lifetime_purchased_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "lifetime_used_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "expiring_credits_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "non_expiring_credits_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "daily_credits_balance_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."credit_ledger" ADD COLUMN "amount_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."credit_ledger" ADD COLUMN "balance_after_precise" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_request_logs" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;
