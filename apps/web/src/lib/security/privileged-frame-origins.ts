import { getEnv } from '@/lib/env-config';

/**
 * Origins that agent-authored frames must never share: the page itself, the
 * configured app URL, and the API (which also serves the sandbox path proxy).
 * The page origin comes first, so a relative frame URL resolves against it.
 *
 * `BACKEND_URL` may be root-relative (`/v1` on a self-host), which puts the
 * API on the page origin; resolving it against the page covers that case.
 */
export function privilegedFrameOrigins(): string[] {
  const env = getEnv();
  const page = typeof window !== 'undefined' ? window.location.origin : env.APP_URL;
  const origins = [page, env.APP_URL];
  try {
    origins.push(new URL(env.BACKEND_URL, page).origin);
  } catch {
    // An unparseable backend URL adds nothing; the page origin still applies.
  }
  return origins;
}
