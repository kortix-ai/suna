/**
 * PageList — the scrolling list of a project tool page (Agents, Skills,
 * Schedules, Secrets): one place for its states and its edges, so
 * every list page reads the same (Jay, 2026-09-22).
 *
 * - loading: three `Skeleton` rows. Never an `ActivityIndicator`.
 * - error (and nothing to show): the message, one muted line, and a secondary
 *   `lg` pill "Try again".
 * - empty: one muted line. No icon, no button: the page's create action is the
 *   header's `+`.
 * - rows: the children, usually `ListRow`s with no icon tile.
 *
 * The list fades at both ends (`scroll-fade`): the bottom always, the top once a
 * row has scrolled under the search field. The content pads by the bottom fade,
 * so the last row can rest above it.
 */
import * as React from 'react';
import { RefreshControl, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BOTTOM_FADE_HEIGHT,
  BottomFade,
  TopFade,
  useScrollFade,
} from '@/components/kortix/scroll-fade';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';

interface PageListProps {
  isLoading?: boolean;
  /** Shown with "Try again" when set. Pass it only when there is nothing to list. */
  errorMessage?: string | null;
  onRetry?: () => void;
  /** Shown when set: "No schedules yet", "No matching schedules", a no-access line. */
  emptyLabel?: string | null;
  /** Pull to refresh. Only a pull shows the spinner; a background poll does not. */
  onRefresh?: () => Promise<unknown>;
  /** Content above the rows that scrolls with them (a count line, a banner). */
  header?: React.ReactNode;
  /** Content below the rows that scrolls with them. */
  footer?: React.ReactNode;
  children?: React.ReactNode;
}

export function PageList({
  isLoading = false,
  errorMessage = null,
  onRetry,
  emptyLabel = null,
  onRefresh,
  header,
  footer,
  children,
}: PageListProps) {
  const insets = useSafeAreaInsets();
  const { onScroll, topFadeStyle } = useScrollFade();
  const [pulling, setPulling] = React.useState(false);
  const handlePull = React.useCallback(() => {
    if (!onRefresh) return;
    setPulling(true);
    void onRefresh().finally(() => setPulling(false));
  }, [onRefresh]);

  return (
    <View className="flex-1">
      <Animated.ScrollView
        className="flex-1"
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: BOTTOM_FADE_HEIGHT + insets.bottom }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? <RefreshControl refreshing={pulling} onRefresh={handlePull} /> : undefined
        }>
        {isLoading ? (
          <View className="gap-3 px-4 pt-3">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </View>
        ) : errorMessage ? (
          <View className="items-center gap-4 px-6 pt-16">
            <Text variant="muted" className="text-center">
              {errorMessage}
            </Text>
            {onRetry ? (
              <Button
                variant="secondary"
                size="lg"
                className="rounded-full"
                onPress={() => {
                  haptics.tap();
                  onRetry();
                }}>
                <Text>Try again</Text>
              </Button>
            ) : null}
          </View>
        ) : emptyLabel ? (
          <View className="items-center px-6 pt-16">
            <Text variant="muted" className="text-center">
              {emptyLabel}
            </Text>
          </View>
        ) : (
          <>
            {header}
            {children}
          </>
        )}
        {footer}
      </Animated.ScrollView>
      <TopFade style={topFadeStyle} />
      <BottomFade />
    </View>
  );
}

/** A 6pt status dot for a row's trailing slot: on (green) or off (muted). */
export function StatusDot({ on, label }: { on: boolean; label: string }) {
  return (
    <View
      accessibilityLabel={label}
      className={on ? 'size-1.5 rounded-full bg-kortix-green' : 'size-1.5 rounded-full bg-muted-foreground/40'}
    />
  );
}
