/**
 * Which Platinum region a project's sessions run in when its `us_region`
 * feature flag is on.
 *
 * Choosing a region needs no second URL in configuration, only this value. A
 * create that names `region` goes to `PLATINUM_API_URL`, which forwards it to
 * that region's control plane. Every later call by sandbox id goes straight to
 * the owner that Platinum names (`api_url`, `x-pt-served-by`; see
 * services/sandboxes/platinum/client.ts). Through `PLATINUM_API_URL` each such call cost a
 * discovery GET plus a forward across the Atlantic: 329 ms vs 26 ms direct for
 * a US box from New York (prod, 2026-10-02).
 *
 * This value is also the operator gate: unset ⇒ the flag is unavailable and
 * hidden, which is the right default for an environment whose Platinum org has
 * no grant for the region (Platinum answers such a create with 403
 * region_not_enabled).
 *
 * Read straight from the environment, like KORTIX_PLATINUM_CREATE_DEDUP: it is
 * an operator switch, not product configuration, and dev enables it through
 * its ECS env overrides.
 */
const REGION_KEY = /^[a-z]{2,8}-[a-z]{2,12}$/;

export function platinumUsRegion(): string | null {
  const raw = (process.env.KORTIX_PLATINUM_US_REGION ?? '').trim();
  return REGION_KEY.test(raw) ? raw : null;
}
