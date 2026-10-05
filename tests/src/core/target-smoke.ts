import {
  deploymentBypassRequestHeaders,
  deploymentBypassSecret,
} from '../../e2e/helpers/deployment-bypass';

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

/** `apps/web/src/app/(system)/api/health/route.ts`. */
interface FrontendHealth {
  status?: string;
  service?: string;
  version?: string;
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

/**
 * Read the FRONTEND's own commit from the origin the browser shards drive.
 *
 * The frontend is a third deployment surface with its own release pipeline, and
 * until 2026-09-18 the preflight did not look at it at all. Staging web is a
 * Vercel deployment aliased by `deploy-staging.yml` (`vercel alias set …
 * staging.kortix.com`); Vercel swaps an alias atomically, so the host serves the
 * PREVIOUS release's frontend until the new build reaches READY. The API and the
 * gateway roll on ECS on a completely different clock.
 *
 * Measured on the v0.13.25 gate (release run 35392201088, PR #7422,
 * RELEASE_SOURCE_SHA=8a1e38dc97ba76ae2aba7fe9c7cce284fa05af23):
 *
 *   deploy-staging 35391030403 "Deploy staging web to Vercel"  started 20:32:06Z
 *   Vercel dpl_ZWu71zWXoWKvwGBr9uCs17FVu7Ha (sha 8a1e38dc)      created 20:32:38Z
 *   release-gate browser shards 1..3                            started 20:36:16Z
 *   that deployment was still INITIALIZING at                            20:42Z
 *   staging.kortix.com was aliased to dpl_43b4… from 05:22Z (sha fa68c114)
 *
 * So the shards drove a frontend 15 hours and many commits behind the release
 * while api and gateway both reported the release SHA. A shard that fails there
 * fails for a reason with no relation to the code under test, and the two-surface
 * assertion could not see it. Hence: assert the frontend too, and FAIL FAST — no
 * wait loop, because a stale alias is a deploy problem for a human to resolve,
 * not something a preflight should sit and hope out.
 *
 * Deployment protection: staging sits behind Vercel SSO
 * (`ssoProtection.deploymentType = prod_deployment_urls_and_all_previews`), so an
 * unauthenticated read 302s to `vercel.com/sso-api`. The bypass secret the
 * browser lane already receives (`VERCEL_AUTOMATION_BYPASS_SECRET`, set at the
 * `tests-release.yml` workflow env level) authorises this one request. `redirect:
 * 'manual'` keeps an SSO wall reportable instead of letting `response.json()`
 * die on an HTML login page.
 */
async function frontendHealthJson(
  config: TargetSmokeConfig,
  fetchImpl: typeof fetch,
): Promise<FrontendHealth> {
  const url = `${config.webUrl}/api/health`;
  const secret = deploymentBypassSecret();
  const response = await fetchImpl(url, {
    headers: secret ? deploymentBypassRequestHeaders(secret) : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '(no location header)';
    throw new Error(
      `${url} returned ${response.status} -> ${location} instead of its health JSON. ` +
        'Vercel deployment protection blocked the read. ' +
        (secret
          ? 'VERCEL_AUTOMATION_BYPASS_SECRET is set but did not authorise it — the secret is ' +
            'likely rotated or scoped to another project.'
          : 'VERCEL_AUTOMATION_BYPASS_SECRET is not set for this step, so the frontend SHA ' +
            'cannot be read at all.'),
    );
  }
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<FrontendHealth>;
}

export async function assertTargetSmokeHealth(
  config: TargetSmokeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const [api, gateway, frontend] = await Promise.all([
    healthJson<ApiHealth>(`${config.apiUrl}/health`, fetchImpl),
    healthJson<GatewayHealth>(`${config.gatewayUrl}/health`, fetchImpl),
    frontendHealthJson(config, fetchImpl),
  ]);
  if (api.status !== 'ok' || api.environment !== config.environment) {
    throw new Error(`${config.environment} API health contract failed: ${JSON.stringify(api)}`);
  }
  assertGatewayPreflightHealth(gateway);
  if (frontend.status !== 'ok' || frontend.service !== 'web') {
    throw new Error(
      `${config.environment} frontend health contract failed: ${JSON.stringify(frontend)}`,
    );
  }
  // An unstamped build is a DIFFERENT defect from a stale deploy, and reporting
  // it as a mismatch sends a human looking at the deploy clock for a problem
  // that lives in the build. `apps/web/next.config.ts` resolves the commit from
  // NEXT_PUBLIC_KORTIX_COMMIT, then VERCEL_GIT_COMMIT_SHA, then the literal
  // 'unknown'; reaching that literal means the gate has nothing to compare and
  // must say so in its own words.
  if (!frontend.commit || frontend.commit === 'unknown') {
    throw new Error(
      `${config.environment} frontend did not stamp a commit: ${config.webUrl}/api/health ` +
        `reports commit=${frontend.commit ?? 'missing'}. The frontend build received neither ` +
        'NEXT_PUBLIC_KORTIX_COMMIT nor a VERCEL_GIT_COMMIT_SHA fallback, so its deployed SHA ' +
        'cannot be compared to the release SHA. This is a broken frontend BUILD, not a stale ' +
        'deploy — fix the stamping in the workflow that built it.',
    );
  }
  if (
    api.commit !== config.expectedSha ||
    gateway.commit !== config.expectedSha ||
    frontend.commit !== config.expectedSha
  ) {
    throw new Error(
      `${config.environment} SHA mismatch: expected=${config.expectedSha} api=${api.commit ?? 'missing'} gateway=${gateway.commit ?? 'missing'} frontend=${frontend.commit ?? 'missing'}`,
    );
  }
}
