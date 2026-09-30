/**
 * SessionParticipantStack — the thread header's "who can open this session"
 * control. Overlapping avatars in the header's right-side row, before the
 * sub-agent chip and the `···`. Renders nothing unless two or more people can
 * open the session, so a single-user thread's header is unchanged.
 *
 * Two faces, then a count: the centred title keeps the width (the same ruling
 * as `SubAgentHeaderChip`). Display only: it opens nothing (Jay, 2026-09-30).
 * Screen readers read the names from its label.
 */
import * as React from 'react';
import { View } from 'react-native';
import type { SessionParticipants } from '@kortix/sdk';

import { Avatar } from '@/components/kortix/avatar';
import { Text } from '@/components/ui/text';
import { participantAvatarText, participantStack } from '@/lib/session/participants';
import { THEME } from '@/lib/utils/theme';
import { useColorScheme } from 'nativewind';

/** Faces shown before the rest collapse into a count. */
const STACK_LIMIT = 2;
const FACE_SIZE = 24;
/** How far each face slides under the one before it. */
const FACE_OVERLAP = 8;
/** Pill height, the sub-agent chip's. */
const STACK_HEIGHT = 32;

interface SessionParticipantStackProps {
  participants: SessionParticipants | undefined;
}

export function SessionParticipantStack({ participants }: SessionParticipantStackProps) {
  const { colorScheme } = useColorScheme();
  const stack = participantStack(participants, STACK_LIMIT);
  if (!stack) return null;

  // Each face is ringed in the surface colour, so the overlap reads as a cut.
  const ring = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={stack.label}
      className="rounded-full bg-background"
      style={{ height: STACK_HEIGHT, paddingHorizontal: 4 }}>
      <View className="flex-1 flex-row items-center">
        {stack.shown.map((person, index) => (
          <Avatar
            key={person.user_id}
            chalk
            size={FACE_SIZE}
            fallbackText={participantAvatarText(person)}
            imageUrl={person.avatar_url}
            style={{
              marginLeft: index === 0 ? 0 : -FACE_OVERLAP,
              borderRadius: FACE_SIZE / 2,
              borderWidth: 2,
              borderColor: ring,
            }}
          />
        ))}
        {stack.more > 0 ? (
          <Text variant="small" className="ml-1 leading-5">
            +{stack.more}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
