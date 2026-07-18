export type ModelFallbackCondition = 'transient' | 'any-error';

/** Minimal request traits a control plane can use without receiving prompt content. */
export interface ModelRouteInput {
  requestedModel: string;
  requires: {
    imageInput: boolean;
  };
}

/**
 * Per-model generation-parameter defaults the host/control plane wants
 * injected into a request that doesn't already specify them (see
 * `applyGenerationDefaults` in `../pipeline/generation-defaults`, the sole
 * consumer). Field NAMES are the gateway's own generic vocabulary, not any
 * one wire format's — `handleChatCompletions` maps each to the OpenAI
 * chat/completions body field its transports (buildAiSdkArgs) already read.
 * The gateway never validates these against model capability — a host that
 * sets a field the resolved model doesn't support is a host bug; see
 * `@kortix/llm-catalog`'s `clampGenerationConfig`, which every host-side
 * writer of this field (apps/api's routing/resolve-route.ts) MUST run
 * values through first.
 */
export interface ModelGenerationDefaults {
  reasoningEffort?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
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
  /** `generationDefaultsForModel(primaryModel)` — kept for callers/tests that
   *  only care about the primary model. The actual dispatch loop
   *  (`runFailover`) does NOT trust this for fallback candidates; it
   *  re-derives fresh, per-candidate defaults via `generationDefaultsForModel`
   *  below, because a failover candidate can have different capabilities
   *  (temperature support, reasoning_options, output-token ceiling) than
   *  `primaryModel`. */
  generationDefaults?: ModelGenerationDefaults;
  /**
   * Re-derive `ModelGenerationDefaults` for an ARBITRARY model, not just
   * `primaryModel` — called once per candidate inside the failover loop
   * (`runFailover`) so a turn that fails over to a fallback model gets that
   * model's OWN clamped defaults instead of the primary model's stale,
   * unrevalidated ones (e.g. injecting `temperature` into a request that's
   * about to hit a temperature:false fallback, or a `reasoning_effort` the
   * fallback's `reasoning_options` doesn't list). The host/control plane
   * supplies this (apps/api's routing/resolve-route.ts); the gateway itself
   * has no catalog/capability knowledge of its own. Optional so a host or
   * test that doesn't configure generation defaults at all can omit it.
   */
  generationDefaultsForModel?: (model: string) => ModelGenerationDefaults | undefined;
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
