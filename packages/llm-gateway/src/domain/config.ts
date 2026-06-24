import type { CircuitBreakerOptions, RetryOptions } from '../resilience';

export interface GatewayConfig {
  retry?: RetryOptions;
  breaker?: CircuitBreakerOptions;
  captureBodies?: boolean;
  maxCapturedBodyBytes?: number;
  // Optional host-supplied router for synthetic models (e.g. "auto"): given the
  // requested model + parsed body, return a concrete model id to route to, or
  // null to use the requested model unchanged. Kept generic — the host owns the
  // model names and policy. Runs in-process (pure/local, no I/O).
  autoRouter?: (model: string, body: Record<string, unknown>) => string | null;
}
