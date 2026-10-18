import { createContext, Fragment, useContext, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Icon } from '@/components/ui/icon';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { CheckCircleIcon, CircleIcon, MinusIcon, TrendDownIcon, TrendUpIcon } from '@/lib/icons';
import { TYPE } from '@/lib/markdown/markdown-layout';
import { tableColumnWidths } from '@/lib/markdown/table-layout';

import { GenuiImageView } from './inline';
import { kids, THUMB } from './layout';
import { openGenuiLink } from './open-link';

// As on web: the glyph and the color follow the trend; with no trend, the delta's leading sign. The sign and
// the glyph repeat the meaning, so color is never its only carrier.
const TREND = {
  up: { icon: TrendUpIcon, tone: 'text-kortix-green' },
  down: { icon: TrendDownIcon, tone: 'text-kortix-red' },
  flat: { icon: MinusIcon, tone: 'text-muted-foreground' },
} as const;
const CELL = 'px-3 py-2';

const strings = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

function trendOf(props: Record<string, unknown>): keyof typeof TREND | null {
  if (props.trend === 'up' || props.trend === 'down' || props.trend === 'flat') return props.trend;
  const sign = /^\s*([+\-−])\s?\S?\d/.exec(String(props.delta ?? ''))?.[1];
  return sign === '+' ? 'up' : sign ? 'down' : null;
}

/** True for a Stat inside a StatRow: it renders as one cell of the row's card. On its own it is set larger. */
const InStatRow = createContext(false);

export function GenuiStat({ props }: GenuiComponentProps) {
  const inRow = useContext(InStatRow);
  const trend = trendOf(props);
  const tone = trend ? TREND[trend] : null;
  return (
    <View className={inRow ? 'flex-1 gap-0.5 px-4 py-3' : 'gap-0.5 rounded-2xl bg-card px-4 py-3'}>
      <Text variant="muted">{props.label}</Text>
      <View className="flex-row items-baseline gap-1">
        {/* `large` / `h4` for the size; medium, as on web: the number is not a heading. */}
        <Text variant={inRow ? 'large' : 'h4'} className="font-medium tabular-nums">
          {props.value}
        </Text>
        {props.unit ? <Text variant="muted">{props.unit}</Text> : null}
      </View>
      {props.delta ? (
        <View className="flex-row items-center gap-1">
          {tone ? <Icon as={tone.icon} size={14} className={tone.tone} /> : null}
          <Text variant="small" className={`leading-5 tabular-nums ${tone?.tone ?? 'text-muted-foreground'}`}>
            {props.delta}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * One card split by separators (web's divided band, in the mobile surface): two stats per row on a phone,
 * a vertical separator between them and a horizontal one between rows. An odd last stat takes the full row.
 */
export function GenuiStatRow({ props, renderChild }: GenuiComponentProps) {
  const stats = kids(props.stats);
  const rows = Array.from({ length: Math.ceil(stats.length / 2) }, (_, r) => stats.slice(r * 2, r * 2 + 2));
  return (
    <InStatRow.Provider value>
      <View className="overflow-hidden rounded-2xl bg-card">
        {rows.map((pair, r) => (
          <Fragment key={r}>
            {r > 0 ? <Separator /> : null}
            <View className="flex-row">
              {pair.map((stat, c) => (
                <Fragment key={stat.id}>
                  {c > 0 ? <Separator orientation="vertical" /> : null}
                  {renderChild(stat)}
                </Fragment>
              ))}
            </View>
          </Fragment>
        ))}
      </View>
    </InStatRow.Provider>
  );
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
  // 14/20 like a markdown table (markdown-table.tsx), through the token rather than a text-sm class.
  const cellStyle = (c: number) => ({ flexBasis: bases[c], flexGrow: 1, flexShrink: 0, ...TYPE.sm });
  const align = (c: number) => (numeric[c] ? 'text-right' : '');
  const table = (
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
                  <Text key={c} style={cellStyle(c)} className={`${CELL} ${numeric[c] ? 'text-right tabular-nums' : ''}`}>
                    {String(row[c] ?? '')}
                  </Text>
                ))}
              </View>
            </Fragment>
          ))}
        </View>
      </GHScrollView>
    </View>
  );
  if (!props.caption) return table;
  // The caption is the table's title, as on web: above it, on the left, outside the card.
  return (
    <View className="gap-2">
      <Text style={TYPE.sm} className="font-medium">
        {props.caption}
      </Text>
      {table}
    </View>
  );
}

/** On a phone a comparison reads best as one card per option, specs listed in the same order. */
export function GenuiCompare({ props }: GenuiComponentProps) {
  const { t } = useTranslation();
  const specs = strings(props.specs);
  return (
    <View className="gap-3">
      {kids(props.items).map((item) => {
        const pick = props.winner === item.props.name;
        return (
        // Web tints the pick's whole column; on a phone each option is a card, so the pick's card takes the tint.
        <View key={item.id} className={`gap-2 rounded-2xl px-4 py-3 ${pick ? 'bg-secondary' : 'bg-card'}`}>
          <View className="flex-row items-center justify-between gap-3">
            {/* The tint marks the pick; screen readers hear it named, since a tint alone reaches none. */}
            <Text
              variant="large"
              className="shrink"
              accessibilityLabel={pick ? `${String(item.props.name)}, ${t('genui.pick', 'Pick')}` : undefined}
            >
              {String(item.props.name)}
            </Text>
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
        );
      })}
    </View>
  );
}

