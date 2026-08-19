import type { CircuitBreakerOptions, RetryOptions } from '../resilience';

// The gateway must NOT be the thing that rejects a real request for being large.
// Multimodal agent turns carrying many base64 images plus long history routinely
// run tens of MiB (measured: 9-12 MiB turns on self-host 413'd at the old 8 MiB
// ceiling), and there is no reason to cap below what the upstream itself accepts —
// let the upstream enforce its own real limit. This ceiling exists ONLY as a last
// backstop against a truly runaway payload OOMing the gateway, so set it 1 GiB:
// far above any legitimate request, so image-heavy turns just work. Hosts can
// override with GATEWAY_MAX_REQUEST_BYTES (0 disables the check entirely).
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024 * 1024;

export interface GatewayConfig {
  retry?: RetryOptions;
  breaker?: CircuitBreakerOptions;
  captureBodies?: boolean;
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
  /**
   * Enable the AI-SDK-native ingress (`POST /language-model`, Vercel "AI
   * Gateway" protocol). Default OFF. When false, `createGateway().languageModel`
   * returns 404 and the route is inert — the OpenAI-compat `/chat/completions`
   * path is completely unaffected. Set from `GATEWAY_AI_SDK_NATIVE` in the
   * standalone server (apps/llm-gateway/src/config.ts).
   */
  aiSdkNative?: boolean;
}
