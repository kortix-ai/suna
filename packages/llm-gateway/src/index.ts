export { createGateway } from './create-gateway';
export type { ChatCompletionRequest, GatewayDeps } from './pipeline';

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
  BreakerSignalStore,
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

export { resolveCatalogUpstream, OPENAI_COMPATIBLE_NPM, providerKindForNpm } from './catalog';
export type { CatalogUpstream } from './catalog';

export type {
  AuthedPrincipal,
  AuthorizeResult,
  BillingMode,
  GatewayConfig,
  GatewayHooks,
  GatewayLogger,
  GatewayTrace,
  ModelCatalog,
  ModelInfo,
  ProviderKind,
  TokenCounts,
  UpstreamDescriptor,
  UsageEvent,
} from './domain';
