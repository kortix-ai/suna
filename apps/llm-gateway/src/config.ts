import { DEFAULT_MAX_REQUEST_BYTES } from '@kortix/llm-gateway';
import { hydrateEnvironmentSecret } from '@kortix/shared';

hydrateEnvironmentSecret();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function requiredApiToken(): string {
  const value = process.env.GATEWAY_INTERNAL_TOKEN || process.env.GATEWAY_API_TOKEN;
  if (!value) throw new Error('GATEWAY_INTERNAL_TOKEN (or GATEWAY_API_TOKEN) is required');
  return value;
}

export const config = {
  port: optionalInt('PORT', 8090),
  apiUrl: required('KORTIX_API_URL'),
  apiToken: requiredApiToken(),
  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST,
  },
  captureBodies: flag('GATEWAY_CAPTURE_BODIES', true),
  // Default: 8 MiB. This accepts the measured 2,023,225-byte Aster request and
  // rejects accidental/untrusted oversized payloads before upstream dispatch.
  maxRequestBytes: optionalInt('GATEWAY_MAX_REQUEST_BYTES', DEFAULT_MAX_REQUEST_BYTES),
  // 0/unset uses the default first-byte COMMIT deadline (30s). Exceeding it no
  // longer fails a request — it hands the stream to the relay, which heartbeats
  // downstream while the model works. A positive value is an exact operator
  // override. See PROBE_COMMIT_DEADLINE_MS in @kortix/llm-gateway.
  streamProbeTimeoutMs: optionalInt('GATEWAY_STREAM_PROBE_TIMEOUT_MS', 0),
  retry: {
    // ONE in-request transport attempt — no gateway-side replay of a failed
    // dispatch. OpenCode 1.18.17 owns transport retry now and does it strictly
    // better: 5 attempts, 2s→30s exponential backoff with 25% jitter, and it
    // honours `Retry-After`. This layer used to add 3 attempts at 300ms→8s on
    // top, so a rate-limited or 5xx upstream got 15 total replays of the full
    // prompt with the first three effectively un-backed-off.
    //
    // This does NOT weaken the two retry behaviours that are not transport
    // retries and do not read this value:
    //   - 402/403/429 quota failover onto the next candidate — failover.ts's
    //     LIMIT_STATUSES loop, driven by the candidate list.
    //   - empty-200-completion retry — handler.ts's
    //     MAX_INVALID_COMPLETION_ATTEMPTS_PER_CANDIDATE (3 per candidate).
    // Both are covered by tests in packages/llm-gateway.
    maxAttempts: optionalInt('GATEWAY_RETRY_MAX_ATTEMPTS', 1),
    baseDelayMs: optionalInt('GATEWAY_RETRY_BASE_MS', 300),
    maxDelayMs: optionalInt('GATEWAY_RETRY_MAX_MS', 8_000),
    // 90 minutes. Bounds time-to-headers when streaming, and the full
    // completion when not — see DEFAULTS in resilience/retry.ts.
    timeoutMs: optionalInt('GATEWAY_UPSTREAM_TIMEOUT_MS', 90 * 60_000),
  },
  breaker: {
    failureThreshold: optionalInt('GATEWAY_BREAKER_THRESHOLD', 5),
    cooldownMs: optionalInt('GATEWAY_BREAKER_COOLDOWN_MS', 30_000),
  },
};
