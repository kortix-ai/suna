/**
 * Parse the sidebar's open/collapsed state out of a cookie string.
 *
 * {@link SidebarProvider} writes `sidebar_state=true|false` on every toggle.
 * The project shell remounts on navigation, so it re-seeds the provider's
 * initial state from this value; without it the sidebar snaps back to its
 * default (expanded) on every session open / ⌘J / switch.
 *
 * Returns `undefined` when the cookie is absent so callers can fall back to
 * the provider default.
 */
export function parseSidebarStateCookie(cookie: string | null | undefined): boolean | undefined {
  if (!cookie) return undefined;
  const match = cookie.match(/(?:^|;\s*)sidebar_state=(true|false)\b/);
  return match ? match[1] === 'true' : undefined;
}
