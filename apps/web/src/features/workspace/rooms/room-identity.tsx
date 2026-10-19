'use client';

import { EntityAvatar, type EntityAvatarSize } from '@/components/ui/entity-avatar';
import { UserAvatar, type UserAvatarSize } from '@/components/ui/user-avatar';
import type { RoomKind, RoomPeer } from '@kortix/sdk';
import { HashIcon, RobotIcon } from '@phosphor-icons/react';

/** A room reads as its name; a direct conversation as the other member. */
export function conversationTitle(name: string | null, peer: RoomPeer | null, fallback: string): string {
  return name ?? peer?.label ?? fallback;
}

/**
 * One mark per participant kind, used by every rooms surface: a person is a
 * `UserAvatar`, an agent session an `EntityAvatar` with the robot glyph, a
 * named room an `EntityAvatar` with a hash.
 */
export function ParticipantAvatar({
  kind,
  label,
  userId,
  size = 'sm',
}: {
  kind: 'session' | 'person';
  label: string;
  userId?: string | null;
  size?: UserAvatarSize & EntityAvatarSize;
}) {
  return kind === 'person' ? (
    <UserAvatar email={userId ?? label} name={label} size={size} />
  ) : (
    <EntityAvatar label={label} icon={RobotIcon} size={size} />
  );
}

export function ConversationAvatar({
  kind,
  name,
  peer,
}: {
  kind: RoomKind;
  name: string | null;
  peer: RoomPeer | null;
}) {
  if (kind === 'direct' && peer) {
    return <ParticipantAvatar kind={peer.kind} label={peer.label} userId={peer.user_id} size="md" />;
  }
  return <EntityAvatar label={name ?? '#'} icon={HashIcon} size="md" />;
}
