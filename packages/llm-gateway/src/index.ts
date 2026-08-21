export { createGateway } from './create-gateway';
export { DEFAULT_MAX_REQUEST_BYTES } from './domain/config';
export {
  gatewayOverloadedResponse,
  readBoundedBody,
  requestTooLargeResponse,
} from './pipeline/read-bounded-body';
export {
  DEFAULT_BODY_AMPLIFICATION,
  DEFAULT_INFLIGHT_BUDGET_BYTES,
  InflightBudget,
} from './pipeline/inflight-budget';
export type { InflightBudgetOptions, InflightLease } from './pipeline/inflight-budget';
export type { BoundedBodyResult } from './pipeline/read-bounded-body';
export type { ChatCompletionRequest, GatewayDeps } from './pipeline';
export {
  MAX_RELAYED_RETRY_AFTER_SECONDS,
  clampRetryAfterSeconds,
  gatewayErrorBody,
  gatewayErrorResponse,
} from './pipeline/error-response';
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
  GatewayResolutionError,
  NetworkError,
  TimeoutError,
  UpstreamHttpError,
  defaultIsRetryable,
  indicatesUpstreamDown,
  looksLikeTerminalAuthFailure,
} from './errors';
export type { NoUpstreamReasonCode, UpstreamErrorKind } from './errors';

export { calculateCost } from './usage';
export type { CostBreakdown, TokenUsage } from './usage';

export { extractUsageFromJson, extractUsageFromSseBuffer } from './usage';
export type { ExtractedUsage } from './usage';

export {
  anthropicMessagesToChat,
  chatJsonToAnthropicMessage,
  chatSseToAnthropicSse,
} from './ingress/anthropic-messages';
export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
} from './ingress/anthropic-messages';

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
  GatewayAttemptFailure,
  GatewayAttemptFailureStage,
  ListModelsOptions,
  ModelFallbackCondition,
  ModelFallbackPolicy,
  ModelFallbackPolicyMatch,
  ModelGenerationDefaults,
  ModelRouteInput,
  ModelRoutePlan,
  ModelCatalog,
  ModelInfo,
  ModelReasoningOption,
  ModelCost,
  ModelCostTier,
  ModelModalities,
  ProviderKind,
  TokenCounts,
  UpstreamDescriptor,
  UsageEvent,
} from './domain';
