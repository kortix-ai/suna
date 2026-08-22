-- Migration: retire_provider_secret_private_override
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- LLM provider credentials are always project-wide (shared) -- there is no
-- per-user/private key concept, and never has been outside a short reopened
-- window (2026-07-14 "BYOK private-key blindness" fix, superseded same day).
-- That fix reopened PUT /projects/:id/secrets/:name/personal for provider
-- credential env vars (previously hard-blocked -- see the 2026-07-04
-- "secret_agent_scope" migration, which already retired the general "only
-- me" override entirely except for the genuinely per-user CODEX_AUTH_JSON /
-- OPENCODE_AUTH_JSON provider logins). The route is closed again in the same
-- app-code change this migration ships with; this cleans up any private
-- provider-secret rows that were created during that window so no row is
-- silently orphaned once gateway resolution stops falling back to a
-- caller's own private key.
--
-- Same promote-or-drop shape as 20260704140000000_secret_agent_scope.sql:
-- promote a private row to the shared slot when no shared row exists yet for
-- that (project, name) (most-recently-updated wins), otherwise drop it (it
-- only ever shadowed an existing shared row for its own owner). The provider
-- env-var list below is a snapshot of packages/llm-catalog's known env vars
-- at the time this migration was written -- best-effort, not exhaustive
-- against a catalog that grows over time; any row this misses is a narrow,
-- documented gap (see PR description), not a correctness requirement this
-- migration depends on.
--
-- mixed-version-safe: pure data cleanup on rows that could only exist from a
-- feature window that shipped and was reverted in the same deploy generation
-- as this migration -- no other app code path depends on these rows staying
-- private.

