/**
 * Bar and line charts for generative UI, drawn with react-native-svg, plus
 * the shared chart card shell (`ChartCard`) the pie card in `./chart-pie`
 * renders through too.
 *
 * LAYOUT (web parity, `apps/web/src/features/genui/components/charts.tsx`): a header row with the
 * source as the title on the left and Show data on the right; the bar or line legend under it, above
 * the plot. Show data opens the values in a sheet.
 *
 * COLOR: bars and lines take one order on web and mobile (the same entity is the same color):
 * `--chart-3`, `--chart-5`, the theme's foreground ink, `--chart-1`, `--chart-4`, `--chart-2`.
 * Adjacent slots pass the dataviz CVD and normal-vision checks. Ramp limits against the card (WCAG
 * ratio): light `--chart-3` 2.91:1, `--chart-2` 1.94:1, `--chart-1` 1.31:1; dark `--chart-5` 2.60:1.
 * So color is never the only carrier: every series is named in the legend in ink and Show data lists
 * every value. Native renderers get the comma form (`withAlpha(token, 1)`, design.md §9).
 *
 * MOTION: none. A chart answers a question; it is not a moment.
 *
 * TOUCH (web's hover, as a tap): a tap on a bar or line plot reads that category's values in the row
 * above the plot and dims the other bars (a line gets a guide and a dot per series); a second tap clears
 * it. Taps only, never a drag, so nothing fights the transcript scroll. A pie's tap lives in
 * `./chart-pie`. A tap on a legend item focuses that series and dims the rest to web's 0.15 (`useSeriesFocus`
 * in `./chart-card`); a second tap clears it.
 *
 * AXIS (web's YAxis + CartesianGrid): the value axis spans min(0, lowest) to max(0, highest) on 4-6 nice
 * ticks (`valueScale`), labelled in web's compact form (1.5K) in a 40pt column, one recessive grid line per
 * tick. 0 is always a tick, so a negative bar hangs below the zero line.
 */
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import { useTranslation } from 'react-i18next';
import { genuiA11yText } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';
import type { GenuiNode } from '@kortix/sdk/genui';

import { Text } from '@/components/ui/text';
import { barPath, barRects, compactNumber, linePath, pickIndex, valueScale } from '@/lib/genui/chart-geometry';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { ChartCard, useSeriesFocus, type Cell } from './chart-card';
import { PieChartCard } from './chart-pie';
import { kids } from './layout';
import { CHART_CARD_HEIGHT, CHART_PLOT as PLOT } from './pending';

/** Keeps a 2pt stroke at the plot's edge whole. */
const INSET = 1;
/** Room above and below the plot for half a tick label, so the top and bottom ticks are not cut. */
const PAD = 8;
/** The y axis label column, web's `YAxis width={40}`. */
const GUTTER = 40;
/** Up to this many categories, every bar is labelled under it; past that, and on a line, the ends are. */
const ALL_LABELS = 6;

export function GenuiChart({ node, props }: GenuiComponentProps) {
  if (node.type === 'PieChart') return <PieChartCard node={node} props={props} />;
  return <BarLineChart node={node} props={props} />;
}

