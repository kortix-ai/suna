/**
 * Client release policy — `GET /v1/clients/mobile`.
 *
 * Public (no token): a mobile build reads it before the user signs in, to
 * learn whether the operator has raised the minimum supported app version.
 * The schema is `MobileClientPolicySchema` in `@kortix/api-contract`.
 */
import { ApiError } from '../../http/api/errors';
import { platformConfig } from '../../http/config';
import { platformApiBase } from './shared';
import type { AuthRequestOptions } from './auth';

/** What the operator set. A null `minimum_version` means no gate; a null store URL means no update button. */
export interface MobileClientPolicy {
  minimum_version: string | null;
  store_url_ios: string | null;
  store_url_android: string | null;
}

/**
 * Read the mobile release policy without a token. A non-200 answer throws an
 * `ApiError` carrying the status. The caller decides what a failure means: the
 * mobile gate fails open.
 */
export async function getMobileClientPolicy(opts?: AuthRequestOptions): Promise<MobileClientPolicy> {
  const fetchImpl =
    opts?.fetch ?? platformConfig().fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const backendUrl = opts?.backendUrl ?? platformConfig().backendUrl;
  const res = await fetchImpl(`${platformApiBase(backendUrl)}/clients/mobile`, {
    headers: { accept: 'application/json' },
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    throw new ApiError(`Mobile client policy request failed (HTTP ${res.status})`, { status: res.status, response: res });
  }
  return (await res.json()) as MobileClientPolicy;
}

const SEMVER = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i;

/**
 * Compare two `major.minor.patch` versions: -1 when `a` is older, 0 when equal,
 * 1 when newer. A leading "v" is allowed, a missing minor or patch counts as 0,
 * and a prerelease or build suffix (`-beta.2`, `+7`) is ignored. Returns null
 * when either side does not parse, so a caller can fail open.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const parts = (v: string) => {
    const m = SEMVER.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
  };
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  return 0;
}
