/**
 * The pie card of the genui charts: the pie prep from `GenuiChart` plus the
 * six-layout `PieFigure` (treemap, stack, gauge, focus, donut, ring). The
 * shared card shell (`ChartCard`) and the bar/line chart live in
 * `./charts`.
 */

import type { ReactNode } from 'react';
import { useColorScheme } from 'nativewind';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { genuiA11yText } from '@kortix/sdk/genui';
import type { GenuiNode } from '@kortix/sdk/genui';

import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { pieArcs, pieVariant, type PieVariant } from '@/lib/genui/chart-geometry';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { ChartCard, LegendItem, useSeriesFocus, type Cell, type SeriesFocus, type Slice } from './chart-card';
import { kids } from './layout';
import { GenuiPending, PIE_BLOCK, PIE_CARD_HEIGHT } from './pending';

/** Pie slices: the theme ink at these strengths, largest share darkest. */
const PIE_RAMP = [1, 0.7, 0.5, 0.34, 0.22, 0.12];
/** A treemap block under this share of its column is too small for text: a tap shows its data. */
const TREEMAP_TEXT_SHARE = 0.12;
/** The focus layout's disc, beside its text. */
const DISC = 128;
/**
 * The donut and ring disc, beside the slice list (gap-3). On a 375pt phone the card's content is ~311pt, so
 * the list is ~199pt and a donut label keeps ~81pt after the dot, value and share columns.
 */
const SMALL_DISC = 100;

/** The pie card: one of six layouts, values in the Show-data sheet. */
export function PieChartCard({ node, props }: { node: GenuiNode; props: Record<string, any> }) {
  const { i18n } = useTranslation();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const focus = useSeriesFocus();
  // A streamed pie arrives before its slices resolve (the parent line comes first): hold its space until one lands.
  const raw = kids(props.slices).map((slice) => ({ label: String(slice.props.label), value: Number(slice.props.value) || 0 }));
  if (raw.length === 0) return GenuiPending(node);
  const ink = (alpha: number) => withAlpha(theme.foreground, alpha);
  const format = (value: Cell) => (typeof value === 'number' ? value.toLocaleString(i18n.language) : (value ?? '—'));
  const unit = props.unit ? String(props.unit) : '';
  // The source is the chart's title, as a Table caption is; the screen-reader text still says "Source: …".
  const title = unit ? `${String(props.source ?? '')} · ${unit}` : String(props.source ?? '');

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
  const head = ['', unit, '%'];
  const rows = slices.map((slice) => [slice.label, slice.value, `${slice.percent}%`]);

  return (
    <ChartCard title={title} legend={[]} minHeight={PIE_CARD_HEIGHT} head={head} rows={rows} format={format}>
      <PieFigure
        variant={variant}
        slices={slices}
        total={total}
        unit={unit}
        format={format}
        focus={focus}
        gap={withAlpha(theme.card, 1)}
        a11y={genuiA11yText(node) ?? undefined}
      />
    </ChartCard>
  );
}

/**
 * One of the six pie layouts (web's `PieFigure`), each inside one `PIE_BLOCK`-tall box, so the card settles at
 * the height its pending block reserved. A tap on a slice or its legend item focuses it (`useSeriesFocus`):
 * the other slices dim to 0.15; a second tap clears it.
 */
