import { config } from '../../config';

export interface JustAvpsReadinessProbeInput {
  slug?: string;
  proxyToken?: string;
  serviceKey?: string;
}

export interface SandboxReadinessResult {
  ready: boolean;
  message: string;
  httpStatus?: number;
}

const PROBE_TIMEOUT_MS = 8_000;

/**
 * Probe sandbox readiness through the provider proxy only.
 *
 * Do not use the API preview proxy here: /v1/p/:id only resolves active
 * sandboxes, while this poller intentionally runs while rows are still
 * provisioning. Probing that route produces guaranteed 404s and noisy logs.
 */
export async function probeJustAvpsSandboxReadiness(
  input: JustAvpsReadinessProbeInput,
): Promise<SandboxReadinessResult> {
  if (!input.slug) {
    return { ready: false, message: 'Sandbox slug missing' };
  }

  return probeCfProxy(input);
}

async function probeCfProxy(input: JustAvpsReadinessProbeInput): Promise<SandboxReadinessResult> {
  if (!input.slug) {
    return { ready: false, message: 'Sandbox slug missing' };
  }

  const headers: Record<string, string> = {};
  if (input.proxyToken) headers['X-Proxy-Token'] = input.proxyToken;
  if (input.serviceKey || config.INTERNAL_SERVICE_KEY) {
    headers.Authorization = `Bearer ${input.serviceKey || config.INTERNAL_SERVICE_KEY}`;
  }

  try {
    const res = await fetch(`https://8000--${input.slug}.${config.JUSTAVPS_PROXY_DOMAIN}/kortix/health`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.status === 200) {
      return { ready: true, message: 'Sandbox services are ready', httpStatus: 200 };
    }

    if (res.status === 503) {
      return { ready: false, message: 'Sandbox container is up but still starting', httpStatus: 503 };
    }

    return { ready: false, message: `Sandbox health probe returned ${res.status}`, httpStatus: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ready: false, message: `Sandbox health probe failed: ${message}` };
  }
}
