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
  /** Applied only to fields the incoming request body doesn't already set —
   *  see `applyGenerationDefaults`. Keyed to `primaryModel` (fallback
   *  candidates run through their OWN descriptor's capabilities via the
   *  transport, unaffected by this — see the doc comment above). */
  generationDefaults?: ModelGenerationDefaults;
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
