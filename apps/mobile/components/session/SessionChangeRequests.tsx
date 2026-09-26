/**
 * SessionChangeRequests — the change requests this session opened, at the
 * bottom of the thread (web: the thread's change request outcome cards).
 *
 * The show tool's inline look (`ShowTool`): one `SettingsGroup rounded-lg` of
 * dense rows. A row is the Review page's row for the same item — its kind icon
 * in its status tone, the title, and "Change request #N · <state>" — and a tap
 * opens the same `ReviewDetailSheet` the Review page opens, so Merge and
 * Request changes work here too (Jay, 2026-09-27).
 *
 * Reads the project's Review list (`useReviewItems`, the query `ProjectScreen`
 * already polls while focused), so it adds no request of its own. Renders
 * nothing when the session opened no change request.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import type { SheetRef } from '@/components/kortix/sheet';
import { ReviewDetailSheet } from '@/components/review/ReviewDetailSheet';
import { REVIEW_KIND_ICONS } from '@/components/review/review-icons';
import { Icon } from '@/components/ui/icon';
import { haptics } from '@/lib/haptics';
import { reviewItemTone } from '@/lib/review/review-meta';
import { useReviewItems } from '@/lib/review/use-review';
import { changeRequestStatusLabel, sessionChangeRequests } from '@/lib/session/session-change-requests';
import { THEME } from '@/lib/utils/theme';

export interface SessionChangeRequestsProps {
  projectId: string;
  /** The Kortix project session (`origin_session_id`), not the OpenCode id. */
  projectSessionId: string;
  style?: React.ComponentProps<typeof View>['style'];
}

export function SessionChangeRequests({ projectId, projectSessionId, style }: SessionChangeRequestsProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const sheetRef = React.useRef<SheetRef>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const { data } = useReviewItems(projectId, { poll: false });
  const changes = React.useMemo(() => sessionChangeRequests(data, projectSessionId), [data, projectSessionId]);
  // Read from the live list, so a merge made elsewhere updates the open sheet.
  const selected = React.useMemo(
    () => changes.find((item) => item.id === selectedId) ?? null,
    [changes, selectedId],
  );

  if (changes.length === 0) return null;

  return (
    <View style={style}>
      <SettingsGroup parentClassName="rounded-lg">
        {changes.map((item) => {
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
                setSelectedId(item.id);
                sheetRef.current?.open();
              }}
            />
          );
        })}
      </SettingsGroup>
      <ReviewDetailSheet ref={sheetRef} projectId={projectId} item={selected} />
    </View>
  );
}
