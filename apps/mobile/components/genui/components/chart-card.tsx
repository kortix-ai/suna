/**
 * The genui chart card shell: the title + Show-data header row, the series
 * legend, the figure slot, and the values sheet with the `DataTable`. The
 * bar/line model lives in `./charts`, the pie model in `./chart-pie`.
 */

import { useRef, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';

import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';

export type Cell = string | number | null;
export type Slice = { key: string; label: string; value: number; percent: number; fill: string };

/** The card every genui chart renders through: the title + Show-data header
 * row, the series legend, the figure, and the values sheet. */
export function ChartCard({
  title,
  legend,
  palette = [],
  head,
  rows,
  format,
  children,
}: {
  title: string;
  legend: string[];
  /** Legend swatch colors, one per series. */
  /** Swatch colors for the legend dots; a card without a legend (pie) needs none. */
  palette?: string[];
  head: string[];
  rows: Cell[][];
  format: (value: Cell) => string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const sheet = useRef<BottomSheetModal>(null);
  return (
    <View className="gap-2 rounded-2xl bg-card p-4">
      {/* Header row: the source as the title on the left, Show data on the right. */}
      <View className="flex-row items-center gap-3">
        <Text variant="small" numberOfLines={1} className="flex-1 leading-5">
          {title}
        </Text>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          className="py-0.5 active:opacity-70"
          onPress={() => sheet.current?.present()}
        >
          <Text variant="muted">{t('genui.showData', 'Show data')}</Text>
        </Pressable>
      </View>
      {legend.length > 0 ? (
        <View className="flex-row flex-wrap gap-x-4 gap-y-1">
          {legend.map((name, i) => (
            <View key={i} className="flex-row items-center gap-1.5">
              <View style={{ backgroundColor: palette[i] }} className="size-2.5 rounded-sm" />
              <Text variant="muted">{name}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {children}
      <KortixBottomSheetModal ref={sheet} title={t('genui.showData', 'Show data')} snapPoints={['60%']} enableDynamicSizing={false}>
        {/* The table scrolls inside the sheet, so a 365-point series keeps the title row in view. */}
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
          <Text variant="muted" className="pb-2">
            {title}
          </Text>
          <DataTable head={head} rows={rows} format={format} />
        </BottomSheetScrollView>
      </KortixBottomSheetModal>
    </View>
  );
}

/** Every value as text, so color never carries a number alone. Label column wider; values align right. */
function DataTable({ head, rows, format }: { head: string[]; rows: Cell[][]; format: (value: Cell) => string }) {
  const flex = (c: number) => ({ flex: c === 0 ? 1.4 : 1 });
  return (
    <View>
      <View className="flex-row gap-3 py-1.5">
        {head.map((cell, c) => (
          <Text key={c} style={flex(c)} variant="muted" className={c > 0 ? 'text-right' : ''}>
            {cell}
          </Text>
        ))}
      </View>
      {rows.map((row, r) => (
        <View key={r}>
          <Separator />
          <View className="flex-row gap-3 py-1.5">
            {row.map((cell, c) =>
              c === 0 ? (
                <Text key={c} style={flex(c)} variant="muted">
                  {format(cell)}
                </Text>
              ) : (
                <Text key={c} style={flex(c)} variant="small" className="text-right leading-5 tabular-nums">
                  {format(cell)}
                </Text>
              ),
            )}
          </View>
        </View>
      ))}
    </View>
  );
}
