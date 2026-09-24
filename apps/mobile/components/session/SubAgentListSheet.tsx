/**
 * SubAgentListSheet — the "N sub-agents" sheet (COR-162). Lists the project
 * sessions this thread's session spawned (`subAgentsOf`,
 * `lib/session/sub-agents.ts` — the relation the session list nests by).
 * `KortixBottomSheetModal` + `SettingsGroup`/`SettingsRow`; each row is the
 * Sessions page's row: status mark · title · time, no chevron. Tapping a row
 * closes the sheet and opens that session through the project-session open
 * path (`onSelect` → `ProjectScreen.handleOpenProjectSession`).
 */
import * as React from 'react';
import { View } from 'react-native';
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import type { SheetRef } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionLastActivityAt,
  sessionStatusLabel,
  shortRelative,
  spokenRelative,
} from '@/lib/session/session-list';

export interface SubAgentListSheetProps {
  subAgents: ProjectSession[];
  onSelect: (session: ProjectSession) => void;
}

export const SubAgentListSheet = React.forwardRef<SheetRef, SubAgentListSheetProps>(
  function SubAgentListSheet({ subAgents, onSelect }, ref) {
    const insets = useSafeAreaInsets();
    const modalRef = React.useRef<BottomSheetModal>(null);
    // Read once per open, so the times do not tick while the sheet shows.
    const [now, setNow] = React.useState(() => Date.now());

    React.useImperativeHandle(ref, () => ({
      open: () => {
        setNow(Date.now());
        modalRef.current?.present();
      },
      close: () => modalRef.current?.dismiss(),
    }));

    return (
      <KortixBottomSheetModal
        ref={modalRef}
        enableDynamicSizing
        title="Sub-agents"
        topInset={insets.top}
        enablePanDownToClose>
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <View className="px-4">
            <SettingsGroup>
              {subAgents.map((session) => {
                const title = sessionDisplayTitle(session);
                const status = sessionDisplayStatus(session);
                const lastActivity = sessionLastActivityAt(session);
                return (
                  <SettingsRow
                    key={session.session_id}
                    leading={<SessionStatusMark status={status} />}
                    label={title}
                    value={shortRelative(lastActivity, now)}
                    right={null}
                    accessibilityLabel={`${title}, ${sessionStatusLabel(status)}, ${spokenRelative(lastActivity, now)}`}
                    accessibilityHint="Opens the session"
                    onPress={() => {
                      modalRef.current?.dismiss();
                      onSelect(session);
                    }}
                  />
                );
              })}
            </SettingsGroup>
          </View>
        </BottomSheetScrollView>
      </KortixBottomSheetModal>
    );
  },
);
