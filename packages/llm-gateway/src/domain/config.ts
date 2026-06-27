import type { CircuitBreakerOptions, RetryOptions } from '../resilience';
import type { AuthedPrincipal } from './principal';

export interface GatewayConfig {
  retry?: RetryOptions;
  breaker?: CircuitBreakerOptions;
  captureBodies?: boolean;
  maxCapturedBodyBytes?: number;
  // Optional host-supplied router for synthetic models (e.g. "auto"): given the
  // requested model + parsed body + the authenticated principal, return a
  // concrete model id to route to, or null to use the requested model unchanged.
  // Kept generic — the host owns the model names and policy. Runs in-process
  // (pure/local, no I/O); the principal carries any tier signal it needs.
  autoRouter?: (
    model: string,
    body: Record<string, unknown>,
    principal: AuthedPrincipal,
  ) => string | null;
}
