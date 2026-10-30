import type { AccountSecretResource, ConnectorSharing } from '@kortix/sdk';

/**
 * Who can use a new provider connection. "Only you" shares it with nobody, so
 * any project member may create it. "Everyone" and "Specific members" share a
 * credential, which the API gates on `project.secret.write`.
 */
export type ConnectionAccessChoice = 'private' | 'project' | 'members';

/** Access fields for a new API key. The API always grants the creator. */
export function keyAccessFields(
  choice: ConnectionAccessChoice,
  memberIds: string[],
): { access_mode: 'project' | 'members'; user_ids: string[] } {
  if (choice === 'project') return { access_mode: 'project', user_ids: [] };
  return { access_mode: 'members', user_ids: choice === 'members' ? memberIds : [] };
}

/**
 * Sharing intent for a new ChatGPT account. Before the viewer is known, an
 * empty member list keeps the account owner-only on the API as well.
 */
export function chatGptSharing(
  choice: ConnectionAccessChoice,
  memberIds: string[],
  viewerId: string | undefined,
): ConnectorSharing {
  if (choice === 'project') return { mode: 'project' };
  if (choice === 'members' && memberIds.length) return { mode: 'members', memberIds };
  return viewerId ? { mode: 'private', ownerId: viewerId } : { mode: 'members', memberIds: [] };
}

/** First name for a new account's default label ("ChatGPT · Ada"). */
export function labelOwnerName(
  user: { email?: string | null; user_metadata?: Record<string, unknown> } | null | undefined,
): string {
  const metadata = user?.user_metadata ?? {};
  for (const key of ['full_name', 'name']) {
    const value = metadata[key];
    const first = typeof value === 'string' ? value.trim().split(/\s+/)[0] : '';
    if (first) return first;
  }
  return user?.email?.split('@')[0] ?? '';
}

export type AccessSummary =
  | { kind: 'project' }
  | { kind: 'you' }
  | { kind: 'owner'; ownerId: string }
  | { kind: 'members'; count: number };

/** The access line on a connection row. Granted to its creator alone = private. */
export function accessSummary(
  secret: Pick<AccountSecretResource, 'access_mode' | 'granted_user_ids' | 'created_by'>,
  viewerId: string | undefined,
): AccessSummary {
  if (secret.access_mode === 'project') return { kind: 'project' };
  const grantees = secret.granted_user_ids;
  if (grantees.length === 1 && grantees[0] === secret.created_by) {
    return secret.created_by === viewerId ? { kind: 'you' } : { kind: 'owner', ownerId: secret.created_by };
  }
  return { kind: 'members', count: grantees.length };
}

/**
 * A ChatGPT account whose login stopped working: the gateway marked it
 * (`needs_reauth_at`), or it is inactive. It stays selectable; reconnecting it
 * clears the mark.
 */
export function needsReconnection(secret: Pick<AccountSecretResource, 'active' | 'needs_reauth_at'>): boolean {
  return !secret.active || Boolean(secret.needs_reauth_at);
}
