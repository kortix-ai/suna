import {
  getManagedModel,
  pickAutoModel,
  type ManagedModel,
} from '@kortix/shared/llm-catalog';

// Slim managed-model routing for the `kortix` opencode provider.
//
// Three managed upstreams (LOCKED, llm-native spec §2/§7): Bedrock for managed
// Claude, OpenCode Zen for the curated free models, OpenRouter for the rest. A
// model id maps to exactly one upstream — a simple switch, no failover / breaker
// / resilience / transport registry.
//
// Pure + config-free (depends only on the static managed catalog) so the
// upstream decision is unit-testable in isolation.

export interface ManagedRoute {
  /** Which managed upstream carries this request. */
  upstream: 'bedrock' | 'zen' | 'openrouter';
  /** The managed catalog entry, or null for a non-managed (legacy passthrough) id. */
  managed: ManagedModel | null;
  /** The model id to send to the upstream (Bedrock id / Zen id / OpenRouter slug). */
  wireModel: string;
  /** The model id to record + bill as (the resolved concrete managed id). */
  billingModel: string;
}

/**
 * Resolve a requested model id to its managed upstream. THE upstream decision for
 * the slim endpoint:
 *   - synthetic `auto` is first resolved to a concrete managed model (Fusion, or a
 *     vision model when the request carries images) and billed as that model;
 *   - a managed model with `transport === 'bedrock'` (Claude) → Bedrock InvokeModel;
 *   - a managed model with `transport === 'opencode-zen'` (free) → OpenCode Zen
 *     (no auth, never metered — billingMode none);
 *   - every other managed model (and any unknown/legacy id) → OpenRouter.
 */
export function resolveManagedRoute(
  modelId: string,
  body: Record<string, unknown> = {},
): ManagedRoute {
  // `auto` is synthetic — resolve it to a concrete managed model id up front.
  const resolvedId = pickAutoModel(modelId, body) ?? modelId;
  const managed = getManagedModel(resolvedId) ?? null;

  if (managed?.transport === 'bedrock') {
    return {
      upstream: 'bedrock',
      managed,
      wireModel: managed.upstreamModelId,
      billingModel: managed.id,
    };
  }

  if (managed?.transport === 'opencode-zen') {
    return {
      upstream: 'zen',
      managed,
      wireModel: managed.upstreamModelId,
      billingModel: managed.id,
    };
  }

  return {
    upstream: 'openrouter',
    managed,
    // Managed OpenRouter models carry an explicit upstream slug (e.g. `openrouter/fusion`)
    // that must be forwarded verbatim; a legacy/non-managed id passes through as-is.
    wireModel: managed?.upstreamModelId ?? resolvedId,
    billingModel: managed?.id ?? resolvedId,
  };
}
