import type { CircuitBreakerOptions, RetryOptions } from '../resilience';

/** Allows proven 2 MiB prompts while bounding accidental/untrusted payloads. */
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export interface GatewayConfig {
  retry?: RetryOptions;
  breaker?: CircuitBreakerOptions;
  captureBodies?: boolean;
  maxCapturedBodyBytes?: number;
  // Hard ceiling on the raw request body size (bytes). Unset/0 disables the check.
  // Hosts should use DEFAULT_MAX_REQUEST_BYTES unless they have a measured reason
  // to choose another ceiling. When set, over-limit requests are rejected with a 413
  // instead of being dispatched to an upstream that may silently drop them.
  maxRequestBytes?: number;
  /** Maximum number of fallback models after the primary. Defaults to 3, hard-capped at 8. */
  maxFallbackModels?: number;
  /**
   * Maximum silence while probing a newly opened streaming response.
   * The gateway cancels the stalled candidate and tries the next model.
   * Exact operator override. Omit it to use the prompt-size/provider-aware
   * adaptive policy (30 seconds to 2 minutes).
   */
  streamProbeTimeoutMs?: number;
}
