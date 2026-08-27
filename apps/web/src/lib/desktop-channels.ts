/**
 * Which desktop build a web host belongs to, and where its installer lives.
 *
 * Three builds of the desktop shell now ship side by side — prod, staging and
 * dev — with distinct bundle ids, names, icons and URL schemes so one machine
 * can hold all three (apps/desktop-electron/src/channel.js is the source of
 * truth for that identity; desktop-channels.test.ts cross-checks this file
 * against it so the two cannot drift).
 *
 * Two things follow from that, and both live here:
 *
 *  1. `/download` must serve the build that matches the site you are on.
 *     Before this, dev.kortix.com handed visitors the PRODUCTION installer —
 *     which then opened kortix.com, so testing a dev change on the desktop was
 *     impossible.
 *
 *  2. The OAuth bounce must deep-link into the app that started the sign-in,
 *     not whichever app the OS happens to have registered. See
 *     `resolveDesktopScheme`.
 */

export type DesktopChannel = 'stable' | 'staging' | 'dev';

/** Deep-link scheme per channel. Mirrors CHANNELS[*].scheme in channel.js. */
export const DESKTOP_SCHEMES: Record<DesktopChannel, string> = {
  stable: 'kortix',
  staging: 'kortix-staging',
  dev: 'kortix-dev',
};

/**
 * Every build shipped before per-channel schemes existed registered `kortix://`
 * and understands nothing else, so that is the fallback whenever a client does
 * not tell us which scheme it wants.
 */
export const DEFAULT_DESKTOP_SCHEME = DESKTOP_SCHEMES.stable;

const SCHEME_VALUES: ReadonlySet<string> = new Set(Object.values(DESKTOP_SCHEMES));

/**
 * The channel a web host serves.
 *
 * Anything that is not explicitly dev or staging — kortix.com, a self-host
 * domain, a preview URL — is treated as stable. That is the safe default: a
 * self-hoster's /download should hand out the released installer, never a
 * mutable dev prerelease.
 *
 * localhost is `stable` on purpose too. A locally-run `electron .` is
 * unpackaged, so it bakes no channel and registers plain `kortix://`.
 */
export function desktopChannelForHost(host: string | null | undefined): DesktopChannel {
  const h = (host || '').toLowerCase().split(':')[0];
  if (h === 'dev.kortix.com') return 'dev';
  if (h === 'staging.kortix.com') return 'staging';
  return 'stable';
}

/**
 * Resolve the scheme to deep-link back into, given what the desktop app told
 * us in the `desktop_scheme` query param.
 *
 * The param is attacker-influenced (it arrives on a public callback URL), so it
 * is matched against the allowlist rather than trusted — an unrecognised value
 * degrades to `kortix://` instead of letting a page dictate an arbitrary
 * protocol.
 *
 * The param is authoritative over the host on purpose. The shell's
 * "Frontend URL" menu lets a PRODUCTION install point at dev.kortix.com; that
 * app still only answers `kortix://`, so deriving the scheme from the host
 * would break exactly the cross-environment testing this feature exists for.
 */
export function resolveDesktopScheme(raw: string | null | undefined): string {
  return raw && SCHEME_VALUES.has(raw) ? raw : DEFAULT_DESKTOP_SCHEME;
}

/**
 * The git tag holding this channel's installers, or null for stable.
 *
 * Stable ships in the immutable `vX.Y.Z` release cut by deploy-prod.yml, which
 * has no fixed tag to name — `releases/latest` resolves it. Dev and staging
 * publish to prereleases that desktop.yml force-pushes over on every build, so
 * the tag stays put while the assets behind it move. That is exactly what "give
 * me the current dev app" means.
 *
 * Every URL that names a channel's release derives from this one function, so
 * the tag format is written once.
 */
export function desktopReleaseTag(channel: DesktopChannel): string | null {
  return channel === 'stable' ? null : `desktop-${channel}-latest`;
}
