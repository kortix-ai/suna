import type { CircuitBreakerOptions, RetryOptions } from '../resilience';

// The gateway must NOT be the thing that rejects a real request for being large.
// Multimodal agent turns carrying many base64 images plus long history routinely
// run tens of MiB (measured: 9-12 MiB turns on self-host 413'd at the old 8 MiB
// ceiling), so this must sit comfortably above them. 128 MiB is ~10x the largest
// turn ever measured.
//
// It was 1 GiB, chosen as "far above any legitimate request" on the reasoning
// that the ceiling was only a last backstop against a runaway payload. That
// reasoning had a hole: a backstop larger than the container it protects is not
// a backstop. The process serving this is capped at 1024 MiB on dev and 640 MiB
// on self-host, so a single "permitted" request could exceed all the memory
// there was — and on 2026-08-21 the dev API was OOM-killed three times in
// eleven minutes, handing browsers Cloudflare's "Bad Gateway" page.
//
// The rule this encodes: a request-size ceiling is only meaningful as a
// FRACTION of the memory the process has. Anything at or above 100% is
// decoration. Hosts can override with GATEWAY_MAX_REQUEST_BYTES (0 disables the
// check entirely) — a host with more memory may safely raise it.
export const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024 * 1024;

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
}
