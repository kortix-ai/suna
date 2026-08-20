import type { ProjectSession } from '@kortix/sdk';

import type { SharingMode } from '@/features/workspace/shared/sharing-intent';

/**
 * How the viewer stands to ONE session's access policy.
 *
 * `owner`    — created it. Picks any mode, including "Only you".
 * `delegate` — does not own it but governs it anyway, because nobody human
 *              does: a trigger/agent run is stamped with a service account, so
 *              the API hands the policy to project managers instead.
 * `viewer`   — it was shared with them. They read who else has access; they do
 *              not change it.
 */
export type SessionAccessRole = 'owner' | 'delegate' | 'viewer';

export interface SessionAccessView {
  role: SessionAccessRole;
  canEdit: boolean;
  /**
   * Modes the viewer must not pick because saving one would revoke their OWN
   * access with no way back. Only "Only you" does that, and only for someone
   * who is not the owner — "you" in that label is always the OWNER, never the
   * person editing.
   */
  disabledModes: SharingMode[];
  /** Whose session this is, in the second person when it is the viewer's. */
  ownerLabel: string;
}

type SessionOwnership = Pick<
  ProjectSession,
  'is_owner' | 'can_manage_sharing' | 'owner_name' | 'owner_email' | 'visibility' | 'sharing'
>;

/** The owner's name for display. "You" when the viewer owns it. */
export function sessionOwnerName(session: SessionOwnership): string {
  if (session.is_owner !== false) return 'You';
  return session.owner_name || session.owner_email || 'Another member';
}

export function sessionAccessView(session: SessionOwnership): SessionAccessView {
  // `can_manage_sharing` is the server's verdict and the only one that matters —
  // the Save button is decoration if the PUT 403s. Absent on older payloads, so
  // only an explicit `false` withholds editing.
  const canEdit = session.can_manage_sharing !== false;
  const isOwner = session.is_owner !== false;
  const role: SessionAccessRole = isOwner ? 'owner' : canEdit ? 'delegate' : 'viewer';
  return {
    role,
    canEdit,
    disabledModes: isOwner ? [] : ['private'],
    ownerLabel: sessionOwnerName(session),
  };
}

function countPhrase(count: number, singular: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/** One sentence naming exactly who can open the session right now. */
export function sessionAccessSummary(session: SessionOwnership): string {
  const owner = sessionOwnerName(session);
  if (session.visibility === 'project') return 'Every member of this project can open it.';
  if (session.visibility === 'restricted') {
    const sharing = session.sharing;
    const memberIds = sharing && sharing.mode === 'members' ? (sharing.memberIds ?? []) : [];
    const groupIds = sharing && sharing.mode === 'members' ? (sharing.groupIds ?? []) : [];
    const parts = [countPhrase(memberIds.length, 'member'), countPhrase(groupIds.length, 'group')]
      .filter((part): part is string => part !== null)
      .join(' and ');
    const holder = owner === 'You' ? 'you' : owner;
    if (!parts) return `Only ${holder} can open it.`;
    return `${holder === 'you' ? 'You' : holder} and ${parts} can open it.`;
  }
  return owner === 'You' ? 'Only you can open it.' : `Only ${owner} can open it.`;
}
