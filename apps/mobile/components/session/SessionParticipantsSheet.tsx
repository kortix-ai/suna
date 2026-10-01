/**
 * SessionParticipantsSheet — who can open this session, opened from the
 * header's avatar stack. Web's hover card on a phone: "People" with the
 * count, then one row per person: avatar, name, email. Read-only, like the
 * card: rows open nothing. `KortixBottomSheetModal` + `SettingsGroup` /
 * `SettingsRow`, the `SubAgentListSheet` pattern.
 */
import * as React from 'react';
import { View } from 'react-native';
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SessionParticipants } from '@kortix/sdk';

import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import type { SheetRef } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { ParticipantAvatar, PARTICIPANT_ROW_AVATAR_SIZE } from '@/components/session/ParticipantAvatar';
import { Text } from '@/components/ui/text';
import { participantSheetRows } from '@/lib/session/participants';

export interface SessionParticipantsSheetProps {
  participants: SessionParticipants | undefined;
}

export const SessionParticipantsSheet = React.forwardRef<SheetRef, SessionParticipantsSheetProps>(
  function SessionParticipantsSheet({ participants }, ref) {
    const insets = useSafeAreaInsets();
    const modalRef = React.useRef<BottomSheetModal>(null);
    const { rows, more } = participantSheetRows(participants);

    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));

    return (
      <KortixBottomSheetModal
        ref={modalRef}
        enableDynamicSizing
        title="People"
        titleTrailing={
          <View className="h-10 min-w-10 items-center justify-center">
            <Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
              {participants?.total ?? 0}
            </Text>
          </View>
        }
        topInset={insets.top}
        enablePanDownToClose>
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <View className="px-4">
            <SettingsGroup>
              {rows.map((row) => (
                <SettingsRow
                  key={row.key}
                  leading={<ParticipantAvatar person={row.person} size={PARTICIPANT_ROW_AVATAR_SIZE} />}
                  label={row.name}
                  description={row.email ?? undefined}
                  right={null}
                  accessibilityLabel={row.email ? `${row.name}, ${row.email}` : row.name}
                />
              ))}
            </SettingsGroup>
            {more > 0 ? (
              <Text variant="muted" className="px-1 pt-3">
                {more === 1 ? '1 more person can open this session' : `${more} more people can open this session`}
              </Text>
            ) : null}
          </View>
        </BottomSheetScrollView>
      </KortixBottomSheetModal>
    );
  },
);
