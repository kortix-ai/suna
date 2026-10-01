/**
 * Pure logic behind the shared-session UI: the sender under a user message
 * (`components/session/turn/user-message.tsx`) and the header avatar stack
 * (`components/session/SessionParticipantStack.tsx`). Same rules as web's
 * `features/session/participants/session-participants.tsx`.
 */
import type { SessionMessageAuthors, SessionParticipant, SessionParticipants } from '@kortix/sdk';

/** What an avatar needs: a participant, or a message's member author. */
export type AvatarPerson = Pick<SessionParticipant, 'name' | 'email'> & { avatar_url?: string | null };

/** The display name, else the email local part. The viewer too. */
export function participantName(person: AvatarPerson): string {
  return person.name?.trim() || person.email?.split('@')[0] || '';
}

/** What an avatar's initial and colour derive from: the name, else the email. */
export function participantAvatarText(person: AvatarPerson): string | undefined {
  return person.name?.trim() || person.email || undefined;
}

/**
 * Up to two letters, web `UserAvatar`'s rule: the first and last word of the
 * name, else the email local part split on `.`, `_` and `-`.
 */
export function participantInitials(person: AvatarPerson): string {
  const words = person.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    const last = words.length > 1 ? words[words.length - 1][0] : '';
    return (words[0][0] + last).toUpperCase();
  }
  const local = person.email?.split('@')[0] ?? '';
  const segments = local.split(/[._-]+/).filter(Boolean);
  return ((segments[0]?.[0] ?? '') + (segments[1]?.[0] ?? '')).toUpperCase() || '?';
}

export interface ParticipantStack {
  shown: SessionParticipant[];
  /** People who can open the session beyond the faces shown. */
  more: number;
  label: string;
}

/** The header stack, or null unless two or more people can open the session. */
export function participantStack(
  participants: SessionParticipants | undefined,
  limit: number,
): ParticipantStack | null {
  if (!participants?.multi_user || participants.total < 2) return null;
  const shown = participants.participants.slice(0, limit);
  const more = participants.total - shown.length;
  const names = shown.map(participantName).filter(Boolean).join(', ');
  return {
    shown,
    more,
    label: `People in this session: ${names}${more > 0 ? ` and ${more} more` : ''}`,
  };
}

/**
 * The person whose avatar sits beside a message, or null. Web's rule
 * (`showAuthorName`): a group chat draws every author, the viewer included;
 * a one-person session draws only someone else. A session is a group chat
 * when two or more people can open it or two or more authors wrote in it.
 * Another session's agent has no face: null.
 */
export function messageAvatarPerson(
  authors: SessionMessageAuthors | undefined,
  participants: SessionParticipants | undefined,
  viewerId: string | undefined,
  messageId: string,
): AvatarPerson | null {
  const author = authors?.authors[messageId];
  if (author?.kind !== 'member') return null;
  const distinct = new Set(
    Object.values(authors!.authors).map((a) => (a.kind === 'member' ? `member:${a.user_id}` : `session:${a.session_id}`)),
  );
  const groupChat = !!participants?.multi_user || distinct.size >= 2;
  // Unknown viewer (participants not loaded): no guess.
  if (!groupChat && (viewerId === undefined || author.user_id === viewerId)) return null;
  return { name: author.name, email: author.email, avatar_url: author.avatar_url ?? null };
}
