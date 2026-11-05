/** The session desktop's port: voxl, streaming the box's screen (packages/shared/src/sandbox/desktop.ts). */
export const SESSION_DESKTOP_PORT = 6901;

/**
 * The Origin the box sees on a request whose client sent one, or `null` to send
 * none.
 *
 * A dev server gets the upstream's own origin, so frameworks that check
 * same-origin on mutations (Next.js Server Actions, SvelteKit, Remix, Django
 * CSRF) see a consistent pair.
 *
 * The desktop gets none. voxl admits its own page (an Origin matching the Host
 * it sees) or a client that sends no Origin, and refuses every other site. The
 * edge rewrites the Host it sees to an internal name (`6901-<id>.aec.local` on
 * Platinum), so no Origin this proxy could send matches it: the viewer's file
 * upload was refused (dev 2026-11-05). This proxy has already authenticated
 * the viewer; voxl's Origin check stays on for everything that reaches it
 * without the proxy, such as a page in the box's own browser.
 */
export function upstreamOrigin(port: number, previewUrl: string): string | null {
  if (port === SESSION_DESKTOP_PORT) return null;
  return new URL(previewUrl).origin;
}