WITH provider_env_vars(name) AS (
  VALUES
    ('302AI_API_KEY'), ('ABACUS_API_KEY'), ('ABLIT_KEY'), ('AICORE_SERVICE_KEY'),
    ('AIHUBMIX_API_KEY'), ('AI_GATEWAY_API_KEY'), ('ALIBABA_CODING_PLAN_API_KEY'),
    ('ALIBABA_TOKEN_PLAN_API_KEY'), ('AMBIENT_API_KEY'), ('ANTHROPIC_API_KEY'),
    ('ANYAPI_API_KEY'), ('ATOMIC_CHAT_API_KEY'), ('AURIKO_API_KEY'),
    ('AWS_ACCESS_KEY_ID'), ('AWS_BEARER_TOKEN_BEDROCK'), ('AWS_REGION'),
    ('AWS_SECRET_ACCESS_KEY'), ('AZURE_API_KEY'), ('AZURE_COGNITIVE_SERVICES_API_KEY'),
    ('AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'), ('AZURE_RESOURCE_NAME'),
    ('BAILING_API_TOKEN'), ('BASETEN_API_KEY'), ('BERGET_API_KEY'),
    ('CEREBRAS_API_KEY'), ('CHUTES_API_KEY'), ('CLARIFAI_PAT'),
    ('CLAUDINIO_API_KEY'), ('CLOUDFERRO_SHERLOCK_API_KEY'), ('CLOUDFLARE_ACCOUNT_ID'),
    ('CLOUDFLARE_API_KEY'), ('CLOUDFLARE_API_TOKEN'), ('CLOUDFLARE_GATEWAY_ID'),
    ('COHERE_API_KEY'), ('CORTECS_API_KEY'), ('CROF_API_KEY'), ('DASHSCOPE_API_KEY'),
    ('DATABRICKS_HOST'), ('DATABRICKS_TOKEN'), ('DEEPINFRA_API_KEY'),
    ('DEEPSEEK_API_KEY'), ('DIGITALOCEAN_ACCESS_TOKEN'), ('DINFERENCE_API_KEY'),
    ('DRUN_API_KEY'), ('EVROC_API_KEY'), ('FASTROUTER_API_KEY'), ('FIREPASS_API_KEY'),
    ('FIREWORKS_API_KEY'), ('FREEMODEL_API_KEY'), ('FRIENDLI_TOKEN'),
    ('FROGBOT_API_KEY'), ('GEMINI_API_KEY'), ('GITHUB_TOKEN'), ('GITLAB_TOKEN'),
    ('GMICLOUD_API_KEY'), ('GOOGLE_API_KEY'), ('GOOGLE_APPLICATION_CREDENTIALS'),
    ('GOOGLE_GENERATIVE_AI_API_KEY'), ('GOOGLE_VERTEX_LOCATION'),
    ('GOOGLE_VERTEX_PROJECT'), ('GROQ_API_KEY'), ('HELICONE_API_KEY'), ('HF_TOKEN'),
    ('HPC_AI_API_KEY'), ('IFLOW_API_KEY'), ('INCEPTION_API_KEY'),
    ('INCEPTRON_API_KEY'), ('INFERENCE_API_KEY'), ('IOINTELLIGENCE_API_KEY'),
    ('JIEKOU_API_KEY'), ('KILO_API_KEY'), ('KIMI_API_KEY'), ('KUAE_API_KEY'),
    ('LILAC_API_KEY'), ('LLAMA_API_KEY'), ('LLMGATEWAY_API_KEY'), ('LLMTR_API_KEY'),
    ('LMSTUDIO_API_KEY'), ('LUCIDQUERY_API_KEY'), ('MEGANOVA_API_KEY'),
    ('MERGE_GATEWAY_API_KEY'), ('MINIMAX_API_KEY'), ('MISTRAL_API_KEY'),
    ('MIXLAYER_API_KEY'), ('MOARK_API_KEY'), ('MODELSCOPE_API_KEY'),
    ('MOONSHOT_API_KEY'), ('MORPH_API_KEY'), ('NANO_GPT_API_KEY'),
    ('NEARAI_API_KEY'), ('NEBIUS_API_KEY'), ('NEON_AI_GATEWAY_BASE_URL'),
    ('NEON_AI_GATEWAY_TOKEN'), ('NEURALWATT_API_KEY'), ('NOVA_API_KEY'),
    ('NOVITA_API_KEY'), ('NVIDIA_API_KEY'), ('OLLAMA_API_KEY'), ('OPENAI_API_KEY'),
    ('OPENCODE_API_KEY'), ('OPENROUTER_API_KEY'), ('ORCAROUTER_API_KEY'),
    ('OVHCLOUD_API_KEY'), ('PERPLEXITY_API_KEY'), ('POE_API_KEY'),
    ('POOLSIDE_API_KEY'), ('PRIVATEMODE_API_KEY'), ('PRIVATEMODE_ENDPOINT'),
    ('QIHANG_API_KEY'), ('QINIU_API_KEY'), ('REGOLO_API_KEY'), ('REQUESTY_API_KEY'),
    ('ROUTING_RUN_API_KEY'), ('SARVAM_API_KEY'), ('SCALEWAY_API_KEY'),
    ('SILICONFLOW_API_KEY'), ('SILICONFLOW_CN_API_KEY'), ('SNOWFLAKE_ACCOUNT'),
    ('SNOWFLAKE_CORTEX_PAT'), ('STACKIT_API_KEY'), ('STEPFUN_API_KEY'),
    ('SUBMODEL_INSTAGEN_ACCESS_KEY'), ('SYNTHETIC_API_KEY'),
    ('TENCENT_CODING_PLAN_API_KEY'), ('TENCENT_TOKENHUB_API_KEY'),
    ('THEGRIDAI_API_KEY'), ('TOGETHER_API_KEY'), ('UMANS_AI_API_KEY'),
    ('UMANS_AI_CODING_PLAN_API_KEY'), ('UPSTAGE_API_KEY'), ('V0_API_KEY'),
    ('VENICE_API_KEY'), ('VIVGRID_API_KEY'), ('VULTR_API_KEY'), ('WAFER_API_KEY'),
    ('WANDB_API_KEY'), ('XAI_API_KEY'), ('XIAOMI_API_KEY'), ('XPERSONA_API_KEY'),
    ('ZELDOC_API_KEY'), ('ZENMUX_API_KEY'), ('ZHIPU_API_KEY')
),
-- Promote a private provider-secret row to the shared slot where NO shared
-- row of that (project, name) exists yet (most-recently-updated wins).
ranked AS (
  SELECT
    p."secret_id",
    row_number() OVER (
      PARTITION BY p."project_id", p."name"
      ORDER BY p."updated_at" DESC, p."secret_id"
    ) AS rn
  FROM "kortix"."project_secrets" p
  WHERE p."owner_user_id" IS NOT NULL
    AND p."name" IN (SELECT name FROM provider_env_vars)
    AND NOT EXISTS (
      SELECT 1 FROM "kortix"."project_secrets" s
      WHERE s."project_id" = p."project_id"
        AND s."name" = p."name"
        AND s."owner_user_id" IS NULL
    )
)
UPDATE "kortix"."project_secrets" t
SET "owner_user_id" = NULL, "active" = true, "updated_at" = now()
FROM ranked r
WHERE t."secret_id" = r."secret_id" AND r."rn" = 1;

