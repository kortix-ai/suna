export { createGateway } from './create-gateway';
export type { ChatCompletionRequest, GatewayDeps } from './pipeline';
export { gatewayErrorBody, gatewayErrorResponse } from './pipeline/error-response';
export type { GatewayErrorContext } from './pipeline/error-response';

export { callUpstream } from './http';
export type { CallUpstreamOptions, FetchImpl } from './http';

export {
  CircuitBreaker,
  withResilience,
  withRetry,
  backoffDelay,
  realSleep,
} from './resilience';
export type {
  BreakerBinding,
  BreakerState,
  CircuitBreakerOptions,
  RetryOptions,
  SleepFn,
} from './resilience';

export {
  CircuitOpenError,
  NetworkError,
  TimeoutError,
  UpstreamHttpError,
  defaultIsRetryable,
  indicatesUpstreamDown,
} from './errors';
export type { UpstreamErrorKind } from './errors';

export { calculateCost } from './usage';
export type { CostBreakdown, TokenUsage } from './usage';

export { extractUsageFromJson, extractUsageFromSseBuffer } from './usage';
export type { ExtractedUsage } from './usage';

export { buildUpstreamRequest } from './transports';
export type { UpstreamRequest } from './transports';

export { createModelFallbackPolicyEngine } from './routing';
export type { ModelFallbackPolicyEngine } from './routing';

export { OPENAI_COMPATIBLE_NPM, providerKindForNpm } from './catalog';

export type {
  AuthedPrincipal,
  AuthorizeResult,
  BillingMode,
  GatewayConfig,
  GatewayHooks,
  GatewayLogger,
  GatewayTrace,
  ModelFallbackCondition,
  ModelFallbackPolicy,
  ModelFallbackPolicyMatch,
  ModelRouteInput,
  ModelRoutePlan,
  ModelCatalog,
  ModelInfo,
  ProviderKind,
  TokenCounts,
  UpstreamDescriptor,
  UsageEvent,
} from './domain';
