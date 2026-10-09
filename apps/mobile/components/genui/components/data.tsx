import { Fragment } from 'react';
import { Pressable, View } from 'react-native';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from '@/lib/icons';
import { tableColumnWidths } from '@/lib/markdown/table-layout';

import { kids } from './layout';
import { openGenuiLink } from './open-link';

// A trend is direction, not a verdict (revenue up is good, cost up is not), so the glyph stays muted.
const TREND = { up: ArrowUpRightIcon, down: ArrowDownRightIcon, flat: MinusIcon } as const;
const CELL = 'px-3 py-2';

const strings = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

export function GenuiStat({ props }: GenuiComponentProps) {
  const trend = props.trend ? TREND[props.trend as keyof typeof TREND] : null;
  return (
    <View className="min-w-[45%] flex-1 gap-0.5 rounded-2xl bg-card px-4 py-3">
      <Text variant="muted">{props.label}</Text>
      {/* `large`, not `h4`: the number is not a heading. */}
      <Text variant="large" className="tabular-nums">
        {props.value}
        {props.unit ? <Text variant="muted"> {props.unit}</Text> : null}
      </Text>
      {props.delta ? (
        <View className="flex-row items-center gap-1">
          {trend ? <Icon as={trend} size={12} className="text-muted-foreground" /> : null}
          <Text variant="muted" className="tabular-nums">
            {props.delta}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function GenuiStatRow({ props, renderChild }: GenuiComponentProps) {
  return <View className="flex-row flex-wrap gap-3">{kids(props.stats).map(renderChild)}</View>;
}

/** A column reads as numbers when every filled cell is one: it aligns right, header included. */
const numericColumns = (columns: string[], rows: unknown[][]): boolean[] =>
  columns.map(
    (_, c) => rows.some((row) => typeof row[c] === 'number') && rows.every((row) => row[c] == null || typeof row[c] === 'number'),
  );

/**
 * Each row is its own flex row, so columns line up only when every row gives a column the same basis:
 * the markdown table's estimate from the longest cell. Rows grow together to fill a wide screen.
 */
function columnBases(columns: string[], rows: unknown[][]): number[] {
  const cell = (type: string) => (value: unknown) => ({ type, content: String(value ?? '') });
  return tableColumnWidths(
    [
      { isHeader: true, rows: [columns.map(cell('th'))] },
      { isHeader: false, rows: rows.map((row) => columns.map((_, c) => cell('td')(row[c]))) },
    ],
    columns.length,
  ).map(Math.ceil);
}

export function GenuiTable({ props }: GenuiComponentProps) {
  const columns = props.columns as string[];
  const rows = props.rows as unknown[][];
  const numeric = numericColumns(columns, rows);
  const bases = columnBases(columns, rows);
  const cellStyle = (c: number) => ({ flexBasis: bases[c], flexGrow: 1, flexShrink: 0 });
  const align = (c: number) => (numeric[c] ? 'text-right' : '');
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      <GHScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
        <View className="grow">
          <View className="flex-row bg-secondary">
            {columns.map((column, c) => (
              <Text key={c} style={cellStyle(c)} variant="small" className={`${CELL} leading-5 ${align(c)}`}>
                {column}
              </Text>
            ))}
          </View>
          {rows.map((row, r) => (
            <Fragment key={r}>
              {r > 0 ? <Separator /> : null}
              <View className="flex-row">
                {columns.map((_, c) => (
                  <Text key={c} style={cellStyle(c)} className={`${CELL} text-sm ${numeric[c] ? 'text-right tabular-nums' : ''}`}>
                    {String(row[c] ?? '')}
                  </Text>
                ))}
              </View>
            </Fragment>
          ))}
        </View>
      </GHScrollView>
      {props.caption ? (
        <Text variant="muted" className="px-3 py-2">
          {props.caption}
        </Text>
      ) : null}
    </View>
  );
}

/** On a phone a comparison reads best as one card per option, specs listed in the same order. */
export function GenuiCompare({ props }: GenuiComponentProps) {
  const { t } = useTranslation();
  const specs = strings(props.specs);
  return (
    <View className="gap-3">
      {kids(props.items).map((item) => (
        <View key={item.id} className="gap-2 rounded-2xl bg-card px-4 py-3">
          <View className="flex-row items-center justify-between gap-3">
            <Text variant="large" className="shrink">
              {String(item.props.name)}
            </Text>
            {props.winner === item.props.name ? (
              <Badge>
                <Text>{t('genui.pick', 'Pick')}</Text>
              </Badge>
            ) : null}
          </View>
          {/* Keyed by position: a model may repeat a spec label or a note. */}
          {specs.map((spec, i) => (
            <View key={i} className="flex-row justify-between gap-3">
              <Text variant="muted">{spec}</Text>
              <Text className="shrink text-right">{strings(item.props.values)[i] ?? '—'}</Text>
            </View>
          ))}
          {strings(item.props.pros).map((pro, i) => (
            <Text key={`+${i}`}>+ {pro}</Text>
          ))}
          {strings(item.props.cons).map((con, i) => (
            <Text key={`-${i}`} variant="muted">
              − {con}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export function GenuiRankedList({ props }: GenuiComponentProps) {
  const items = kids(props.items);
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      {items.map((item, index) => {
        const href = item.props.href;
        const row = (
          <View className="flex-row gap-3 px-4 py-3">
            <Text variant="muted" className="w-5 tabular-nums">
              {index + 1}
            </Text>
            <View className="flex-1 gap-0.5">
              <View className="flex-row items-baseline gap-3">
                <Text className={`flex-1 font-medium ${href ? 'underline' : ''}`}>{String(item.props.title)}</Text>
                {item.props.meta ? (
                  <Text variant="muted" className="max-w-[40%] text-right">
                    {String(item.props.meta)}
                  </Text>
                ) : null}
              </View>
              <Text variant="muted">{String(item.props.reason)}</Text>
            </View>
          </View>
        );
        return (
          <View key={item.id}>
            {index > 0 ? <Separator /> : null}
            {href ? (
              <Pressable accessibilityRole="link" className="active:opacity-70" onPress={() => openGenuiLink(href)}>
                {row}
              </Pressable>
            ) : (
              row
            )}
          </View>
        );
      })}
    </View>
  );
}