/** A ranked list: one row per item, in rank order, with no rank numbers. #1 takes the larger title. */
export function GenuiRankedList({ props }: GenuiComponentProps) {
  const items = kids(props.items);
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      {items.map((item, index) => {
        const href = item.props.href;
        const first = index === 0;
        const image = item.props.image ? String(item.props.image) : null;
        // Just the data, no rank numbers: the order is the ranking. #1 takes the larger title and ink.
        const row = (
          <View className="flex-row items-start gap-3 px-4 py-3">
            {image ? (
              <View className="size-10 overflow-hidden rounded-md bg-secondary">
                <GenuiImageView src={image} alt="" fixedHeight={40} />
              </View>
            ) : null}
            <View className="flex-1 gap-0.5">
              <Text className={`font-medium ${first ? 'text-lg leading-6' : 'leading-5'} ${href ? 'underline' : ''}`}>
                {String(item.props.title)}
              </Text>
              {/* The meta is its own line under the title, as a price or spec line: a side column squeezes a sentence. */}
              {item.props.meta ? (
                <Text variant="small" className="font-medium tabular-nums leading-5 text-foreground">
                  {String(item.props.meta)}
                </Text>
              ) : null}
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

/**
 * A journey or a process, as on web: each row is a cropped photo on a rail, the title with its meta on the right,
 * and the text lines. A hairline under each rail joins it to the next row. A row with no photo, or a photo that
 * fails to load, shows its number on the same rail. A streaming row waits for its photo until the row is finished,
 * so a half-written URL never loads.
 */
export function GenuiSteps({ props }: GenuiComponentProps) {
  const steps = kids(props.steps);
  // Keyed by URL, not by step: a step whose URL changes gets a fresh try.
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  // A list whose every photo failed goes back to the narrow numbered rail.
  const photos = steps.some((step) => step.props.image && !failed.has(String(step.props.image)));
  return (
    <View>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const src = step.props.image && !step.partial ? String(step.props.image) : null;
        const image = src && !failed.has(src) ? src : null;
        return (
          <View key={step.id} className="flex-row gap-3">
            <View className="items-center" style={{ width: photos ? THUMB : 28 }}>
              {image ? (
                <View style={{ width: THUMB, height: THUMB }} className="overflow-hidden rounded-lg bg-secondary">
                  <GenuiImageView src={image} alt="" fixedHeight={THUMB} look={{ bare: true, resizeMode: 'cover', onError: () => setFailed((known) => new Set(known).add(image)) }} />
                </View>
              ) : photos ? (
                // In a list with photos, a row without one keeps the same thumbnail size: its number on the well.
                <View style={{ width: THUMB, height: THUMB }} className="items-center justify-center rounded-lg bg-secondary">
                  <Text variant="muted" className="font-mono tabular-nums">
                    {index + 1}
                  </Text>
                </View>
              ) : (
                <View className="size-7 items-center justify-center rounded-full bg-secondary">
                  <Text variant="small" className="tabular-nums">
                    {index + 1}
                  </Text>
                </View>
              )}
              {last ? null : <View className="my-1.5 min-h-4 w-px flex-1 bg-border" />}
            </View>
            <View className={['flex-1 gap-0.5', last ? '' : 'pb-4', photos ? '' : 'pt-1'].filter(Boolean).join(' ')}>
              <View className="flex-row items-baseline justify-between gap-3">
                <Text className="shrink font-medium">{String(step.props.title)}</Text>
                {step.props.meta ? (
                  <Text variant="muted" className="max-w-[35%] text-right tabular-nums">
                    {String(step.props.meta)}
                  </Text>
                ) : null}
              </View>
              {step.props.text ? (
                <Text variant="small" className="leading-5">
                  {String(step.props.text)}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** Things to tick off, with a "3/9 ready" count and a bar. Ticks live in this component only: no store, no request. */
export function GenuiChecklist({ props }: GenuiComponentProps) {
  const { t } = useTranslation();
  const items = strings(props.items);
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const toggle = (index: number) =>
    setDone((known) => {
      const next = new Set(known);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  return (
    <View className="gap-3 rounded-2xl bg-card px-4 py-3">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="shrink font-medium">{String(props.title)}</Text>
        <Text variant="muted" className="tabular-nums">
          {t('genui.checklistReady', { defaultValue: '{{done}}/{{total}} ready', done: done.size, total: items.length })}
        </Text>
      </View>
      <Progress value={items.length === 0 ? 0 : (done.size / items.length) * 100} className="h-1 bg-secondary" indicatorClassName="bg-foreground" />
      {/* Keyed by position: items only append while streaming, and a model may repeat one. */}
      <View>
        {items.map((item, index) => {
          const checked = done.has(index);
          return (
            <Pressable
              key={index}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              className="min-h-11 flex-row items-center gap-3 py-1.5 active:opacity-70"
              onPress={() => toggle(index)}
            >
              {checked ? <Icon as={CheckCircleIcon} size={20} weight="fill" /> : <Icon as={CircleIcon} size={20} className="text-muted-foreground" />}
              <Text className={`shrink ${checked ? 'text-muted-foreground line-through' : ''}`}>{item}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
