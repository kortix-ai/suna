import { platformConfig } from '@kortix/sdk';
import { uiHostEnv } from '@kortix/ui/lib/host-env';

/**
 * Origins that agent-authored frames must never share: the page itself, the
 * configured app URL, and the API (which also serves the sandbox path proxy).
 * The page origin comes first, so a relative frame URL resolves against it.
 *
 * `backendUrl` may be root-relative (`/v1` on a self-host), which puts the
 * API on the page origin; resolving it against the page covers that case.
 */
export function privilegedFrameOrigins(): string[] {
  const { appUrl } = uiHostEnv();
  const page = typeof window !== 'undefined' ? window.location.origin : appUrl;
  const origins = [page, appUrl];
  try {
    origins.push(new URL(platformConfig().backendUrl, page).origin);
  } catch {
    // An unparseable backend URL adds nothing; the page origin still applies.
  }
  return origins;
}
