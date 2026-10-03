/**
 * SessionsFilterSheet — the Sessions page's status filter, a
 * `KortixBottomSheetModal`: one group of toggleable status rows, then Reset
 * while any is picked. Empty selection = every status. Basic on purpose — no
 * date range or sort, unlike web's fuller filter panel. The page owns the
 * picked-status chip and the shared Reset (search + statuses) around it.
 */

import * as React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { XIcon } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import {
  SESSION_STATUS_FILTERS,
  sessionStatusLabel,
  type SessionStatusFilter,
} from '@/lib/session/session-list';

export function SessionsFilterSheet({
  sheetRef,
  statusFilter,
  onToggleStatus,
  onReset,
}: {
  /** The page's ref: the header's Filter action presents this sheet. */
  sheetRef: React.RefObject<BottomSheetModal | null>;
  /** Picked statuses, per project (`useSessionFilterStore`). Empty = every status. */
  statusFilter: ReadonlySet<SessionStatusFilter>;
  /** Toggles one status row (the store owns the persistence). */
  onToggleStatus: (status: SessionStatusFilter) => void;
  /** The page's one Reset: search and statuses together. */
  onReset: () => void;
}) {
  const insets = useSafeAreaInsets();
  const statusFilterActive = statusFilter.size > 0;
  return (
    <KortixBottomSheetModal ref={sheetRef} title="Filter sessions" enableDynamicSizing enablePanDownToClose>
      <BottomSheetScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
        <SettingsGroup>
          {SESSION_STATUS_FILTERS.map((status) => (
            <SettingsRow
              key={status}
              leading={<SessionStatusMark status={status} />}
              label={sessionStatusLabel(status)}
              checked={statusFilter.has(status)}
              right={null}
              onPress={() => onToggleStatus(status)}
            />
          ))}
        </SettingsGroup>
        {statusFilterActive ? (
          <Button variant="secondary" size="lg" className="mt-4 rounded-full" onPress={onReset}>
            <Text>Reset</Text>
          </Button>
        ) : null}
      </BottomSheetScrollView>
    </KortixBottomSheetModal>
  );
}
