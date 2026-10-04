import type { SecretGrant, SessionVisibility } from '../connectors/share';
import type { UserIdentity } from '../projects/lib/user-identity';

/** How many people `participants` lists; `total` carries the full count. */
export const SESSION_PARTICIPANT_LIMIT = 20;

/**
 * Who can open a session: the audience behind the participants route.
 * (`./session-participants` is the other thing: people an agent addresses.)
 */
export interface SessionAudienceMember {
  user_id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  is_viewer: boolean;
}

export interface SessionParticipantsView {
  /** Who can open the session now, owner first. At most SESSION_PARTICIPANT_LIMIT. */
  participants: SessionAudienceMember[];
  /** How many people can open the session now. */
  total: number;
  /** Two or more distinct people can open the session. */
  multi_user: boolean;
}

/**
 * Who can open the session now, owner first. `rosterIds` is everyone with
 * access to the project; a private session never reads it.
 */
export function sessionAudienceIds(input: {
  ownerId: string | null;
  visibility: SessionVisibility;
  grants: SecretGrant[];
  rosterIds: string[];
  groupMembers: Map<string, string[]>;
}): string[] {
  const { ownerId } = input;
  if (input.visibility === 'private') return ownerId ? [ownerId] : [];
  const granted = new Set<string>(ownerId ? [ownerId] : []);
  for (const grant of input.grants) {
    if (grant.principalType === 'member') granted.add(grant.principalId);
    else for (const userId of input.groupMembers.get(grant.principalId) ?? []) granted.add(userId);
  }
  const audience =
    input.visibility === 'project' ? input.rosterIds : input.rosterIds.filter((id) => granted.has(id));
  return [...audience].sort((a, b) => Number(b === ownerId) - Number(a === ownerId));
}

export function buildSessionParticipants(input: {
  viewerId: string;
  ownerId: string | null;
  audienceIds: string[];
  /** Resolved for the listed people. An id absent here came from the roster, which holds real users only. */
  identities: Map<string, UserIdentity>;
  /** False when the viewer may not read the project roster. */
  canReadMembers: boolean;
}): SessionParticipantsView {
  const isRealUser = (id: string) => input.identities.get(id)?.exists !== false;
  const profile = (id: string): SessionAudienceMember => {
    const identity = input.identities.get(id);
    return {
      user_id: id,
      name: identity?.displayName ?? null,
      email: identity?.email ?? null,
      avatar_url: identity?.avatarUrl ?? null,
      is_viewer: id === input.viewerId,
    };
  };

  const audience = input.audienceIds.filter(isRealUser);
  const listed = input.canReadMembers
    ? audience
    : audience.filter((id) => id === input.ownerId || id === input.viewerId);

  return {
    participants: listed.slice(0, SESSION_PARTICIPANT_LIMIT).map(profile),
    total: audience.length,
    multi_user: audience.length >= 2,
  };
}
