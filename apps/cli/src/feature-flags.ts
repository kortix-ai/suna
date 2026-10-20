/**
 * Project feature flags as the CLI sees them. The API lists the project's
 * enabled flags in every session box (KORTIX_FEATURE_FLAGS, apps/api
 * projects/lib/feature-flag-env.ts). Outside a box the CLI has no list.
 *
 * A flagged command or system skill is SHOWN only where its flag is known on (a
 * box that lists it), and REFUSED only where it is known off (a box that does
 * not). Outside a box it is hidden from listings but still runs: the API
 * answers `feature_disabled` for a project without the flag.
 */
export const FEATURE_FLAGS_ENV_NAME = 'KORTIX_FEATURE_FLAGS';

type Env = Record<string, string | undefined>;

/** The box's enabled flags, or null outside a session box. */
export function boxFeatureFlags(env: Env = process.env): Set<string> | null {
  const raw = env[FEATURE_FLAGS_ENV_NAME];
  if (raw === undefined) return null;
  return new Set(raw.split(',').map((flag) => flag.trim()).filter(Boolean));
}

/** True for an unflagged item, or a flag this box lists. */
export function featureShown(flag: string | null | undefined, env: Env = process.env): boolean {
  return !flag || boxFeatureFlags(env)?.has(flag) === true;
}

/** True only inside a box that does not list the flag. */
export function featureKnownOff(flag: string | null | undefined, env: Env = process.env): boolean {
  if (!flag) return false;
  const flags = boxFeatureFlags(env);
  return flags !== null && !flags.has(flag);
}

/** The one line a flag-off item prints instead of itself. */
export function featureOffMessage(what: string, flag: string): string {
  return `${what} is behind the \`${flag}\` feature flag, which is off for this project. A project admin turns it on: kortix projects features enable ${flag}`;
}
