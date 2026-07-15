import type { ModelFallbackPolicy, ModelFallbackPolicyMatch } from '../domain/routing';

export interface ModelFallbackPolicyEngine {
  route(model: string): ModelFallbackPolicyMatch | null;
}

/**
 * Compile host-provided declarative policies into an immutable exact-match
 * router. No provider or model names live in the gateway package.
 */
export function createModelFallbackPolicyEngine(
  policies: readonly ModelFallbackPolicy[],
): ModelFallbackPolicyEngine {
  const byModel = new Map<string, ModelFallbackPolicyMatch>();

  for (const policy of policies) {
    const match: ModelFallbackPolicyMatch = {
      policyId: policy.id,
      fallbackModels: [...policy.fallbackModels],
      fallbackOn: policy.fallbackOn,
    };
    for (const model of policy.models) {
      if (byModel.has(model)) {
        throw new Error(`model fallback policy already defined for "${model}"`);
      }
      byModel.set(model, match);
    }
  }

  return {
    route(model: string): ModelFallbackPolicyMatch | null {
      return byModel.get(model) ?? null;
    },
  };
}
