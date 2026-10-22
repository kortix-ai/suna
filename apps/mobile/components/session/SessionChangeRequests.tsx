/**
 * SessionChangeRequests — the change requests one turn opened, at the end of
 * that turn (web: the turn's change request outcome cards, `TurnOutcomes`).
 *
 * The show tool's inline look (`ShowTool`): one `SettingsGroup rounded-lg` of
 * dense rows. A row is the Review page's row for the same item — its kind icon
 * in its status tone, the title, and "Change request #N · <state>" — and a tap
 * calls `onOpen`, which opens the page's one `ReviewDetailSheet` (the sheet the
 * Review page opens), so Merge and Request changes work here too.
 *
 * `SessionPage` reads the project's Review list once and anchors each change
 * request to its turn (`anchorChangeRequests`). Before KRTX-1678 every card sat
 * in the list footer, pinned under the newest turn whatever turn opened it.
 */
import * as React from 'react';
import { useColorScheme } from 'nativewind';

import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { REVIEW_KIND_ICONS } from '@/components/review/review-icons';
import { Icon } from '@/components/ui/icon';
import { haptics } from '@/lib/haptics';
import { reviewItemTone } from '@/lib/review/review-meta';
import { changeRequestStatusLabel, type ChangeItem } from '@/lib/session/session-change-requests';
import { THEME } from '@/lib/utils/theme';

export interface SessionChangeRequestsProps {
  /** This turn's change requests, oldest first. One stable array per turn. */
  items: readonly ChangeItem[];
  /** Opens the review sheet for one change request. Must be stable. */
  onOpen: (id: string) => void;
}

function SessionChangeRequestsImpl({ items, onOpen }: SessionChangeRequestsProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <SettingsGroup parentClassName="rounded-lg">
      {items.map((item) => {
        const tone = reviewItemTone(item.kind, item.status);
        const label = changeRequestStatusLabel(item);
        return (
          <SettingsRow
            key={item.id}
            leading={
              <Icon
                as={REVIEW_KIND_ICONS[item.kind]}
                size={20}
                color={tone === 'muted' ? THEME[isDark ? 'dark' : 'light'].mutedForeground : THEME.accent[tone]}
              />
            }
            label={item.title}
            description={label}
            dense
            accessibilityLabel={`${item.title}, ${label}`}
            onPress={() => {
              haptics.tap();
              onOpen(item.id);
            }}
          />
        );
      })}
    </SettingsGroup>
  );
}

export const SessionChangeRequests = React.memo(SessionChangeRequestsImpl);
