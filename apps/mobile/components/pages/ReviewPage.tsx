/**
 * ReviewPage — the project's review inbox (web parity: customize/review).
 *
 * One queue of everything that waits for a person: Change Requests, connector
 * calls that need approval, agent outputs, decisions and batches. Three
 * segments, as on web: Needs you, Waiting, Done. A row opens
 * `ReviewDetailSheet`, which holds the verdicts.
 *
 * Mobile leaves out web's bulk select, keyboard layer and per-session grouping.
 *
 * Review is the one page for changes (Jay, 2026-09-21). The separate Changes
 * page has no entry point: a change request is a review item, the header's
 * `+` opens one (`OpenCRSheet`), and the header's history button opens the
 * project's versions (branches) in a sheet.
 *
 * The segment switcher is the root tab bar's capsule (`FloatingTabCapsule`:
 * icon over label, a sliding thumb), pinned at the bottom over a fade of the
 * page — the same bar as Projects · Account (Jay, 2026-09-24). No counts on
 * the tabs. Three tabs fill the capsule's width on a 360pt phone, so the `+`
 * lives in the header. The list is one `SettingsGroup` of `SettingsRow`s, the
 * app's list (Jay, 2026-09-23).
 */
import * as React from 'react';
import { RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useQueryClient } from '@tanstack/react-query';
import { useColorScheme } from 'nativewind';
import {
  reviewSegmentForStatus,
  type ReviewItem,
  type ReviewSegment,
} from '@kortix/sdk';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { FloatingTabCapsule, type FloatingTabItem } from '@/components/navigation/FloatingTabBar';
import { FLOATING_BAR_HEIGHT } from '@/components/navigation/tab-bar-layout';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import {
  type SheetRef,
  KortixBottomSheetModal,
} from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { OpenCRSheet, shortRef } from '@/components/review/OpenCRSheet';
import { ReviewDetailSheet } from '@/components/review/ReviewDetailSheet';
import { REVIEW_KIND_ICONS } from '@/components/review/review-icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { BellIcon, CheckCircleIcon, ClockCounterClockwiseIcon, ClockIcon } from '@/lib/icons';
import { useProjectBranches, useProjectSessions } from '@/lib/projects/hooks';
import { relativeTime } from '@/lib/projects/triggers-format';
import {
  REVIEW_SEGMENTS,
  formatReviewAge,
  reviewItemTone,
  reviewRiskLabel,
  type ReviewTone,
} from '@/lib/review/review-meta';
import { reviewKeys, useReviewItems } from '@/lib/review/use-review';
import { THEME } from '@/lib/utils/theme';
import { sessionDisplayTitle } from '@/lib/session/session-list';
import type { PageTab } from '@/stores/tab-store';

const SEGMENT_ICONS: Record<ReviewSegment, typeof BellIcon> = {
  needs_you: BellIcon,
  waiting: ClockIcon,
  done: CheckCircleIcon,
};

/** The pinned tab bar: the root tab bar's capsule, one tab per segment, no counts. */
const SEGMENT_TABS: FloatingTabItem[] = REVIEW_SEGMENTS.map(({ key, label }) => ({
  key,
  label,
  icon: <Icon as={SEGMENT_ICONS[key]} size={20} className="text-foreground" />,
}));

interface ReviewPageProps {
  page: PageTab;
  projectId: string;
  onOpenSession: (sessionId: string) => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const EMPTY_TITLE: Record<ReviewSegment, string> = {
  needs_you: 'Nothing needs you',
  waiting: 'Nothing is waiting',
  done: 'Nothing reviewed yet',
};

export function ReviewPage({
  page,
  projectId,
  onOpenSession,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: ReviewPageProps) {
  const insets = useSafeAreaInsets();
  const sheetRef = React.useRef<SheetRef>(null);
  const createSheetRef = React.useRef<BottomSheetModal>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const versionsSheetRef = React.useRef<BottomSheetModal>(null);
  const { height } = useWindowDimensions();
  const pageBackground = THEME[isDark ? 'dark' : 'light'].background;
  const contentInset = usePinnedBarInset(FLOATING_BAR_HEIGHT);
  const [segment, setSegment] = React.useState<ReviewSegment>('needs_you');
  // The project's branches load when the versions sheet first opens.
  const [versionsOpened, setVersionsOpened] = React.useState(false);
  const branchesQuery = useProjectBranches(projectId, versionsOpened);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  // Session titles name the thread a connector approval came from.
  const sessionsQuery = useProjectSessions(projectId, { poll: false });
  const sessionLabels = React.useMemo(() => {
    const labels: Record<string, string> = {};
    for (const session of sessionsQuery.data ?? []) {
      labels[session.session_id] = sessionDisplayTitle(session);
    }
    return labels;
  }, [sessionsQuery.data]);

  const { data, isLoading, isError, error, refetch } = useReviewItems(projectId, {
    sessionLabels,
  });
  // Only a pull shows the refresh spinner. The 8 s poll refetches silently:
  // `isRefetching` would show the spinner and push the list down on every poll.
  const [pulling, setPulling] = React.useState(false);
  const handlePull = React.useCallback(() => {
    setPulling(true);
    void refetch().finally(() => setPulling(false));
  }, [refetch]);
  const items = data ?? [];

  const visible = React.useMemo(
    () => items.filter((item) => reviewSegmentForStatus(item.status) === segment),
    [items, segment],
  );
  const toneColor = React.useCallback(
    (tone: ReviewTone) =>
      tone === 'muted'
        ? (isDark ? THEME.dark : THEME.light).mutedForeground
        : THEME.accent[tone],
    [isDark],
  );
  // Read from the live list, so a verdict made elsewhere updates the open sheet.
  const selected = React.useMemo<ReviewItem | null>(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  const openItem = React.useCallback((id: string) => {
    haptics.tap();
    setSelectedId(id);
    sheetRef.current?.open();
  }, []);

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        onAdd={() => {
          haptics.tap();
          createSheetRef.current?.present();
        }}
        addLabel="Open a change request"
        rightActions={
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onPress={() => {
              haptics.tap();
              setVersionsOpened(true);
              versionsSheetRef.current?.present();
            }}
            accessibilityLabel="Versions"
            accessibilityHint="Opens the project's versions">
            <Icon as={ClockCounterClockwiseIcon} size={20} className="text-foreground" />
          </Button>
        }
      />

      <PageContent>
        <View className="flex-1">
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: contentInset }}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={pulling} onRefresh={handlePull} />}>
            {/* A failed background refetch keeps the list: the error shows only with no data. */}
            {isLoading ? (
              <View className="gap-3 px-4 pt-3">
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-14 w-full rounded-xl" />
              </View>
            ) : isError && !data ? (
              <View className="items-center gap-4 px-6 pt-16">
                <Text variant="muted" className="text-center">
                  {(error as Error)?.message ?? 'The review items did not load'}
                </Text>
                <Button variant="secondary" size="lg" className="rounded-full" onPress={() => void refetch()}>
                  <Text>Try again</Text>
                </Button>
              </View>
            ) : visible.length === 0 ? (
              <View className="items-center px-6 pt-16">
                <Text variant="muted">{EMPTY_TITLE[segment]}</Text>
              </View>
            ) : (
              // Settings rows in a group (Jay, 2026-09-23): the app's list, as on
              // Agents, Skills and Schedules — not `ListRow`.
              <View className="px-4 pt-1">
                <SettingsGroup>
                  {visible.map((item) => {
                    const risk = reviewRiskLabel(item.risk);
                    const meta = [item.agent, formatReviewAge(item.createdAt), risk].filter(Boolean).join(' · ');
                    return (
                      <SettingsRow
                        key={item.id}
                        leading={
                          <Icon
                            as={REVIEW_KIND_ICONS[item.kind]}
                            size={20}
                            color={toneColor(reviewItemTone(item.kind, item.status))}
                          />
                        }
                        label={item.title}
                        description={item.summary ? `${item.summary} · ${meta}` : meta}
                        onPress={() => openItem(item.id)}
                      />
                    );
                  })}
                </SettingsGroup>
              </View>
            )}
          </ScrollView>

