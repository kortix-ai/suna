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
import { THEME, withAlpha } from '@/lib/utils/theme';

interface ReviewFileDiffProps {
  patch: string | undefined;
  path: string;
  isLoading: boolean;
  isError: boolean;
  isDark: boolean;
  /** Space under the last line: the home indicator. */
  bottomInset: number;
}

interface LinePalette {
  fg: string;
  muted: string;
  add: string;
  del: string;
  hunk: string;
  addBg: string;
  delBg: string;
  hunkBg: string;
}

function linePalette(isDark: boolean): LinePalette {
  const theme = isDark ? THEME.dark : THEME.light;
  return {
    fg: theme.foreground,
    muted: theme.mutedForeground,
    add: THEME.accent.green,
    del: theme.destructive,
    hunk: THEME.accent.purple,
    addBg: withAlpha(THEME.accent.green, isDark ? 0.14 : 0.12),
    delBg: withAlpha(theme.destructive, isDark ? 0.14 : 0.1),
    hunkBg: withAlpha(THEME.accent.purple, isDark ? 0.12 : 0.08),
  };
}

const DiffLine = React.memo(function DiffLine({ row, palette }: { row: DiffRow; palette: LinePalette }) {
  const bg =
    row.kind === 'add' ? palette.addBg : row.kind === 'del' ? palette.delBg : row.kind === 'hunk' ? palette.hunkBg : undefined;
  const color =
    row.kind === 'add' ? palette.add : row.kind === 'del' ? palette.del : row.kind === 'hunk' ? palette.hunk : palette.fg;
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', backgroundColor: bg, paddingVertical: 1 }}>
      <Text
        style={{ width: 44, textAlign: 'right', paddingRight: 8, fontSize: 11, lineHeight: 18, fontFamily: MONO_FONT_FAMILY, color: palette.muted }}>
        {row.kind === 'hunk' ? '' : (row.num ?? '')}
      </Text>
      <Text style={{ flex: 1, fontSize: 12, lineHeight: 18, fontFamily: MONO_FONT_FAMILY, color, paddingRight: 12 }}>
        {row.kind === 'hunk' ? row.text : `${sign} ${row.text}`}
      </Text>
    </View>
  );
});

export function ReviewFileDiff({ patch, path, isLoading, isError, isDark, bottomInset }: ReviewFileDiffProps) {
  const palette = React.useMemo(() => linePalette(isDark), [isDark]);
  const parsed = React.useMemo(() => (patch ? parsePatchFile(patch, path) : null), [patch, path]);
  const renderItem = React.useCallback(
    ({ item }: { item: DiffRow }) => <DiffLine row={item} palette={palette} />,
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
