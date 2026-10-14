/**
 * Bar, line and pie charts for generative UI, drawn with react-native-svg.
 *
 * LAYOUT (web parity, `apps/web/src/features/genui/components/charts.tsx`): a header row with the
 * source as the title on the left and Show data on the right; the bar or line legend under it, above
 * the plot. Show data opens the values in a sheet. A pie draws one of six layouts (`props.variant`).
 *
 * COLOR: bars and lines take one order on web and mobile (the same entity is the same color):
 * `--chart-3`, `--chart-5`, the theme's foreground ink, `--chart-1`, `--chart-4`, `--chart-2`.
 * Adjacent slots pass the dataviz CVD and normal-vision checks. Ramp limits against the card (WCAG
 * ratio): light `--chart-3` 2.91:1, `--chart-2` 1.94:1, `--chart-1` 1.31:1; dark `--chart-5` 2.60:1.
 * So color is never the only carrier: every series is named in the legend in ink and Show data lists
 * every value. Pie slices are one ink ramp, largest share darkest, as on web; `focus` alone takes the
 * brand accent, on the slice the answer is about. Native renderers get the comma form
 * (`withAlpha(token, 1)`, design.md §9).
 *
 * MOTION: none. A chart answers a question; it is not a moment.
 *
 * TOUCH (web's hover, as a tap): a tap on a bar or line plot reads that category's values in the row
 * above the plot and dims the other bars (a line gets a guide and a dot per series); a second tap clears
 * it. A tap on a pie slice or its legend row reads that slice in the center. Taps only, never a drag, so
 * nothing fights the transcript scroll.
 */
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useRef, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import { useTranslation } from 'react-i18next';
import { genuiA11yText } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { axisMax, barPath, barRects, linePath, pickIndex, pieArcs, pieVariant, type PieVariant } from '@/lib/genui/chart-geometry';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { kids } from './layout';

/** Plot height in pt. `pending.tsx` reserves the whole card's height from it. */
export const PLOT = 160;
/** Gauge, stack, focus, and treemap fill this block; a donut or ring stacks its legend under the disc and grows with it. */
export const PIE_BLOCK = 200;
/** Keeps a 2pt stroke at the plot's edge whole. */
const INSET = 1;
/** Up to this many categories, every bar is labelled under it; past that, and on a line, the ends are. */
const ALL_LABELS = 6;
/** Pie slices: the theme ink at these strengths, largest share darkest. */
const PIE_RAMP = [1, 0.7, 0.5, 0.34, 0.22, 0.12];
/** A treemap block under this share of its column is too small for text: a tap shows its data. */
const TREEMAP_TEXT_SHARE = 0.12;

type Cell = string | number | null;
type Slice = { key: string; label: string; value: number; percent: number; fill: string };

