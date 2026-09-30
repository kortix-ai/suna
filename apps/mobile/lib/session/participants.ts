/**
 * Pure logic behind the shared-session UI: the sender under a user message
 * (`components/session/turn/user-message.tsx`) and the header avatar stack
 * (`components/session/SessionParticipantStack.tsx`). Same rules as web's
 * `features/session/participants/session-participants.tsx`.
 */
import type { SessionParticipant, SessionParticipants } from '@kortix/sdk';

/** The display name, else the email local part. The viewer too. */
export function participantName(person: SessionParticipant): string {
  return person.name?.trim() || person.email?.split('@')[0] || '';
}

/** What an avatar's initial and colour derive from: the name, else the email. */
export function participantAvatarText(person: SessionParticipant): string | undefined {
  return person.name?.trim() || person.email || undefined;
}

/**
 * Up to two letters, web `UserAvatar`'s rule: the first and last word of the
 * name, else the email local part split on `.`, `_` and `-`.
 */
export function participantInitials(person: SessionParticipant): string {
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
