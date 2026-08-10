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

interface GatewayHealth {
  status?: string;
  commit?: string;
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
  if (gateway.status !== 'healthy') {
    throw new Error(`staging gateway health contract failed: ${JSON.stringify(gateway)}`);
  }
  if (api.commit !== config.expectedSha || gateway.commit !== config.expectedSha) {
    throw new Error(
      `${config.environment} SHA mismatch: expected=${config.expectedSha} api=${api.commit ?? 'missing'} gateway=${gateway.commit ?? 'missing'}`,
    );
  }
}
