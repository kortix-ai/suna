/**
 * ParticipantAvatar — a person in a shared session, drawn like web's
 * `UserAvatar`: two initials on the person's chalk colours, a 1px chalk
 * border, `rounded-sm` corners, and the profile photo over it when one loads.
 * Used beside a user message and in the header stack.
 */
import * as React from 'react';
import { Text, type StyleProp, type ViewStyle } from 'react-native';
import type { SessionParticipant } from '@kortix/sdk';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { entityChalk } from '@/lib/ui/entity-chalk';
import { participantAvatarText, participantInitials } from '@/lib/session/participants';
import { webSpace } from '@/lib/session/user-message';
import { resolveLocalUrl } from '@/lib/utils/resolve-local-url';

/** Web `size-6`. */
export const PARTICIPANT_AVATAR_SIZE = Math.round(webSpace(6));
/** Web `rounded-sm`: `--radius` (10) minus 4. */
const RADIUS = 6;

interface ParticipantAvatarProps {
  person: SessionParticipant;
  style?: StyleProp<ViewStyle>;
}

export function ParticipantAvatar({ person, style }: ParticipantAvatarProps) {
  const text = participantAvatarText(person);
  const chalk = entityChalk(text);
  // A local-stack photo is served from `127.0.0.1`, which on a phone is the
  // phone: remap it like every other local URL. The image loader does not go
  // through the XHR loopback rewrite. Memoised: the primitive resets its load
  // state whenever the `source` object changes.
  const source = React.useMemo(
    () => (person.avatar_url ? { uri: resolveLocalUrl(person.avatar_url) } : null),
    [person.avatar_url],
  );
  return (
    <Avatar
      alt={text ?? '?'}
      className="items-center justify-center"
      style={[
        {
          width: PARTICIPANT_AVATAR_SIZE,
          height: PARTICIPANT_AVATAR_SIZE,
          borderRadius: RADIUS,
          borderWidth: 1,
          borderColor: chalk.border,
          backgroundColor: chalk.background,
        },
        style,
      ]}>
      {/* The image carries the radius too: some Android versions ignore the parent's clip. */}
      {source ? <AvatarImage source={source} style={{ borderRadius: RADIUS }} /> : null}
      <AvatarFallback className="rounded-none bg-transparent">
        <Text
          style={{ fontFamily: 'Roobert-SemiBold', fontSize: 10, letterSpacing: -0.2, color: chalk.foreground }}
          allowFontScaling={false}>
          {participantInitials(person)}
        </Text>
      </AvatarFallback>
    </Avatar>
  );
}
