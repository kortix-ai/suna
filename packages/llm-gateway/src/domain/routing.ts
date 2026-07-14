export type ModelFallbackCondition = 'transient' | 'any-error';

/** Minimal request traits a control plane can use without receiving prompt content. */
export interface ModelRouteInput {
  requestedModel: string;
  requires: {
    imageInput: boolean;
  };
}

/**
 * A finite route selected by the host/control plane. The gateway treats model ids
 * as opaque strings and only enforces ordering, de-duplication, and hard bounds.
 */
export interface ModelRoutePlan {
  policyId: string;
  primaryModel: string;
  fallbackModels?: readonly string[];
  fallbackOn?: ModelFallbackCondition;
}

/** Declarative exact-match fallback policy consumed by the generic policy engine. */
export interface ModelFallbackPolicy {
  id: string;
  models: readonly string[];
  fallbackModels: readonly string[];
  fallbackOn: ModelFallbackCondition;
}

export interface ModelFallbackPolicyMatch {
  policyId: string;
  fallbackModels: readonly string[];
  fallbackOn: ModelFallbackCondition;
}