export function GenuiChart({ node, props }: GenuiComponentProps) {
  const { t, i18n } = useTranslation();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const sheet = useRef<BottomSheetModal>(null);

  const [c1, c2, c3, c4, c5] = THEME.chart;
  const palette = [c3, c5, theme.foreground, c1, c4, c2].map((color) => withAlpha(color, 1));
  const ink = (alpha: number) => withAlpha(theme.foreground, alpha);
  const format = (value: Cell) => (typeof value === 'number' ? value.toLocaleString(i18n.language) : (value ?? '—'));
  const unit = props.unit ? String(props.unit) : '';
  // The source is the chart's title, as a Table caption is; the screen-reader text still says "Source: …".
  const title = unit ? `${String(props.source ?? '')} · ${unit}` : String(props.source ?? '');
  const plotWidth = width - 2 * INSET;
  const plotHeight = PLOT - 2 * INSET;
  const pie = node.type === 'PieChart';

  let legend: string[] = [];
  let head: string[];
  let rows: Cell[][];
  let labels: string[] = [];
  let max = 0;
  let hasValue = false;
  let marks: ReactNode = null;
  let everyLabel = false;
  let figure: ReactNode = null;
  let line = false;
  let values: number[][] = [];

  if (pie) {
    const raw = kids(props.slices).map((slice) => ({ label: String(slice.props.label), value: Number(slice.props.value) || 0 }));
    // Shares clamp a negative to 0, as `pieArcs` does, so every label matches its slice.
    const total = raw.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
    const percent = (value: number) => (total > 0 ? Math.round((Math.max(0, value) / total) * 100) : 0);
    const variant = pieVariant(props.variant, raw.length);
    const slices: Slice[] = raw.map((slice, i) => ({
      key: `p${i}`,
      ...slice,
      percent: percent(slice.value),
      fill: variant === 'focus' && i === 0 ? withAlpha(THEME.accent.blue, 1) : ink(PIE_RAMP[i] ?? 0.12),
    }));
    head = ['', unit, '%'];
    rows = slices.map((slice) => [slice.label, slice.value, `${slice.percent}%`]);
    figure = (
      <PieFigure
        variant={variant}
        slices={slices}
        total={total}
        unit={unit}
        format={format}
        gap={withAlpha(theme.card, 1)}
        a11y={genuiA11yText(node) ?? undefined}
      />
    );
  } else {
    line = node.type === 'LineChart';
    const series = kids(props.series);
    labels = ((line ? props.x : props.categories) ?? []) as string[];
    everyLabel = !line && labels.length <= ALL_LABELS;
    const all = series.map((s) => (s.props.values as number[] | undefined) ?? []);
    // The plot draws one point per label; the table keeps every value.
    values = all.map((v) => v.slice(0, labels.length));
    const names = series.map((s) => String(s.props.name));
    // The title names the source, not the series, so even one series is named in the legend.
    legend = names;
    head = ['', ...names.map((name) => (unit ? `${name} (${unit})` : name))];
    // A value past the last label gets a row numbered by position. A missing value stays a gap, never a made-up zero.
    const length = Math.max(labels.length, ...all.map((v) => v.length));
    rows = Array.from({ length }, (_, i) => [labels[i] ?? String(i + 1), ...all.map((v) => v[i] ?? null)]);
    max = axisMax(values);
    // `axisMax` is never 0 so the plot can scale; an all-zero chart must not print that 1 as data.
    hasValue = values.some((v) => v.some((value) => typeof value === 'number' && value > 0));
    // The picked point of a line: a guide at its x and a ringed dot per series.
    const step = labels.length > 1 ? plotWidth / (labels.length - 1) : 0;
    const px = picked === null ? 0 : labels.length > 1 ? picked * step : plotWidth / 2;
    const py = (value: number | undefined) => plotHeight - (Math.max(0, Number(value) || 0) / max) * plotHeight;
    const dot = (x: number, y: number, r: number) => `M${x - r},${y} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`;
    marks = line ? (
      <>
        {values.map((v, k) => (
          <Path
            key={k}
            d={linePath(v, plotWidth, plotHeight, max, labels.length)}
            stroke={palette[k]}
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
              typeof v[picked] === 'number' ? (
                <Path key={`dot-${k}`} d={dot(px, py(v[picked]), 4)} fill={palette[k]} stroke={withAlpha(theme.card, 1)} strokeWidth={2} />
              ) : null,
            )}
          </>
        )}
      </>
    ) : (
      barRects(values, labels.length, plotWidth, plotHeight, 2).map((bar) => (
        <Path
          key={`${bar.series}-${bar.index}`}
          d={barPath(bar, 4)}
          fill={palette[bar.series]}
          fillOpacity={picked === null || bar.index === picked ? 1 : 0.3}
        />
      ))
    );
  }

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
      {pie ? (
        figure
      ) : (
        <>
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
          ) : hasValue ? (
            <Text variant="muted" className="tabular-nums">{unit ? `${format(max)} ${unit}` : format(max)}</Text>
          ) : null}
          <Pressable
            accessible
            accessibilityRole="image"
            accessibilityLabel={genuiA11yText(node) ?? undefined}
            accessibilityHint={t('genui.chartTapHint', 'Tap to read a value')}
            style={{ height: PLOT }}
            onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
            onPress={(e) => {
              if (labels.length === 0) return;
              const index = pickIndex(e.nativeEvent.locationX - INSET, plotWidth, labels.length, line);
              setPicked((current) => (current === index ? null : index));
            }}
          >
            {width > 0 ? (
              <Svg width={width} height={PLOT}>
                <G x={INSET} y={INSET}>
                  {/* Recessive guides: the max value's line and the baseline. */}
                  <Path d={`M0,0 H${plotWidth} M0,${plotHeight} H${plotWidth}`} stroke={ink(0.1)} strokeWidth={1} />
                  {marks}
                </G>
              </Svg>
            ) : null}
          </Pressable>
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
        </>
      )}
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

