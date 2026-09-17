/**
 * Picks the host a native device uses to reach the local dev stack (API,
 * Supabase) in place of `localhost`. Pure, with no React Native imports, so
 * `bun test` can run it; `resolve-local-url.ts` feeds it the runtime values.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Host part of a Metro host URI, e.g. `192.168.0.126:8081` → `192.168.0.126`.
 * Returns null when there is no URI (release builds) or the host is loopback,
 * because a loopback address points at the device itself.
 */
export function hostFromMetroUri(hostUri?: string | null): string | null {
  const value = hostUri?.trim();
  if (!value) return null;

  // IPv6 host URIs wrap the address in brackets: `[fe80::1]:8081`.
  const host = value.startsWith('[')
    ? value.slice(1, value.indexOf(']'))
    : value.split(':')[0];

  if (!host || LOOPBACK_HOSTS.has(host)) return null;
  return host;
}

export function pickDevHost({
  envHost,
  metroHostUri,
  platform,
}: {
  /** `EXPO_PUBLIC_DEV_HOST`: an explicit override. */
  envHost?: string;
  /** `Constants.expoConfig.hostUri`: the Metro host the bundle came from. */
  metroHostUri?: string | null;
  platform: 'ios' | 'android';
}): string {
  const explicit = envHost?.trim();
  if (explicit) return explicit;

  const metroHost = hostFromMetroUri(metroHostUri);
  if (metroHost) return metroHost;

  // No Metro host: the iOS simulator shares the Mac's localhost; the Android
  // emulator reaches it through its bridge address.
  return platform === 'ios' ? 'localhost' : '10.0.2.2';
}
