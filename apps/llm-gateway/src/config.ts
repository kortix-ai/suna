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
  maxCapturedBodyBytes: optionalInt('GATEWAY_MAX_CAPTURED_BODY_BYTES', 256 * 1024),
  // 0 = disabled. Set to a byte ceiling (e.g. 1048576 for 1 MiB) to reject
  // oversized requests with a 413 before they reach an upstream.
  maxRequestBytes: optionalInt('GATEWAY_MAX_REQUEST_BYTES', 0),
  retry: {
    maxAttempts: optionalInt('GATEWAY_RETRY_MAX_ATTEMPTS', 3),
    baseDelayMs: optionalInt('GATEWAY_RETRY_BASE_MS', 300),
    maxDelayMs: optionalInt('GATEWAY_RETRY_MAX_MS', 8_000),
    timeoutMs: optionalInt('GATEWAY_UPSTREAM_TIMEOUT_MS', 120_000),
  },
  breaker: {
    failureThreshold: optionalInt('GATEWAY_BREAKER_THRESHOLD', 5),
    cooldownMs: optionalInt('GATEWAY_BREAKER_COOLDOWN_MS', 30_000),
  },
  // Stateless LiteLLM translation sidecar — see packages/llm-gateway's
  // GatewayConfig.translationSidecar. Unset in cloud today: this standalone
  // pod is the sandbox-facing gateway in EKS/ECS (LLM_GATEWAY_BASE_URL), so
  // turning this on is a deliberate ops step (task-def/pod env addition), not
  // part of this change — see the PR's cloud-rollout note. Wired here now so
  // that follow-up is a one-line env addition, not a code change.
  translationSidecar: process.env.LLM_TRANSLATION_SIDECAR_URL
    ? {
        url: process.env.LLM_TRANSLATION_SIDECAR_URL,
        authToken: process.env.LLM_TRANSLATION_SIDECAR_AUTH_TOKEN || undefined,
      }
    : undefined,
};
