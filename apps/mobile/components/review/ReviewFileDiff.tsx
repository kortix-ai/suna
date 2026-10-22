/**
 * ReviewFileDiff — one file's diff, pushed inside `ReviewDetailSheet` when a
 * row of its Files list is tapped (Jay, 2026-09-27).
 *
 * Virtualized: a `BottomSheetFlatList` of the file's lines, so only the lines
 * near the screen are native views, whatever the file's size. The sheet used
 * to mount the whole patch (up to 2000 rows, each a view and two texts), which
 * made opening the sheet — and Merge, which closes it — stall the device.
 *
 * Lines wrap instead of scrolling sideways: a horizontal scroller around a
 * vertical list would defeat the virtualization. The patch comes from the
 * change request's diff query, which the sheet has already loaded for its
 * Files list; `parsePatchFile` parses this file only.
 */
import * as React from 'react';
import { View } from 'react-native';
import { BottomSheetFlatList } from '@gorhom/bottom-sheet';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { parsePatchFile, type DiffRow } from '@/lib/diff/parse-patch';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { diffRowPalette, DiffRowView } from '@/components/diff/PatchDiffView';

interface ReviewFileDiffProps {
  patch: string | undefined;
  path: string;
  isLoading: boolean;
  isError: boolean;
  isDark: boolean;
  /** Space under the last line: the home indicator. */
  bottomInset: number;
}

export function ReviewFileDiff({ patch, path, isLoading, isError, isDark, bottomInset }: ReviewFileDiffProps) {
  const palette = React.useMemo(() => diffRowPalette(isDark), [isDark]);
  const parsed = React.useMemo(() => (patch ? parsePatchFile(patch, path) : null), [patch, path]);
  const renderItem = React.useCallback(
    ({ item }: { item: DiffRow }) => <DiffRowView row={item} palette={palette} wrap />,
    [palette],
  );

  const empty = isLoading ? (
    <View className="gap-2 px-4 pt-2">
      <Skeleton className="h-4 w-full rounded" />
      <Skeleton className="h-4 w-4/5 rounded" />
      <Skeleton className="h-4 w-3/5 rounded" />
    </View>
  ) : (
    <Text variant="muted" className="px-6 pt-2">
      {isError
        ? 'The diff did not load.'
        : parsed?.binary
          ? 'Binary file — not shown.'
          : 'No line changes in this file.'}
    </Text>
  );

  return (
    <BottomSheetFlatList
      data={parsed && !parsed.binary ? parsed.rows : []}
      renderItem={renderItem}
      keyExtractor={(_row: DiffRow, index: number) => String(index)}
      ListEmptyComponent={empty}
      initialNumToRender={40}
      maxToRenderPerBatch={40}
      windowSize={9}
      removeClippedSubviews
      showsVerticalScrollIndicator
      contentContainerStyle={{ paddingBottom: bottomInset }}
    />
  );
}
