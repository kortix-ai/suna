import { authenticatedFetch } from '../http/auth';
import { getCurrentRuntimeUrl } from '../session/current-runtime';

/**
 * Read one `/kortix/opencode/*` daemon endpoint for the CURRENT runtime.
 *
 * The web client speaks only the `/kortix/*` surface — never a raw OpenCode
 * route (`/session`, `/vcs/diff`, `/project/current`, `/config`, …). The reads
 * that are not in the open-bundle projection (lazy or user-triggered) go
 * through the daemon's thin GET passthroughs, which forward to the in-sandbox
 * OpenCode and return its shape verbatim. This resolves the runtime url the
 * same way `getClient()` does (the current session's proxy base), so a caller
 * mounted for the foreground session reads that session's box.
 */
export async function readDaemonOpencode<T>(
  path: string,
  query?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const url = getCurrentRuntimeUrl();
  if (!url) throw new Error('[kortix] runtime not ready — no current runtime url');
  const base = url.replace(/\/$/, '');
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  const response = await authenticatedFetch(
    `${base}/kortix/opencode/${path}${qs}`,
    signal ? { signal } : undefined,
  );
  if (!response.ok) {
    throw new Error(`daemon /kortix/opencode/${path} read failed: ${response.status}`);
  }
  return (await response.json()) as T;
}
