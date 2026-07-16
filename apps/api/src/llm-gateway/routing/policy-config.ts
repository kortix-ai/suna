import type { ModelFallbackPolicy } from '@kortix/llm-gateway';
import { z } from 'zod';

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

export const DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES = JSON.stringify([
  {
    id: 'platform-default-degrade',
    models: ['codex/gpt-5.6-sol'],
    fallbackModels: ['glm-5.2'],
    fallbackOn: 'any-error',
  },
]);

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
