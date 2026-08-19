-- Migration: secret_consumer_boundary
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE TYPE "kortix"."project_secret_consumer" AS ENUM('sandbox', 'llm_gateway', 'connector', 'executor', 'git_proxy', 'http_broker', 'network');--> statement-breakpoint
ALTER TABLE "kortix"."project_secrets" ADD COLUMN "consumer" "kortix"."project_secret_consumer" DEFAULT 'sandbox';--> statement-breakpoint

UPDATE "kortix"."project_secrets"
SET "consumer" = CASE
  WHEN "scope" = 'connector' THEN 'connector'::"kortix"."project_secret_consumer"
  WHEN "strategy" = 'denied' THEN NULL
  WHEN "strategy" = 'egress' THEN 'network'::"kortix"."project_secret_consumer"
  WHEN "strategy" = 'broker' AND "egress_policy"->>'backend' = 'llm_gateway' THEN 'llm_gateway'::"kortix"."project_secret_consumer"
  WHEN "strategy" = 'broker' AND "egress_policy"->>'backend' = 'executor' THEN 'executor'::"kortix"."project_secret_consumer"
  WHEN "strategy" = 'broker' AND "egress_policy"->>'backend' = 'git_proxy' THEN 'git_proxy'::"kortix"."project_secret_consumer"
  WHEN "strategy" = 'broker' AND "egress_policy"->>'backend' = 'kortix_fetch' THEN 'http_broker'::"kortix"."project_secret_consumer"
  ELSE "consumer"
END;
