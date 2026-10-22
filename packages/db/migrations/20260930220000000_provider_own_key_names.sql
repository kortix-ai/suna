-- Migration: provider_own_key_names
--
-- models.dev gives several providers one api-key env var (OpenCode Zen and Go
-- both list OPENCODE_API_KEY; four Z.ai/Zhipu offerings list ZHIPU_API_KEY).
-- Kortix stored a key under that name, so one key connected every claimant.
-- The API now reads each non-owner claimant's key under its own name
-- (packages/llm-catalog/src/lite.ts providerAuthRequirement; the map below is
-- generated from it). This copies a shared key to a claimant's own name where
-- the project already made a successful request to that claimant in the last
-- 120 days, so no working setup loses its key. The shared row stays: the old
-- API still reads it until the rollout ends. A claimant the project never
-- used successfully stops being connected, which is the fix.
--
-- A pooled key (account_secret_resources) already names its provider, so it
-- is renamed in place.
--
-- backfill-safe: kortix.project_secrets rows under 11 names (prod 2026-09-30:
-- 100 rows, 44 OPENCODE_API_KEY); the log check is an index lookup per row on
-- idx_gateway_logs_session (project_id), 12 ms for all 44 in prod.
-- kortix.account_secret_resources: 1 prod row matches. Row locks only.
set lock_timeout = '2s';
set statement_timeout = '60s';

CREATE TEMP TABLE provider_own_key_names (shared_name text, provider_id text, own_name text) ON COMMIT DROP;
INSERT INTO provider_own_key_names VALUES
  ('ALIBABA_CODING_PLAN_API_KEY', 'alibaba-coding-plan-cn', 'ALIBABA_CODING_PLAN_CN_API_KEY'),
  ('ALIBABA_TOKEN_PLAN_API_KEY', 'alibaba-token-plan-cn', 'ALIBABA_TOKEN_PLAN_CN_API_KEY'),
  ('DASHSCOPE_API_KEY', 'alibaba-cn', 'ALIBABA_CN_API_KEY'),
  ('LLMGATEWAY_API_KEY', 'llmgateway-providers', 'LLMGATEWAY_PROVIDERS_API_KEY'),
  ('MINIMAX_API_KEY', 'minimax-cn', 'MINIMAX_CN_API_KEY'),
  ('MINIMAX_API_KEY', 'minimax-cn-coding-plan', 'MINIMAX_CN_CODING_PLAN_API_KEY'),
  ('MINIMAX_API_KEY', 'minimax-coding-plan', 'MINIMAX_CODING_PLAN_API_KEY'),
  ('MOONSHOT_API_KEY', 'moonshotai-cn', 'MOONSHOTAI_CN_API_KEY'),
  ('OPENCODE_API_KEY', 'opencode-go', 'OPENCODE_GO_API_KEY'),
  ('PERPLEXITY_API_KEY', 'perplexity-agent', 'PERPLEXITY_AGENT_API_KEY'),
  ('STEPFUN_API_KEY', 'stepfun-ai', 'STEPFUN_AI_API_KEY'),
  ('STEPFUN_API_KEY', 'stepfun-ai-step-plan', 'STEPFUN_AI_STEP_PLAN_API_KEY'),
  ('STEPFUN_API_KEY', 'stepfun-step-plan', 'STEPFUN_STEP_PLAN_API_KEY'),
  ('XIAOMI_API_KEY', 'xiaomi-token-plan-ams', 'XIAOMI_TOKEN_PLAN_AMS_API_KEY'),
  ('XIAOMI_API_KEY', 'xiaomi-token-plan-cn', 'XIAOMI_TOKEN_PLAN_CN_API_KEY'),
  ('XIAOMI_API_KEY', 'xiaomi-token-plan-sgp', 'XIAOMI_TOKEN_PLAN_SGP_API_KEY'),
  ('ZHIPU_API_KEY', 'zai-coding-plan', 'ZAI_CODING_PLAN_API_KEY'),
  ('ZHIPU_API_KEY', 'zhipuai', 'ZHIPUAI_API_KEY'),
  ('ZHIPU_API_KEY', 'zhipuai-coding-plan', 'ZHIPUAI_CODING_PLAN_API_KEY');

INSERT INTO kortix.project_secrets
  (project_id, name, identifier, value_enc, scope, owner_user_id, active, created_by,
   created_at, updated_at, strategy, egress_policy, handle_prefix, description, rotated_at,
   strategy_locked, consumer)
SELECT s.project_id, m.own_name, m.own_name, s.value_enc, s.scope, s.owner_user_id, s.active, s.created_by,
       s.created_at, now(), s.strategy, s.egress_policy, s.handle_prefix, s.description, s.rotated_at,
       s.strategy_locked, s.consumer
  FROM kortix.project_secrets s
  JOIN provider_own_key_names m ON m.shared_name = s.name
 WHERE EXISTS (
         SELECT 1 FROM kortix.gateway_request_logs l
          WHERE l.project_id = s.project_id AND l.ok
            AND l.requested_model LIKE m.provider_id || '/%'
            AND l.created_at > now() - interval '120 days')
   AND NOT EXISTS (
         SELECT 1 FROM kortix.project_secrets t
          WHERE t.project_id = s.project_id AND t.name = m.own_name
            AND t.owner_user_id IS NOT DISTINCT FROM s.owner_user_id);

UPDATE kortix.account_secret_resources r
   SET name = m.own_name, updated_at = now()
  FROM provider_own_key_names m
 WHERE r.provider_id = m.provider_id AND r.name = m.shared_name;