-- Drop every remaining private provider-secret row (promotion losers, or
-- overrides that only shadowed an existing shared row for their own owner).
-- Provider credentials have no "only me" option -- ever.
DELETE FROM "kortix"."project_secrets"
WHERE "owner_user_id" IS NOT NULL
  AND "name" IN (
    '302AI_API_KEY', 'ABACUS_API_KEY', 'ABLIT_KEY', 'AICORE_SERVICE_KEY',
    'AIHUBMIX_API_KEY', 'AI_GATEWAY_API_KEY', 'ALIBABA_CODING_PLAN_API_KEY',
    'ALIBABA_TOKEN_PLAN_API_KEY', 'AMBIENT_API_KEY', 'ANTHROPIC_API_KEY',
    'ANYAPI_API_KEY', 'ATOMIC_CHAT_API_KEY', 'AURIKO_API_KEY',
    'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION',
    'AWS_SECRET_ACCESS_KEY', 'AZURE_API_KEY', 'AZURE_COGNITIVE_SERVICES_API_KEY',
    'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME', 'AZURE_RESOURCE_NAME',
    'BAILING_API_TOKEN', 'BASETEN_API_KEY', 'BERGET_API_KEY',
    'CEREBRAS_API_KEY', 'CHUTES_API_KEY', 'CLARIFAI_PAT',
    'CLAUDINIO_API_KEY', 'CLOUDFERRO_SHERLOCK_API_KEY', 'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_GATEWAY_ID',
    'COHERE_API_KEY', 'CORTECS_API_KEY', 'CROF_API_KEY', 'DASHSCOPE_API_KEY',
    'DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'DEEPINFRA_API_KEY',
    'DEEPSEEK_API_KEY', 'DIGITALOCEAN_ACCESS_TOKEN', 'DINFERENCE_API_KEY',
    'DRUN_API_KEY', 'EVROC_API_KEY', 'FASTROUTER_API_KEY', 'FIREPASS_API_KEY',
    'FIREWORKS_API_KEY', 'FREEMODEL_API_KEY', 'FRIENDLI_TOKEN',
    'FROGBOT_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'GITLAB_TOKEN',
    'GMICLOUD_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_VERTEX_LOCATION',
    'GOOGLE_VERTEX_PROJECT', 'GROQ_API_KEY', 'HELICONE_API_KEY', 'HF_TOKEN',
    'HPC_AI_API_KEY', 'IFLOW_API_KEY', 'INCEPTION_API_KEY',
    'INCEPTRON_API_KEY', 'INFERENCE_API_KEY', 'IOINTELLIGENCE_API_KEY',
    'JIEKOU_API_KEY', 'KILO_API_KEY', 'KIMI_API_KEY', 'KUAE_API_KEY',
    'LILAC_API_KEY', 'LLAMA_API_KEY', 'LLMGATEWAY_API_KEY', 'LLMTR_API_KEY',
    'LMSTUDIO_API_KEY', 'LUCIDQUERY_API_KEY', 'MEGANOVA_API_KEY',
    'MERGE_GATEWAY_API_KEY', 'MINIMAX_API_KEY', 'MISTRAL_API_KEY',
    'MIXLAYER_API_KEY', 'MOARK_API_KEY', 'MODELSCOPE_API_KEY',
    'MOONSHOT_API_KEY', 'MORPH_API_KEY', 'NANO_GPT_API_KEY',
    'NEARAI_API_KEY', 'NEBIUS_API_KEY', 'NEON_AI_GATEWAY_BASE_URL',
    'NEON_AI_GATEWAY_TOKEN', 'NEURALWATT_API_KEY', 'NOVA_API_KEY',
    'NOVITA_API_KEY', 'NVIDIA_API_KEY', 'OLLAMA_API_KEY', 'OPENAI_API_KEY',
    'OPENCODE_API_KEY', 'OPENROUTER_API_KEY', 'ORCAROUTER_API_KEY',
    'OVHCLOUD_API_KEY', 'PERPLEXITY_API_KEY', 'POE_API_KEY',
    'POOLSIDE_API_KEY', 'PRIVATEMODE_API_KEY', 'PRIVATEMODE_ENDPOINT',
    'QIHANG_API_KEY', 'QINIU_API_KEY', 'REGOLO_API_KEY', 'REQUESTY_API_KEY',
    'ROUTING_RUN_API_KEY', 'SARVAM_API_KEY', 'SCALEWAY_API_KEY',
    'SILICONFLOW_API_KEY', 'SILICONFLOW_CN_API_KEY', 'SNOWFLAKE_ACCOUNT',
    'SNOWFLAKE_CORTEX_PAT', 'STACKIT_API_KEY', 'STEPFUN_API_KEY',
    'SUBMODEL_INSTAGEN_ACCESS_KEY', 'SYNTHETIC_API_KEY',
    'TENCENT_CODING_PLAN_API_KEY', 'TENCENT_TOKENHUB_API_KEY',
    'THEGRIDAI_API_KEY', 'TOGETHER_API_KEY', 'UMANS_AI_API_KEY',
    'UMANS_AI_CODING_PLAN_API_KEY', 'UPSTAGE_API_KEY', 'V0_API_KEY',
    'VENICE_API_KEY', 'VIVGRID_API_KEY', 'VULTR_API_KEY', 'WAFER_API_KEY',
    'WANDB_API_KEY', 'XAI_API_KEY', 'XIAOMI_API_KEY', 'XPERSONA_API_KEY',
    'ZELDOC_API_KEY', 'ZENMUX_API_KEY', 'ZHIPU_API_KEY'
  );

-- Down Migration
--
-- Forward-only: provider credentials never have a private option. The
-- dropped/promoted rows are not reconstructible (and shouldn't be).