          {/* Pinned bottom bar: the root tab bar's capsule, over a fade of
              the page — the same bar as Projects · Account. */}
          <PinnedBar controlHeight={FLOATING_BAR_HEIGHT} background={pageBackground} className="justify-center px-4">
            <FloatingTabCapsule
              items={SEGMENT_TABS}
              activeIndex={REVIEW_SEGMENTS.findIndex(({ key }) => key === segment)}
              onSelect={(index) => {
                const next = REVIEW_SEGMENTS[index].key;
                if (next === segment) return;
                haptics.selection();
                setSegment(next);
              }}
            />
          </PinnedBar>
        </View>
      </PageContent>

      {/* Open a change request. The new request is a review item. */}
      <KortixBottomSheetModal
        ref={createSheetRef}
        snapPoints={['88%']}
        enableDynamicSizing={false}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
>
        <OpenCRSheet
          projectId={projectId}
          isDark={isDark}
          onClose={() => createSheetRef.current?.dismiss()}
          onCreated={(_crId, number) => {
            createSheetRef.current?.dismiss();
            setSegment('needs_you');
            void queryClient.invalidateQueries({ queryKey: reviewKeys.list(projectId) });
            toast.success(`Opened change request #${number}`);
          }}
        />
      </KortixBottomSheetModal>

      {/* The project's versions (branches). Each row is a `SettingsRow`: the
          default branch takes a check mark instead of a "default" badge, and
          there's no leading git-branch icon — the ref name carries it. */}
      <KortixBottomSheetModal
        ref={versionsSheetRef}
        title="Versions"
        enableDynamicSizing
        maxDynamicContentSize={Math.floor(height * 0.8)}
        enablePanDownToClose
>
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          {branchesQuery.isLoading ? (
            <View className="gap-3 px-4 pt-2">
              <Skeleton className="h-12 w-full rounded-xl" />
              <Skeleton className="h-12 w-full rounded-xl" />
            </View>
          ) : branchesQuery.isError ? (
            <Text variant="muted" className="px-6 py-6">
              The versions did not load.
            </Text>
          ) : (branchesQuery.data?.branches ?? []).length === 0 ? (
            <Text variant="muted" className="px-6 py-6">
              No versions yet
            </Text>
          ) : (
            <View className="px-4">
              <SettingsGroup>
                {(branchesQuery.data?.branches ?? []).map((branch) => {
                  const delta = branch.is_default
                    ? ''
                    : [branch.ahead ? `↑${branch.ahead}` : '', branch.behind ? `↓${branch.behind}` : '']
                        .filter(Boolean)
                        .join(' ');
                  return (
                    <SettingsRow
                      key={branch.name}
                      label={shortRef(branch.name)}
                      labelClassName="font-semibold"
                      description={
                        (branch.subject || 'No commits') +
                        (branch.committed_at ? ` · ${relativeTime(branch.committed_at)}` : '')
                      }
                      value={delta || undefined}
                      checked={branch.is_default}
                    />
                  );
                })}
              </SettingsGroup>
            </View>
          )}
        </BottomSheetScrollView>
      </KortixBottomSheetModal>

      <ReviewDetailSheet
        ref={sheetRef}
        projectId={projectId}
        item={selected}
        // The selection stays: clearing it would empty the sheet while it closes.
        onDismiss={() => {}}
        onOpenSession={onOpenSession}
      />
    </View>
  );
}
