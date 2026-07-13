CREATE TABLE "kortix"."project_llm_routing_policies" (
  "project_id" uuid PRIMARY KEY NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "vision_model" varchar(128),
  "default_fallback_models" jsonb,
  "default_fallback_on" text,
  "rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_llm_routing_policies_fallback_pair_check"
    CHECK (("default_fallback_models" IS NULL AND "default_fallback_on" IS NULL)
      OR ("default_fallback_models" IS NOT NULL AND "default_fallback_on" IN ('transient', 'any-error'))),
  CONSTRAINT "project_llm_routing_policies_rules_array_check"
    CHECK (jsonb_typeof("rules") = 'array')
);

