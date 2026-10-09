/**
 * Bar, line and pie charts for generative UI, drawn with react-native-svg.
 *
 * COLOR: the series take web's order on the brand data-viz ramp (`apps/web` genui
 * charts): `--chart-3`, `--chart-5`, `--chart-1`, muted ink, `--chart-2`, `--chart-4`.
 * The same entity is the same color on web and mobile. Adjacent slots pass the
 * dataviz CVD check (worst ΔE 19.0); a monochrome ink ramp failed the normal-vision
 * floor (ΔE 13.8 < 15). Two slots sit under 3:1 on the card, so color is never the
 * only carrier: 2+ series get a legend in ink, and Show data lists every value.
 * Native renderers get the comma form (`withAlpha(token, 1)`, design.md §9).
 *
 * MOTION: none. A chart answers a question; it is not a moment. No touch
 * inspection either: a gesture on the plot would fight the transcript scroll.
 */
import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import { useTranslation } from 'react-i18next';
import { genuiA11yText } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { axisMax, barPath, barRects, linePath, pieArcs } from '@/lib/genui/chart-geometry';
import { CaretDownIcon, CaretRightIcon } from '@/lib/icons';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { kids } from './layout';

/** Plot height in pt. `pending.tsx` reserves the whole card's height from it. */
const PLOT = 160;
/** Keeps a 2pt stroke at the plot's edge whole. */
const INSET = 1;
/** Up to this many categories, every bar is labelled under it; past that, and on a line, the ends are. */
const ALL_LABELS = 6;

type Cell = string | number | null;

export function GenuiChart({ node, props }: GenuiComponentProps) {
  const { t, i18n } = useTranslation();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [width, setWidth] = useState(0);
  const [showData, setShowData] = useState(false);

  const [c1, c2, c3, c4, c5] = THEME.chart;
  const palette = [c3, c5, c1, theme.mutedForeground, c2, c4].map((color) => withAlpha(color, 1));
  const ink = (alpha: number) => withAlpha(theme.foreground, alpha);
  const format = (value: Cell) => (typeof value === 'number' ? value.toLocaleString(i18n.language) : (value ?? '—'));
  const unit = props.unit ? String(props.unit) : '';
  const plotWidth = width - 2 * INSET;
  const plotHeight = PLOT - 2 * INSET;

  let legend: string[];
  let head: string[];
  let rows: Cell[][];
  let labels: string[] = [];
  let max = 0;
  let marks: ReactNode = null;
  let everyLabel = false;

  if (node.type === 'PieChart') {
    const slices = kids(props.slices).map((slice) => ({ label: String(slice.props.label), value: Number(slice.props.value) || 0 }));
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    const share = (value: number) => `${total > 0 ? Math.round((value / total) * 100) : 0}%`;
    legend = slices.map((slice) => `${slice.label} ${share(slice.value)}`);
    head = ['', unit, '%'];
    rows = slices.map((slice) => [slice.label, slice.value, share(slice.value)]);
    const radius = PLOT / 2 - INSET;
    marks = pieArcs(
      slices.map((slice) => slice.value),
      radius,
      radius * 0.6,
    ).map((arc) => (
      // A 2pt stroke in the card color is the gap between slices.
      <Path key={arc.index} d={arc.path} fill={palette[arc.index]} stroke={withAlpha(theme.card, 1)} strokeWidth={2} />
    ));
  } else {
    const line = node.type === 'LineChart';
    const series = kids(props.series);
    labels = ((line ? props.x : props.categories) ?? []) as string[];
    everyLabel = !line && labels.length <= ALL_LABELS;
    const values = series.map((s) => ((s.props.values as number[] | undefined) ?? []).slice(0, labels.length));
    const named = series.map((s) => (unit ? `${String(s.props.name)} (${unit})` : String(s.props.name)));
    legend = series.length > 1 ? named : [];
    head = ['', ...named];
    // A missing value stays a gap in the table, never a made-up zero.
    rows = labels.map((label, i) => [label, ...values.map((v) => v[i] ?? null)]);
    max = axisMax(values);
    marks = line
      ? values.map((v, k) => (
          <Path
            key={k}
            d={linePath(v, plotWidth, plotHeight, max, labels.length)}
            stroke={palette[k]}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
          />
        ))
      : barRects(values, labels.length, plotWidth, plotHeight, 2).map((bar) => (
          <Path key={`${bar.series}-${bar.index}`} d={barPath(bar, 4)} fill={palette[bar.series]} />
        ));
  }

  const pie = node.type === 'PieChart';

  return (
    <View className="gap-2 rounded-2xl bg-card p-4">
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
      {pie ? null : <Text variant="muted" className="tabular-nums">{unit ? `${format(max)} ${unit}` : format(max)}</Text>}
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={genuiA11yText(node) ?? undefined}
        style={{ height: PLOT }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {width > 0 ? (
          <Svg width={width} height={PLOT}>
            {pie ? (
              <G x={width / 2 - PLOT / 2 + INSET} y={INSET}>
                {marks}
              </G>
            ) : (
              <G x={INSET} y={INSET}>
                {/* Recessive guides: the max value's line and the baseline. */}
                <Path d={`M0,0 H${plotWidth} M0,${plotHeight} H${plotWidth}`} stroke={ink(0.1)} strokeWidth={1} />
                {marks}
              </G>
            )}
          </Svg>
        ) : null}
      </View>
      {everyLabel ? (
        // Equal cells across the full width: each label sits under its bar group.
        <View className="flex-row">
          {labels.map((label, i) => (
            <Text key={i} variant="muted" numberOfLines={1} className="flex-1 text-center">
              {label}
            </Text>
          ))}
        </View>
      ) : labels.length > 0 ? (
        // The ends of the x axis, flush with the first and last point.
        <View className="flex-row justify-between gap-3">
          <Text variant="muted" numberOfLines={1} className="shrink">
            {labels[0]}
          </Text>
          {labels.length > 1 ? (
            <Text variant="muted" numberOfLines={1} className="shrink text-right">
              {labels.at(-1)}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View className="flex-row items-start gap-3">
        <Text variant="muted" className="flex-1 py-1">
          {t('genui.source', { defaultValue: 'Source: {{source}}', source: String(props.source ?? '') })}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showData }}
          hitSlop={8}
          className="flex-row items-center gap-1 py-1 active:opacity-70"
          onPress={() => setShowData((open) => !open)}
        >
          <Icon as={showData ? CaretDownIcon : CaretRightIcon} size={12} className="text-muted-foreground" />
          <Text variant="muted">{showData ? t('genui.hideData', 'Hide data') : t('genui.showData', 'Show data')}</Text>
        </Pressable>
      </View>
      {showData ? <DataTable head={head} rows={rows} format={format} /> : null}
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
