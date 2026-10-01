/**
 * SessionParticipantStack — the thread header's "who can open this session"
 * control. Overlapping avatars in the header's right-side row, before the
 * sub-agent chip and the `···`. Renders nothing unless two or more people can
 * open the session, so a single-user thread's header is unchanged.
 *
 * Two faces, then a `+N` tile: the centred title keeps the width (the same
 * ruling as `SubAgentHeaderChip`). Each face is `ParticipantAvatar`, web's
 * `UserAvatar`. A tap opens `SessionParticipantsSheet`, the phone's version
 * of web's hover card (Jay, 2026-10-01). Screen readers read the names from
 * its label.
 */
import * as React from 'react';
import { Pressable, View } from 'react-native';
import type { SessionParticipants } from '@kortix/sdk';

import { ParticipantAvatar, PARTICIPANT_AVATAR_SIZE } from '@/components/session/ParticipantAvatar';
import { Text } from '@/components/ui/text';
import { participantStack } from '@/lib/session/participants';
import { webSpace } from '@/lib/session/user-message';

/** Faces shown before the rest collapse into a count. */
const STACK_LIMIT = 2;
/** Web `ring-1 ring-background`: a surface-coloured cut around each face. */
const RING = 1;
/** Web `-space-x-1.5`, measured between faces; the ring sits outside it. */
const FACE_OVERLAP = webSpace(1.5) + 2 * RING;
/** Web `rounded-sm` plus the ring. */
const RING_RADIUS = 6 + RING;
/** Pill height, the sub-agent chip's. */
const STACK_HEIGHT = 32;

interface SessionParticipantStackProps {
  participants: SessionParticipants | undefined;
  /** Opens the people sheet. */
  onPress?: () => void;
}

export function SessionParticipantStack({ participants, onPress }: SessionParticipantStackProps) {
  const stack = participantStack(participants, STACK_LIMIT);
  if (!stack) return null;

  const faces = [
    ...stack.shown.map((person) => (
      <ParticipantAvatar key={person.user_id} person={person} />
    )),
    ...(stack.more > 0
      ? [
          // Web `AvatarGroupCount`: a muted tile the size of a face.
          <View
            key="more"
            className="items-center justify-center bg-muted"
            // Grows with the count (+97), never narrower than a face.
            style={{ minWidth: PARTICIPANT_AVATAR_SIZE, height: PARTICIPANT_AVATAR_SIZE, paddingHorizontal: 3, borderRadius: 6 }}>
            <Text
              className="text-muted-foreground"
              style={{ fontFamily: 'Roobert-Medium', fontSize: 10, fontVariant: ['tabular-nums'] }}
              allowFontScaling={false}>
              +{stack.more}
            </Text>
          </View>,
        ]
      : []),
  ];

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={stack.label}
      accessibilityHint="Shows who can open this session"
      // 32pt pill + 6pt slop each side = a 44pt target, as `ProjectHeaderActions`.
      hitSlop={6}
      className="flex-row items-center rounded-full bg-background active:opacity-70"
      style={{ height: STACK_HEIGHT, paddingHorizontal: 4 }}>
      {faces.map((face, index) => (
        <View
          key={face.key}
          className="bg-background"
          style={{ padding: RING, borderRadius: RING_RADIUS, marginLeft: index === 0 ? 0 : -FACE_OVERLAP }}>
          {face}
        </View>
      ))}
    </Pressable>
  );
}
