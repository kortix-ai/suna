/**
 * PostHog host derivation, shared by next.config.ts (the /ingest reverse-proxy
 * rewrites, fixed at BUILD time) and instrumentation-client.ts (posthog.init at
 * RUNTIME). One source, so the two can never point at different regions.
 */
/**
 * US, because every Kortix deployment reports to one US project (decision,
 * 2026-09-07). It fixes the `/ingest` proxy target at build time, so a US
 * default keeps the ad-block-resistant proxy working without a per-environment
 * build variable. Moving to EU later means changing this and rebuilding; a
 * runtime host in another region still works, it just bypasses the proxy.
 */
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * @param {string | undefined | null} host ingest host, e.g. https://us.i.posthog.com
 * @returns {{ ingest: string; assets: string; ui: string }}
 */
export function posthogHosts(host) {
  const ingest = (host || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '');
  return {
    ingest,
    assets: ingest.replace('.i.posthog.com', '-assets.i.posthog.com'),
    ui: ingest.replace('.i.posthog.com', '.posthog.com'),
  };
}

/**
 * Where the browser sends events. The /ingest proxy only forwards to the host
 * baked in at build, so a runtime host for another region goes direct — no
 * ad-block bypass, but the right project.
 *
 * @param {string | undefined | null} runtimeHost host from the runtime config
 * @param {string | undefined | null} buildHost NEXT_PUBLIC_POSTHOG_HOST at build
 * @returns {string}
 */
export function posthogApiHost(runtimeHost, buildHost) {
  const runtime = posthogHosts(runtimeHost).ingest;
  return runtime === posthogHosts(buildHost).ingest ? '/ingest' : runtime;
}
