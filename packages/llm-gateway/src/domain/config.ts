import type { CircuitBreakerOptions, RetryOptions } from '../resilience';

// A stateless LiteLLM proxy sitting beneath the eligible transports
// (openai-compat/custom — see transports/sidecar.ts), used purely to
// translate provider param quirks (e.g. OpenAI's max_tokens ->
// max_completion_tokens) via LiteLLM's community-maintained tables instead of
// hand-rolled per-quirk code here. It owns no credentials, no model_list, no
// DB, and no retries of its own (config.yaml sets num_retries: 0) — this
// package's own failover/circuit-breaker stays the only retry brain. Every
// request carries the resolved upstream's api_key/api_base per-request (see
// buildSidecarRequest); `authToken` is the sidecar's OWN master-key auth
// (LiteLLM's `general_settings.master_key`), never the upstream provider key.
export interface TranslationSidecarConfig {
  /** Base URL of the sidecar, e.g. http://litellm:4000 (no trailing slash required). */
  url: string;
  /** Bearer token for the sidecar's own auth gate. Omit only if the sidecar truly has no master key configured (not recommended — see the PR's security note). */
  authToken?: string;
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
  /** Maximum number of fallback models after the primary. Defaults to 3, hard-capped at 8. */
  maxFallbackModels?: number;
  /**
   * When set, eligible upstream candidates (openai-compat/custom — anthropic/
   * bedrock/codex keep their dedicated transports untouched) route through
   * this stateless LiteLLM translation sidecar instead of calling the
   * upstream directly. Unset (the default) preserves the current direct
   * behavior — required for old self-host boxes and a gradual rollout.
   */
  translationSidecar?: TranslationSidecarConfig;
  // Which transport engine executes upstream calls. 'native' (default) uses the
  // hand-written per-provider transports (optionally fronted by the translation
  // sidecar above). 'ai-sdk' routes replaceable providers (openai-compat /
  // anthropic / bedrock) through the Vercel AI SDK provider packages, which own
  // the provider quirks, adapting the result back to the same OpenAI-compatible
  // /v1/llm contract. Codex (openai-responses) always stays native. Flag-gated
  // for a proven, staged rollout and, ultimately, retiring the LiteLLM sidecar.
  transportEngine?: 'native' | 'ai-sdk';
}
