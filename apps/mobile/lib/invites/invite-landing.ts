/**
 * Invites on mobile (KRTX-1731): where an accepted invite lands, the invite
 * links the app reads, and the link kept across the sign-in detour.
 *
 * - Where an accepted invite lands is the SDK's `accountInviteLanding`, the
 *   rule web reads too; the invite screen maps it to a route.
 * - `inviteIdFromUrl` reads `https://{kortix.com,www,staging}/invites/<uuid>`
 *   and `kortix://invites/<uuid>`. `app/+native-intent.ts` remembers the id;
 *   the start screen (`app/index.tsx`) takes it after sign-in.
 *
 * Pure: no React Native imports, so bun tests run it directly.
 */
import { KORTIX_LINK_HOSTS, URL_PARTS } from '@/lib/share-link';

/** `/invites/<uuid>`, nothing after the id. The API's `invite_id` is a uuid. */
const INVITE_PATH = /^\/invites\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The invite id in an invite link, lower case, or null for any other URL. */
export function inviteIdFromUrl(url: string): string | null {
  const match = URL_PARTS.exec(url.trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const authority = match[2].toLowerCase();
  let path = match[3];
  if (scheme === 'https') {
    if (!KORTIX_LINK_HOSTS.has(authority)) return null;
  } else if (scheme === 'kortix') {
    if (authority === 'invites') path = `/invites${path}`;
    else if (authority !== '') return null;
  } else {
    return null;
  }
  return INVITE_PATH.exec(path)?.[1].toLowerCase() ?? null;
}

/** The route of the invite screen (`app/invites/[id].tsx`), in the typed-routes shape. */
export function inviteHref(inviteId: string): { pathname: '/invites/[id]'; params: { id: string } } {
  return { pathname: '/invites/[id]', params: { id: inviteId } };
}

// In memory only: the link survives the /auth detour, not an app restart.
let rememberedInvite: string | null = null;

/** Keep an opened invite link until the start screen can show it. */
export function rememberInviteLink(inviteId: string): void {
  rememberedInvite = inviteId;
}

/** The remembered invite link, once. */
export function takeInviteLink(): string | null {
  const inviteId = rememberedInvite;
  rememberedInvite = null;
  return inviteId;
}

/** Invites put off with Not now this run: the start screen passes over them. */
export const skippedInvites = new Set<string>();
