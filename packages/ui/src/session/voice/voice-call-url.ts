/** The port of the box's voice relay (`KORTIX_VOICE_PORT` in packages/voice, beside the desktop's 6901). */
export const VOICE_PORT = 6902;

/**
 * The WebSocket URL of a call with `session` (the Kortix session id the relay binds).
 *
 * `portUrl` is the path form of the sandbox port proxy, `getSandboxUrlForExternalId(sandbox, VOICE_PORT)`:
 * the API authenticates its upgrade with `?token=`. A preview origin (what `proxyUrl` returns where the
 * deployment has one) refuses a WebSocket from this page's site and reads no token.
 *
 * The rest is `getKortixPtyWebSocketUrl`'s conversion: http→ws, wss on an https page (a browser blocks
 * ws:// there), the token as a query parameter (a browser WebSocket sends no header), and `wake=1` for
 * an attach a person started.
 */
export function voiceCallSocketUrl(
  portUrl: string,
  opts: { session: string; token: string | null; wake: boolean; securePage: boolean },
): string {
  const url = new URL(portUrl);
  url.protocol = url.protocol === 'https:' || opts.securePage ? 'wss:' : 'ws:';
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}stream` : `${url.pathname}/stream`;
  url.searchParams.set('session', opts.session);
  if (opts.token) url.searchParams.set('token', opts.token);
  if (opts.wake) url.searchParams.set('wake', '1');
  return url.toString();
}

/** The relay's health route behind the same proxy: the probe that tells "no relay" from a failed dial. */
export function voiceRelayHealthUrl(portUrl: string, token: string | null): string {
  const url = new URL(portUrl);
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}health` : `${url.pathname}/health`;
  if (token) url.searchParams.set('token', token);
  return url.toString();
}
