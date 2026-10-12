/**
 * Invites on mobile (KRTX-1731): where an accepted invite lands, the invite
 * links the app reads, and the link kept across the sign-in detour.
 *
 * - `inviteLanding` mirrors web's `inviteLandingPath`
 *   (apps/web/src/features/workspace/project-selector/project-selector-model.ts).
 * - `inviteIdFromUrl` reads `https://{kortix.com,www,staging}/invites/<uuid>`
 *   and `kortix://invites/<uuid>`. `app/+native-intent.ts` remembers the id;
 *   the start screen (`app/index.tsx`) takes it after sign-in.
 *
 * Pure: no React Native imports, so bun tests run it directly.
 */
import { KORTIX_LINK_HOSTS, URL_PARTS } from '@/lib/share-link';

export type InviteLanding =
  | { kind: 'project'; projectId: string; accountId: string }
  | { kind: 'account'; accountId: string };

/**
 * The first project the accept granted. Else the first project the invite
 * names: an admin invite (the API applies grants to members only) or an invite
 * accepted before this visit. Else the joined account.
 */
export function inviteLanding(
  accepted: { account_id: string; bootstrap_grants_applied?: ReadonlyArray<{ project_id: string }> },
  described?: { projects?: ReadonlyArray<{ project_id: string }> } | null
): InviteLanding {
  const project = accepted.bootstrap_grants_applied?.[0] ?? described?.projects?.[0];
  return project
    ? { kind: 'project', projectId: project.project_id, accountId: accepted.account_id }
    : { kind: 'account', accountId: accepted.account_id };
}

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
