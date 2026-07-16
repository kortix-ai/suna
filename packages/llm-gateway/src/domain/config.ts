import type { CircuitBreakerOptions, RetryOptions } from '../resilience';

export interface GatewayConfig {
  retry?: RetryOptions;
  breaker?: CircuitBreakerOptions;
  captureBodies?: boolean;
  maxCapturedBodyBytes?: number;
  // Hard ceiling on the raw request body size (bytes). Unset/0 disables the check
  // (the default). When set, over-limit requests are rejected up front with a 413
  // instead of being dispatched to an upstream that may silently drop them.
  maxRequestBytes?: number;
  /** Maximum number of fallback models after the primary. Defaults to 3, hard-capped at 8. */
  maxFallbackModels?: number;
}
