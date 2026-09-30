import type { ConnectionShare, ConnectionSharePrincipal } from '@kortix/sdk';

import type { NewAccountDraft } from './connector-connections';

/** The "Who can use it" choice of a secret value — the same three options as a
 *  connector account: only you, everyone in the project, specific people. */
export type SecretAudienceDraft = Pick<NewAccountDraft, 'audience' | 'picked'>;

const NOBODY = { memberIds: [], groupIds: [] };

/** A value's stored audience as the choice the dialog opens with. */
export function audienceDraftFrom(
  shares: readonly ConnectionShare[],
  viewerId: string | null | undefined,
): SecretAudienceDraft {
  if (shares.length === 0 || shares.some((share) => share.principal_type === 'project')) {
    return { audience: 'project', picked: NOBODY };
  }
  const [only] = shares;
  if (shares.length === 1 && only?.principal_type === 'member' && only.principal_id === viewerId) {
    return { audience: 'private', picked: NOBODY };
  }
  return {
    audience: 'members',
    picked: {
      memberIds: shares.filter((share) => share.principal_type === 'member').map((share) => share.principal_id),
      groupIds: shares.filter((share) => share.principal_type === 'group').map((share) => share.principal_id),
    },
  };
}

/** What Save sends as `shared_with` (`[]` = everyone), or null when the choice is incomplete. */
export function sharedWithFrom(
  draft: SecretAudienceDraft,
  viewerId: string | null | undefined,
): ConnectionSharePrincipal[] | null {
  if (draft.audience === 'project') return [];
  if (draft.audience === 'private') {
    return viewerId ? [{ principal_type: 'user', principal_id: viewerId }] : null;
  }
  const principals: ConnectionSharePrincipal[] = [
    ...draft.picked.memberIds.map((id) => ({ principal_type: 'user' as const, principal_id: id })),
    ...draft.picked.groupIds.map((id) => ({ principal_type: 'group' as const, principal_id: id })),
  ];
  return principals.length > 0 ? principals : null;
}

/** Does `next` name exactly the stored audience? Then Save leaves it alone. */
export function sameSharedWith(
  stored: readonly ConnectionShare[],
  next: readonly ConnectionSharePrincipal[],
): boolean {
  if (stored.some((share) => share.principal_type === 'project')) return next.length === 0;
  const key = (type: string, id: string) => `${type === 'member' ? 'user' : type}:${id}`;
  const a = new Set(stored.map((share) => key(share.principal_type, share.principal_id)));
  const b = new Set(next.map((p) => key(p.principal_type, p.principal_id)));
  return a.size === b.size && [...a].every((k) => b.has(k));
}