/** One of the six pie layouts (web's `PieFigure`), inside a `PIE_BLOCK`-tall box. */
function PieFigure({
  variant,
  slices,
  total,
  unit,
  format,
  gap,
  a11y,
}: {
  variant: PieVariant;
  slices: Slice[];
  total: number;
  unit: string;
  format: (value: Cell) => string;
  /** The card color: a 2pt stroke in it is the gap between slices. */
  gap: string;
  a11y: string | undefined;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string | null>(null);
  const toggle = (key: string) => setPicked((current) => (current === key ? null : key));
  const withUnit = (value: number) => (unit ? `${format(value)} ${unit}` : format(value));
  const swatch = (fill: string) => <View style={{ backgroundColor: fill }} className="size-2.5 rounded-sm" />;
  const lead = slices.reduce<Slice | undefined>((best, slice) => (!best || slice.value > best.value ? slice : best), undefined);
  const disc = (size: number, inner: number, start = 0, span = Math.PI * 2, height = size) => (
    <Svg width={size} height={height}>
      {pieArcs(
        slices.map((slice) => slice.value),
        size / 2,
        inner,
        start,
        span,
      ).map((arc) => {
        const slice = slices[arc.index]!;
        return (
          <Path
            key={arc.index}
            d={arc.path}
            fill={slice.fill}
            fillOpacity={picked === null || picked === slice.key ? 1 : 0.3}
            stroke={gap}
            strokeWidth={2}
            onPress={() => toggle(slice.key)}
          />
        );
      })}
    </Svg>
  );
  const figure = (children: ReactNode, accessible = true) => (
    <View
      accessible={accessible}
      accessibilityRole={accessible ? 'image' : undefined}
      accessibilityLabel={accessible ? a11y : undefined}
      style={{ height: PIE_BLOCK }}
    >
      {children}
    </View>
  );

  if (variant === 'treemap') {
    // Slice-and-dice: the largest share takes its width; the rest stack in a column by their share.
    const [first, ...rest] = [...slices].sort((a, b) => b.value - a.value);
    if (!first) return figure(null);
    const restTotal = rest.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
    const shown = slices.find((slice) => slice.key === picked);
    const block = (slice: Slice, i: number) => {
      const small = i > 0 && restTotal > 0 && slice.value / restTotal < TREEMAP_TEXT_SHARE;
      const onInk = i < 2;
      return (
        <Pressable
          key={slice.key}
          accessibilityRole="button"
          accessibilityLabel={`${slice.label}: ${withUnit(slice.value)} (${slice.percent}%)`}
          onPress={() => toggle(slice.key)}
          style={{ backgroundColor: slice.fill, flexGrow: Math.max(slice.value, 0), flexBasis: 0, minHeight: 6 }}
          className={`justify-between overflow-hidden rounded-lg ${small ? '' : 'p-3'}`}
        >
          {small ? null : (
            <>
              <Text variant="muted" numberOfLines={1} className={onInk ? 'text-background' : 'text-foreground'}>
                {slice.label}
              </Text>
              <Text variant={i === 0 ? 'h4' : 'small'} numberOfLines={1} className={`tabular-nums ${onInk ? 'text-background' : 'text-foreground'}`}>
                {`${slice.percent}%`}
              </Text>
            </>
          )}
        </Pressable>
      );
    };
    return (
      <View style={{ height: PIE_BLOCK }} className="gap-2">
        <View className="flex-1 flex-row gap-1">
          {block(first, 0)}
          {rest.length > 0 ? (
            <View className="gap-1" style={{ flexGrow: restTotal, flexBasis: 0 }}>
              {rest.map((slice, i) => block(slice, i + 1))}
            </View>
          ) : null}
        </View>
        {/* A tap shows the block's data here: the small ones have no room for text. */}
        <View className="h-5 flex-row items-center gap-2">
          {shown ? (
            <>
              {swatch(shown.fill)}
              <Text variant="small" className="leading-5">
                {shown.label}
              </Text>
              <Text variant="muted" className="font-mono tabular-nums">{`${withUnit(shown.value)} · ${shown.percent}%`}</Text>
            </>
          ) : null}
        </View>
      </View>
    );
  }

  if (variant === 'stack') {
    // A receipt: each row is as tall as its share, so the label sits level with its segment.
    return figure(
      <View className="flex-1 gap-0.5">
        {slices.map((slice) => (
          <View key={slice.key} className="flex-row items-center gap-4" style={{ flexGrow: Math.max(slice.value, 0), flexBasis: 0, minHeight: 20 }}>
            <View style={{ backgroundColor: slice.fill }} className="h-full w-11 rounded-sm" />
            <Text variant="small" numberOfLines={1} className="flex-1 leading-5">
              {slice.label}
            </Text>
            <Text variant="muted" className="font-mono tabular-nums">{`${format(slice.value)} · ${slice.percent}%`}</Text>
          </View>
        ))}
      </View>,
    );
  }

  if (variant === 'gauge') {
    const size = 200;
    return figure(
      <View className="flex-1 items-center justify-center gap-3">
        <View style={{ width: size, height: size / 2 }}>
          {disc(size, size * 0.36, -Math.PI / 2, Math.PI, size / 2)}
          <View className="absolute inset-x-0 bottom-0 items-center">
            <Text variant="h4" className="tabular-nums">
              {format(total)}
            </Text>
            {unit ? <Text variant="muted">{unit}</Text> : null}
          </View>
        </View>
        <View className="flex-row flex-wrap justify-center gap-x-4 gap-y-1">
          {slices.map((slice) => (
            <View key={slice.key} className="flex-row items-center gap-1.5">
              {swatch(slice.fill)}
              <Text variant="muted">{`${slice.label} ${slice.percent}%`}</Text>
            </View>
          ))}
        </View>
      </View>,
    );
  }

  if (variant === 'focus') {
    const [first, ...rest] = slices;
    if (!first) return figure(null);
    return figure(
      <View className="flex-1 flex-row items-center gap-5">
        {disc(128, 0)}
        <View className="flex-1 gap-1">
          <Text variant="large">{t('genui.pieFocus', { defaultValue: '{{label}} is {{percent}}% of the total', label: first.label, percent: first.percent })}</Text>
          <Text variant="muted" className="tabular-nums">
            {t('genui.pieOfTotal', { defaultValue: '{{value}} of {{total}}', value: format(first.value), total: withUnit(total) })}
          </Text>
          <Text variant="muted" className="mt-2 tabular-nums">
            {rest.map((slice) => `${slice.label} ${format(slice.value)}`).join('   ')}
          </Text>
        </View>
      </View>,
    );
  }

  // donut and ring: the disc on top, the slices as a full-width legend under it, so no label truncates.
  // A tap on a slice or its row reads that slice in the center and dims the others.
  const ring = variant === 'ring';
  const size = 168;
  const shown = slices.find((slice) => slice.key === picked);
  return (
    <View className="items-center gap-4">
      <View accessible accessibilityRole="image" accessibilityLabel={a11y} style={{ width: size, height: size }}>
        {disc(size, ring ? size * 0.46 : size * 0.34)}
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center px-8">
          <Text variant="h4" className="tabular-nums">
            {shown ? `${shown.percent}%` : ring ? `${lead?.percent ?? 0}%` : format(total)}
          </Text>
          {shown ? (
            <Text variant="muted" numberOfLines={1}>
              {shown.label}
            </Text>
          ) : ring ? (
            lead ? (
              <Text variant="muted" numberOfLines={1}>
                {lead.label}
              </Text>
            ) : null
          ) : unit ? (
            <Text variant="muted">{unit}</Text>
          ) : null}
        </View>
      </View>
      <View className="self-stretch">
        {slices.map((slice, i) => (
          <View key={slice.key}>
            {i > 0 ? <Separator /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${slice.label}: ${withUnit(slice.value)} (${slice.percent}%)`}
              onPress={() => toggle(slice.key)}
              style={{ opacity: picked === null || picked === slice.key ? 1 : 0.5 }}
              className="flex-row items-center gap-2 py-2"
            >
              {swatch(slice.fill)}
              <Text variant="small" className="flex-1 leading-5">
                {slice.label}
              </Text>
              <Text variant="muted" className="font-mono tabular-nums">
                {format(slice.value)}
              </Text>
              <Text variant="muted" className="w-10 text-right font-mono tabular-nums">{`${slice.percent}%`}</Text>
            </Pressable>
          </View>
        ))}
      </View>
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
