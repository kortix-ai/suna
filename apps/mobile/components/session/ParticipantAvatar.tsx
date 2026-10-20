/**
 * ParticipantAvatar — a person in a shared session, drawn like web's
 * `UserAvatar` (Avatar v2): a `rounded-sm` tile with one solid fill keyed on the email,
 * white initials, and the profile photo over it when one loads. No border.
 * A face under 28pt holds one initial, as web's `xs`/`sm`. Used above a user
 * message, in the header stack, the people sheet and the share form.
 */
import * as React from 'react';
import { Text, type StyleProp, type ViewStyle } from 'react-native';

import { AVATAR_INK, avatarFill } from '@kortix/shared';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { participantAvatarText, participantInitials, type AvatarPerson } from '@/lib/session/participants';
import { webSpace } from '@/lib/session/user-message';
import { resolveLocalUrl } from '@/lib/utils/resolve-local-url';

/** Web `size-6`. */
export const PARTICIPANT_AVATAR_SIZE = Math.round(webSpace(6));
/** Web `size-8`: the people sheet's rows (the hover card's `md`). */
export const PARTICIPANT_ROW_AVATAR_SIZE = Math.round(webSpace(8));

interface ParticipantAvatarProps {
  person: AvatarPerson;
  /** Default `PARTICIPANT_AVATAR_SIZE` (web `size-6`). */
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function ParticipantAvatar({ person, size = PARTICIPANT_AVATAR_SIZE, style }: ParticipantAvatarProps) {
  const text = participantAvatarText(person);
  // Web's seed: the email, else the name, so one person is one colour everywhere.
  const fill = avatarFill(person.email || text || '');
  // Web `rounded-sm`: `--radius` (10) minus 4. Never a circle (Jay, 2026-10-14).
  const radius = 6;
  const initials = participantInitials(person).slice(0, size < 28 ? 1 : 2);
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
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: fill,
        },
        style,
      ]}>
      {/* The image carries the radius too: some Android versions ignore the parent's clip. */}
      {source ? <AvatarImage source={source} style={{ borderRadius: radius }} /> : null}
      <AvatarFallback className="rounded-none bg-transparent">
        <Text
          style={{ fontFamily: 'Roobert-Medium', fontSize: Math.round(size * 0.42), color: AVATAR_INK }}
          allowFontScaling={false}>
          {initials}
        </Text>
      </AvatarFallback>
    </Avatar>
  );
}
