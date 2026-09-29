/**
 * Which Platinum region a project's sessions run in when its `us_region`
 * feature flag is on.
 *
 * Platinum serves every region behind the one API origin Kortix already uses
 * (`PLATINUM_API_URL`): a create that names `region` is forwarded to that
 * region's control plane, and every later call by sandbox id is routed there
 * too. So choosing a region needs no second URL, only this value, and it is
 * the operator gate as well: unset ⇒ the flag is unavailable and hidden, which
 * is the right default for an environment whose Platinum org has no grant for
 * the region (Platinum answers such a create with 403 region_not_enabled).
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