/** The bar and line card: the two-series model, plot, and tap-to-read. */
function BarLineChart({ node, props }: { node: GenuiNode; props: Record<string, any> }) {
  const { t, i18n } = useTranslation();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const focus = useSeriesFocus();

  const [c1, c2, c3, c4, c5] = THEME.chart;
  const palette = [c3, c5, theme.foreground, c1, c4, c2].map((color) => withAlpha(color, 1));
  const ink = (alpha: number) => withAlpha(theme.foreground, alpha);
  const format = (value: Cell) => (typeof value === 'number' ? value.toLocaleString(i18n.language) : (value ?? '—'));
  const unit = props.unit ? String(props.unit) : '';
  // The source is the chart's title, as a Table caption is; the screen-reader text still says "Source: …".
  const title = unit ? `${String(props.source ?? '')} · ${unit}` : String(props.source ?? '');
  const plotWidth = width - 2 * INSET;
  const plotHeight = PLOT - 2 * PAD;

  const line = node.type === 'LineChart';
  const series = kids(props.series);
  const labels = ((line ? props.x : props.categories) ?? []) as string[];
  const everyLabel = !line && labels.length <= ALL_LABELS;
  const all = series.map((s) => (s.props.values as number[] | undefined) ?? []);
  // The plot draws one point per label; the table keeps every value.
  const values = all.map((v) => v.slice(0, labels.length));
  const names = series.map((s) => String(s.props.name));
  // The title names the source, not the series, so even one series is named in the legend.
  const legend = names;
  const head = ['', ...names.map((name) => (unit ? `${name} (${unit})` : name))];
  // A value past the last label gets a row numbered by position. A missing value stays a gap, never a made-up zero.
  const length = Math.max(labels.length, ...all.map((v) => v.length));
  const rows = Array.from({ length }, (_, i) => [labels[i] ?? String(i + 1), ...all.map((v) => v[i] ?? null)]);
  // The y axis: min(0, lowest) to max(0, highest) on nice ticks; an all-zero chart gets one 0 tick.
  const scale = valueScale(values);
  const tickY = (value: number) => ((scale.max - value) / (scale.max - scale.min)) * plotHeight;
  // The picked point of a line: a guide at its x and a ringed dot per series.
  const step = labels.length > 1 ? plotWidth / (labels.length - 1) : 0;
  const px = picked === null ? 0 : labels.length > 1 ? picked * step : plotWidth / 2;
  const py = (value: number) => tickY(value);
  const dot = (x: number, y: number, r: number) => `M${x - r},${y} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`;
  const marks = line ? (
    <>
      {values.map((v, k) => (
        <Path
          key={k}
          d={linePath(v, plotWidth, plotHeight, scale, labels.length)}
          stroke={palette[k]}
          strokeOpacity={focus.opacity(k)}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />
      ))}
      {picked === null ? null : (
        <>
          <Path d={`M${px},0 V${plotHeight}`} stroke={ink(0.25)} strokeWidth={1} />
          {values.map((v, k) =>
            Number.isFinite(v[picked]) ? (
              <Path
                key={`dot-${k}`}
                d={dot(px, py(v[picked]!), 4)}
                fill={palette[k]}
                fillOpacity={focus.opacity(k)}
                stroke={withAlpha(theme.card, 1)}
                strokeWidth={2}
              />
            ) : null,
          )}
        </>
      )}
    </>
  ) : (
    barRects(values, labels.length, plotWidth, plotHeight, scale, 2).map((bar) => (
      <Path
        key={`${bar.series}-${bar.index}`}
        d={barPath(bar, 4)}
        fill={palette[bar.series]}
        fillOpacity={focus.opacity(bar.series) * (picked === null || bar.index === picked ? 1 : 0.3)}
      />
    ))
  );

  return (
    <ChartCard title={title} legend={legend} palette={palette} focus={focus} minHeight={CHART_CARD_HEIGHT} head={head} rows={rows} format={format}>
      {picked !== null && picked < labels.length ? (
        // The tapped category: its label, then each series' value with its swatch.
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <Text variant="small" className="leading-5">
            {labels[picked]}
          </Text>
          {legend.map((name, k) => (
            <View key={k} className="flex-row items-center gap-1.5">
              <View style={{ backgroundColor: palette[k] }} className="size-2.5 rounded-sm" />
              <Text variant="muted" className="tabular-nums">
                {`${format(values[k]?.[picked] ?? null)}${unit ? ` ${unit}` : ''}`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View className="flex-row">
        {/* The y axis: compact tick labels, each centered on its grid line. The figure's label reads the values. */}
        <View style={{ width: GUTTER, height: PLOT }}>
          {scale.ticks
            .slice()
            .reverse()
            .map((tick) => (
              <Text
                key={tick}
                accessibilityElementsHidden
                importantForAccessibility="no"
                variant="muted"
                numberOfLines={1}
                className="absolute right-2 text-xs leading-4 tabular-nums"
                style={{ top: PAD + tickY(tick) - 8 }}
              >
                {compactNumber(tick, i18n.language)}
              </Text>
            ))}
        </View>
        <Pressable
          accessible
          accessibilityRole="image"
          accessibilityLabel={genuiA11yText(node) ?? undefined}
          accessibilityHint={t('genui.chartTapHint', 'Tap to read a value')}
          style={{ flex: 1, height: PLOT }}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          onPress={(e) => {
            if (labels.length === 0) return;
            const index = pickIndex(e.nativeEvent.locationX - INSET, plotWidth, labels.length, line);
            setPicked((current) => (current === index ? null : index));
          }}
        >
          {width > 0 ? (
            <Svg width={width} height={PLOT}>
              <G x={INSET} y={PAD}>
                {/* Recessive guides, web's CartesianGrid: one line per tick; 0 is a tick, so the zero line is one. */}
                <Path testID="grid" d={scale.ticks.map((tick) => `M0,${tickY(tick)} H${plotWidth}`).join(' ')} stroke={ink(0.1)} strokeWidth={1} />
                {marks}
              </G>
            </Svg>
          ) : null}
        </Pressable>
      </View>
      {everyLabel ? (
        // Equal cells across the plot's width: each label sits under its bar group.
        <View className="flex-row" style={{ paddingLeft: GUTTER }}>
          {labels.map((label, i) => (
            <Text key={i} variant="muted" numberOfLines={1} className="flex-1 text-center">
              {label}
            </Text>
          ))}
        </View>
      ) : labels.length > 0 ? (
        // The ends of the x axis, flush with the first and last point.
        <View className="flex-row justify-between gap-3" style={{ paddingLeft: GUTTER }}>
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
    </ChartCard>
  );
}
