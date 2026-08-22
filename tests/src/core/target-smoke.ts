import { log } from './log';

export interface TargetSmokeConfig {
  apiUrl: string;
  webUrl: string;
  gatewayUrl: string;
  expectedSha: string;
  environment: 'staging' | 'preview';
}

interface ApiHealth {
  status?: string;
  environment?: string;
  commit?: string;
}

interface GatewayCheck {
  status?: string;
}

interface GatewayHealth {
  status?: string;
  commit?: string;
  incidents?: string[];
  checks?: {
    api?: GatewayCheck;
    upstreams?: GatewayCheck;
  };
  traffic?: Record<string, unknown>;
}

function normalizedUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use https`);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export function resolveTargetSmokeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TargetSmokeConfig {
  const target = environment.KE2E_TARGET === 'preview' ? 'preview' : 'staging';
  const api = normalizedUrl(
    environment.KE2E_API_URL ?? 'https://staging-api.kortix.com/v1',
    'KE2E_API_URL',
  );
  const web = normalizedUrl(
    environment.E2E_BASE_URL ?? 'https://staging.kortix.com',
    'E2E_BASE_URL',
  );
  const gateway = normalizedUrl(
    environment.KE2E_GATEWAY_URL ?? 'https://gateway-staging.kortix.com',
    'KE2E_GATEWAY_URL',
  );

  const expectedSha = environment.KE2E_EXPECT_SHA?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error('KE2E_EXPECT_SHA must contain the 40-character target source SHA');
  }

  if (target === 'preview') {
    const origin = normalizedUrl(environment.KE2E_PREVIEW_ORIGIN ?? '', 'KE2E_PREVIEW_ORIGIN');
    if (origin.pathname !== '/') {
      throw new Error('preview origin must not contain a path');
    }
    if (environment.KE2E_PREVIEW_AUTHORIZATION !== `approved:${expectedSha}`) {
      throw new Error('preview target requires approval for the exact expected SHA');
    }
    const supabase = normalizedUrl(
      environment.KE2E_SUPABASE_URL ?? '',
      'KE2E_SUPABASE_URL',
    );
    const sameOrigin = [api, web, gateway, supabase].every(
      (candidate) => candidate.origin === origin.origin,
    );
    if (!sameOrigin) throw new Error('preview API, web, gateway, and Supabase must use one origin');
    if (
      api.pathname !== '/v1' ||
      web.pathname !== '/' ||
      gateway.pathname !== '/_gateway' ||
      supabase.pathname !== '/'
    ) {
      throw new Error('preview target uses invalid single-origin paths');
    }
  } else {
    if (api.hostname !== 'staging-api.kortix.com' || api.pathname !== '/v1') {
      throw new Error(`target smoke requires https://staging-api.kortix.com/v1; received ${api}`);
    }
    if (web.hostname !== 'staging.kortix.com' || web.pathname !== '/') {
      throw new Error(`target smoke requires https://staging.kortix.com; received ${web}`);
    }
    if (gateway.hostname !== 'gateway-staging.kortix.com' || gateway.pathname !== '/') {
      throw new Error(
        `target smoke requires https://gateway-staging.kortix.com; received ${gateway}`,
      );
    }
  }

  return {
    apiUrl: api.toString().replace(/\/$/, ''),
    webUrl: web.toString().replace(/\/$/, ''),
    gatewayUrl: gateway.toString().replace(/\/$/, ''),
    expectedSha,
    environment: target,
  };
}

/**
 * The gateway's `status` is NOT a serve-ability signal. `apps/llm-gateway`
 * (`src/server.ts`) reports `degraded` whenever ANY incident is open, and one of
 * those incidents is its own rolling TRAFFIC error rate:
 *
 *   status = !apiCheck.ok ? 'unhealthy' : incidents.length ? 'degraded' : 'healthy'
 *   incidents ⊇ [`error rate ${pct}% over ${window}s`]
 *
 * On run 32240074477 attempt 1 every release-gate shard died in PREFLIGHT with
 * `incidents: ["error rate 100% over 300s"]` while `checks.api.status == 'up'`
 * and no upstream breaker was open. The only traffic in that window came from
 * zombie test sessions holding dead credentials — i.e. the gate refused to start
 * because of the previous gate's garbage.
 *
 * A traffic-derived `degraded` must never block preflight. What actually has to
 * hold is that the gateway can reach the API and no upstream is hard-down.
 * `unhealthy` (which the gateway serves with HTTP 503) still fails.
 */
export function assertGatewayPreflightHealth(
  gateway: GatewayHealth,
  logWarn: (message: string) => void = log.warn,
): void {
  const status = gateway.status;
  if (status !== 'healthy' && status !== 'degraded') {
    throw new Error(`staging gateway health contract failed: ${JSON.stringify(gateway)}`);
  }

  const apiCheck = gateway.checks?.api;
  // `degraded` alone does not say WHY. Without `checks.api` there is no evidence
  // the gateway can reach the API, so a degraded-and-opaque gateway still fails.
  if (status === 'degraded' && apiCheck?.status === undefined) {
    throw new Error(
      `staging gateway is degraded without a checks.api verdict: ${JSON.stringify(gateway)}`,
    );
  }
  if (apiCheck?.status !== undefined && apiCheck.status !== 'up') {
    throw new Error(
      `staging gateway cannot reach the API (checks.api.status=${apiCheck.status}): ${JSON.stringify(gateway)}`,
    );
  }
  const upstreams = gateway.checks?.upstreams;
  if (upstreams?.status === 'down') {
    throw new Error(`staging gateway upstreams are down: ${JSON.stringify(gateway)}`);
  }

  if (status === 'degraded') {
    logWarn(
      'staging gateway reports degraded but is serving: ' +
        `incidents=${JSON.stringify(gateway.incidents ?? [])} ` +
        `traffic=${JSON.stringify(gateway.traffic ?? {})}`,
    );
  }
}

async function healthJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function assertTargetSmokeHealth(
  config: TargetSmokeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const [api, gateway] = await Promise.all([
    healthJson<ApiHealth>(`${config.apiUrl}/health`, fetchImpl),
    healthJson<GatewayHealth>(`${config.gatewayUrl}/health`, fetchImpl),
  ]);
  if (api.status !== 'ok' || api.environment !== config.environment) {
    throw new Error(`${config.environment} API health contract failed: ${JSON.stringify(api)}`);
  }
  assertGatewayPreflightHealth(gateway);
  if (api.commit !== config.expectedSha || gateway.commit !== config.expectedSha) {
    throw new Error(
      `${config.environment} SHA mismatch: expected=${config.expectedSha} api=${api.commit ?? 'missing'} gateway=${gateway.commit ?? 'missing'}`,
    );
  }
}
