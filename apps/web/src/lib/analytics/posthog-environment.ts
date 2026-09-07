/**
 * Which deployment an event came from.
 *
 * Dev, staging and production all report to ONE PostHog project (decision,
 * 2026-09-07). Without a discriminator every dashboard mixes test traffic with
 * customers — signups, activation and conversion would all read high and mean
 * nothing. This is registered as a super property, so every client event
 * carries it and any insight can filter on `environment`. The API stamps the
 * same property from `INTERNAL_KORTIX_ENV`.
 *
 * Derived from the hostname rather than a build variable: it needs no deploy
 * plumbing, cannot be stale, and labels self-hosted installs correctly.
 */
export type KortixEnvironment = 'local' | 'preview' | 'dev' | 'staging' | 'prod' | 'self-host';

export function posthogEnvironment(hostname: string | null | undefined): KortixEnvironment {
  const host = (hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return 'self-host';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) {
    return 'local';
  }
  if (host.endsWith('.trycloudflare.com') || host.includes('.sbx.') || host.endsWith('.vercel.app')) {
    return 'preview';
  }
  if (host === 'dev.kortix.com' || host === 'dev-api.kortix.com') return 'dev';
  if (host === 'staging.kortix.com' || host === 'staging-api.kortix.com') return 'staging';
  if (host === 'kortix.com' || host === 'www.kortix.com' || host === 'api.kortix.com') return 'prod';
  return 'self-host';
}
