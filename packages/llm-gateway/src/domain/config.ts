import type { CircuitBreakerOptions, RetryOptions } from '../resilience';
import type { AuthedPrincipal } from './principal';

export type ModelFallbackCondition = 'transient' | 'any-error';

export interface ModelFallbackRoute {
  /** Ordered model ids attempted after the routed primary. Duplicates are removed. */
  fallbackModels: readonly string[];
  /** `transient` preserves normal 4xx behavior; `any-error` also falls back on upstream 4xx. */
  fallbackOn?: ModelFallbackCondition;
}

export interface GatewayConfig {
  retry?: RetryOptions;
  breaker?: CircuitBreakerOptions;
  captureBodies?: boolean;
  maxCapturedBodyBytes?: number;
  // Hard ceiling on the raw request body size (bytes). Unset/0 disables the check
  // (the default). When set, over-limit requests are rejected up front with a 413
  // instead of being dispatched to an upstream that may silently drop them.
  maxRequestBytes?: number;
  // Optional host-supplied router for synthetic models (e.g. "auto"): given the
  // requested model + parsed body + the authenticated principal, return a
  // concrete model id to route to, or null to use the requested model unchanged.
  // Kept generic — the host owns the model names and policy. Runs in-process
  // (pure/local, no I/O); the principal carries any signal it needs (e.g. `tier`
  // and the resolved `defaultModel` the host attached at authentication).
  autoRouter?: (
    model: string,
    body: Record<string, unknown>,
    principal: AuthedPrincipal,
  ) => string | null;
  // Optional model-to-model router. It runs after autoRouter and returns a
  // finite ordered fallback chain. The handler de-duplicates the chain and
  // enforces maxFallbackModels, so a bad policy cannot recurse or retry forever.
  modelFallbackRouter?: (
    model: string,
    body: Record<string, unknown>,
    principal: AuthedPrincipal,
  ) => ModelFallbackRoute | null;
  /** Maximum number of fallback models after the primary. Defaults to 3, hard-capped at 8. */
  maxFallbackModels?: number;
}
