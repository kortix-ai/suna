import type { CircuitBreakerOptions, RetryOptions } from '../resilience';

export interface GatewayConfig {
  retry?: RetryOptions;
  breaker?: CircuitBreakerOptions;
  injectReasoningFor?: (model: string) => boolean;
  captureBodies?: boolean;
  maxCapturedBodyBytes?: number;
}
