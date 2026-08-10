export interface TargetSmokeConfig {
  apiUrl: string;
  webUrl: string;
  gatewayUrl: string;
  expectedSha: string;
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

  const expectedSha = environment.KE2E_EXPECT_SHA?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error('KE2E_EXPECT_SHA must contain the 40-character staging source SHA');
  }

  return {
    apiUrl: api.toString().replace(/\/$/, ''),
    webUrl: web.toString().replace(/\/$/, ''),
    gatewayUrl: gateway.toString().replace(/\/$/, ''),
    expectedSha,
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
  if (api.status !== 'ok' || api.environment !== 'staging') {
    throw new Error(`staging API health contract failed: ${JSON.stringify(api)}`);
  }
  if (gateway.status !== 'healthy') {
    throw new Error(`staging gateway health contract failed: ${JSON.stringify(gateway)}`);
  }
  if (api.commit !== config.expectedSha || gateway.commit !== config.expectedSha) {
    throw new Error(
      `staging SHA mismatch: expected=${config.expectedSha} api=${api.commit ?? 'missing'} gateway=${gateway.commit ?? 'missing'}`,
    );
  }
}