function PieFigure({
  variant,
  slices,
  total,
  unit,
  format,
  focus,
  gap,
  a11y,
}: {
  variant: PieVariant;
  slices: Slice[];
  total: number;
  unit: string;
  format: (value: Cell) => string;
  focus: SeriesFocus;
  /** The card color: a 2pt stroke in it is the gap between slices. */
  gap: string;
  a11y: string | undefined;
}) {
  const { t } = useTranslation();
  const withUnit = (value: number) => (unit ? `${format(value)} ${unit}` : format(value));
  const swatch = (fill: string) => <View style={{ backgroundColor: fill }} className="size-2.5 rounded-sm" />;
  const lead = slices.reduce<Slice | undefined>((best, slice) => (!best || slice.value > best.value ? slice : best), undefined);
  const shown = focus.focused === null ? undefined : slices[focus.focused];
  const disc = (size: number, inner: number, start = 0, span = Math.PI * 2, height = size) => (
    <Svg width={size} height={height}>
      {pieArcs(
        slices.map((slice) => slice.value),
        size / 2,
        inner,
        start,
        span,
      ).map((arc) => (
        <Path
          key={arc.index}
          d={arc.path}
          fill={slices[arc.index]!.fill}
          fillOpacity={focus.opacity(arc.index)}
          stroke={gap}
          strokeWidth={2}
          onPress={() => focus.toggle(arc.index)}
        />
      ))}
    </Svg>
  );
  /** The fixed block every layout draws in. The treemap's blocks are buttons, so it is not one image. */
  const figure = (className: string, children: ReactNode, accessible = true) => (
    <View
      testID="pie-block"
      accessible={accessible}
      accessibilityRole={accessible ? 'image' : undefined}
      accessibilityLabel={accessible ? a11y : undefined}
      style={{ height: PIE_BLOCK }}
      className={className}
    >
      {children}
    </View>
  );

  if (variant === 'treemap') {
    // Slice-and-dice: the largest share takes its width; the rest stack in a column by their share.
    const [first, ...rest] = slices.map((slice, index) => ({ slice, index })).sort((a, b) => b.slice.value - a.slice.value);
    const restTotal = rest.reduce((sum, { slice }) => sum + Math.max(0, slice.value), 0);
    const block = ({ slice, index }: { slice: Slice; index: number }, i: number) => {
      const small = i > 0 && restTotal > 0 && slice.value / restTotal < TREEMAP_TEXT_SHARE;
      const onInk = i < 2;
      return (
        <Pressable
          key={slice.key}
          accessibilityRole="button"
          accessibilityLabel={`${slice.label}: ${withUnit(slice.value)} (${slice.percent}%)`}
          accessibilityState={{ selected: focus.focused === index }}
          onPress={() => focus.toggle(index)}
          style={{ backgroundColor: slice.fill, opacity: focus.opacity(index), flexGrow: Math.max(slice.value, 0), flexBasis: 0, minHeight: 6 }}
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
    return figure(
      'gap-2',
      <>
        <View className="flex-1 flex-row gap-1">
          {first ? block(first, 0) : null}
          {rest.length > 0 ? (
            <View className="gap-1" style={{ flexGrow: restTotal, flexBasis: 0 }}>
              {rest.map((entry, i) => block(entry, i + 1))}
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
      </>,
      false,
    );
  }

  if (variant === 'stack') {
    // A receipt: each row is as tall as its share, so the label sits level with its segment. A row is its legend item.
    return figure(
      'gap-0.5',
      slices.map((slice, i) => (
        <View key={slice.key} style={{ flexGrow: Math.max(slice.value, 0), flexBasis: 0, minHeight: 20 }}>
          <LegendItem focus={focus} index={i} className="flex-1 gap-4 pr-1.5">
            <View style={{ backgroundColor: slice.fill, opacity: focus.opacity(i) }} className="w-11 self-stretch rounded-sm" />
            <Text variant="small" numberOfLines={1} className="flex-1 leading-5">
              {slice.label}
            </Text>
            <Text variant="muted" className="font-mono tabular-nums">{`${format(slice.value)} · ${slice.percent}%`}</Text>
          </LegendItem>
        </View>
      )),
    );
  }

  if (variant === 'gauge') {
    const size = 200;
    return figure(
      'items-center justify-center gap-3',
      <>
        <View style={{ width: size, height: size / 2 }}>
          {disc(size, size * 0.36, -Math.PI / 2, Math.PI, size / 2)}
          <View pointerEvents="none" className="absolute inset-x-0 bottom-0 items-center">
            <Text variant="h4" className="tabular-nums">
              {format(total)}
            </Text>
            {unit ? <Text variant="muted">{unit}</Text> : null}
          </View>
        </View>
        <View className="flex-row flex-wrap justify-center gap-x-4 gap-y-1">
          {slices.map((slice, i) => (
            <LegendItem key={slice.key} focus={focus} index={i} className="gap-1.5 px-1.5 py-0.5">
              {swatch(slice.fill)}
              <Text variant="muted" className={focus.focused === i ? 'text-foreground' : undefined}>{`${slice.label} ${slice.percent}%`}</Text>
            </LegendItem>
          ))}
        </View>
      </>,
    );
  }

  if (variant === 'focus') {
    const [first, ...rest] = slices;
    return figure(
      'flex-row items-center gap-5',
      first ? (
        <>
          {disc(DISC, 0)}
          <View className="flex-1 gap-1">
            <Text variant="large">{t('genui.pieFocus', { defaultValue: '{{label}} is {{percent}}% of the total', label: first.label, percent: first.percent })}</Text>
            <Text variant="muted" className="tabular-nums">
              {t('genui.pieOfTotal', { defaultValue: '{{value}} of {{total}}', value: format(first.value), total: withUnit(total) })}
            </Text>
            {/* The other slices as legend items: a tap focuses one. */}
            <View className="-mx-1.5 mt-2 flex-row flex-wrap gap-x-1 gap-y-1">
              {rest.map((slice, k) => (
                <LegendItem key={slice.key} focus={focus} index={k + 1} className="px-1.5 py-0.5">
                  <Text variant="muted" className={`tabular-nums ${focus.focused === k + 1 ? 'text-foreground' : ''}`}>
                    {`${slice.label} ${format(slice.value)}`}
                  </Text>
                </LegendItem>
              ))}
            </View>
          </View>
        </>
      ) : null,
    );
  }

  // donut and ring (web's layout): the disc on the left, the slices as a legend list beside it, in PIE_BLOCK.
  // A tap on a slice or its row reads that slice in the center and dims the others.
  const ring = variant === 'ring';
  return (
    <View testID="pie-block" style={{ height: PIE_BLOCK }} className="flex-row items-center gap-3">
      <View accessible accessibilityRole="image" accessibilityLabel={a11y} style={{ width: SMALL_DISC, height: SMALL_DISC }}>
        {disc(SMALL_DISC, ring ? SMALL_DISC * 0.46 : SMALL_DISC * 0.34)}
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center px-3">
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
      {/* Web's ring list: no dot, no share column, a rule between rows, rows after the first muted. */}
      <View className="flex-1">
        {slices.map((slice, i) => {
          const quiet = ring && i > 0;
          return (
            <View key={slice.key}>
              {ring && i > 0 ? <Separator /> : null}
              <LegendItem focus={focus} index={i} label={`${slice.label}: ${withUnit(slice.value)} (${slice.percent}%)`} className="gap-2 px-1.5 py-1.5">
                {ring ? null : swatch(slice.fill)}
                <Text variant="small" numberOfLines={1} className={`flex-1 leading-5 ${quiet ? 'text-muted-foreground' : ''}`}>
                  {slice.label}
                </Text>
                <Text variant="muted" className={`font-mono text-xs tabular-nums ${ring ? (quiet ? 'text-muted-foreground' : 'text-foreground') : ''}`}>
                  {format(slice.value)}
                </Text>
                {ring ? null : <Text variant="muted" className="w-9 text-right font-mono text-xs tabular-nums">{`${slice.percent}%`}</Text>}
              </LegendItem>
            </View>
          );
        })}
      </View>
    </View>
  );
}
