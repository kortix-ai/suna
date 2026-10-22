import type { ModelFallbackPolicy } from '@kortix/llm-gateway';
import { z } from '@hono/zod-openapi';

const fallbackPolicySchema = z.object({
  id: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
  fallbackModels: z.array(z.string().min(1)),
  fallbackOn: z.enum(['transient', 'any-error']),
});

const fallbackPoliciesSchema = z.array(fallbackPolicySchema).superRefine((policies, ctx) => {
  const owners = new Map<string, string>();
  for (const policy of policies) {
    for (const model of policy.models) {
      const owner = owners.get(model);
      if (owner) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `model "${model}" is owned by both "${owner}" and "${policy.id}"`,
        });
      } else {
        owners.set(model, policy.id);
      }
    }
  }
});

/** No operator policy by default: the managed fallbacks derive from the lineup. */
export const DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES = '[]';

/** The ChatGPT-account default degrades to the managed lineup when it fails. */
export const CODEX_DEFAULT_MODEL = 'codex/gpt-5.6-sol';

/**
 * Fallbacks for the managed lineup, derived from it (never hardcoded ids):
 * each served model falls back to the others in Platinum's order, and the
 * ChatGPT-account default falls back to all of them. An operator policy
 * (LLM_GATEWAY_FALLBACK_POLICIES) that already owns a model wins.
 */
export function effectiveFallbackPolicies(
  operator: readonly ModelFallbackPolicy[],
  servedIds: readonly string[],
): ModelFallbackPolicy[] {
  const owned = new Set(operator.flatMap((policy) => policy.models));
  const derived: ModelFallbackPolicy[] = servedIds.length > 1
    ? servedIds.filter((id) => !owned.has(id)).map((id) => ({
      id: `managed-${id}`, models: [id], fallbackModels: servedIds.filter((other) => other !== id), fallbackOn: 'transient' as const,
    }))
    : [];
  if (servedIds.length && !owned.has(CODEX_DEFAULT_MODEL)) {
    derived.push({ id: 'codex-default-degrade', models: [CODEX_DEFAULT_MODEL], fallbackModels: [...servedIds], fallbackOn: 'any-error' });
  }
  return [...operator, ...derived];
}

/** Parse the operator-owned declarative route policy without importing API config. */
export function parseFallbackPolicies(raw: string): ModelFallbackPolicy[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = fallbackPoliciesSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}
