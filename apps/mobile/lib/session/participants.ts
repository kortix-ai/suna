/**
 * Pure logic behind the shared-session UI: the sender under a user message
 * (`components/session/turn/user-message.tsx`) and the header avatar stack
 * (`components/session/SessionParticipantStack.tsx`). Same rules as web's
 * `features/session/participants/session-participants.tsx`.
 */
import { sessionMessageSender, type SessionParticipant, type SessionParticipants } from '@kortix/sdk';

/**
 * The person to show beside a message: its sender, unless that is the viewer.
 * Your own messages carry no avatar, in a shared session as in a private one.
 */
export function otherSender(
  participants: SessionParticipants | undefined,
  messageId: string,
): SessionParticipant | null {
  const sender = sessionMessageSender(participants, messageId);
  return sender?.is_viewer ? null : sender;
}

/** "You" for the viewer, else the display name, else the email local part. */
export function participantName(person: SessionParticipant): string {
  if (person.is_viewer) return 'You';
  return person.name?.trim() || person.email?.split('@')[0] || '';
}

/** What an avatar's initial and colour derive from: the name, else the email. */
export function participantAvatarText(person: SessionParticipant): string | undefined {
  return person.name?.trim() || person.email || undefined;
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
