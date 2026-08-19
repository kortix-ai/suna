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
  // AI-SDK-native ingress (`POST /language-model`, Vercel "AI Gateway"
  // protocol). Default OFF — the route is inert (404) until enabled.
  aiSdkNative: flag('GATEWAY_AI_SDK_NATIVE', false),
  // Default: 8 MiB. This accepts the measured 2,023,225-byte Aster request and
  // rejects accidental/untrusted oversized payloads before upstream dispatch.
  maxRequestBytes: optionalInt('GATEWAY_MAX_REQUEST_BYTES', DEFAULT_MAX_REQUEST_BYTES),
  // 0/unset uses the default first-byte COMMIT deadline (30s). Exceeding it no
  // longer fails a request — it hands the stream to the relay, which heartbeats
  // downstream while the model works. A positive value is an exact operator
  // override. See PROBE_COMMIT_DEADLINE_MS in @kortix/llm-gateway.
  streamProbeTimeoutMs: optionalInt('GATEWAY_STREAM_PROBE_TIMEOUT_MS', 0),
  retry: {
    maxAttempts: optionalInt('GATEWAY_RETRY_MAX_ATTEMPTS', 3),
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
