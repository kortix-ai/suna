/**
 * The pie card of the genui charts: the pie prep from `GenuiChart` plus the
 * six-layout `PieFigure` (treemap, stack, gauge, focus, donut, ring). The
 * shared card shell (`ChartCard`) and the bar/line chart live in
 * `./charts`.
 */

import { useState, type ReactNode } from 'react';
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

import { ChartCard, type Cell, type Slice } from './chart-card';

import { kids } from './layout';

/** Gauge, stack, focus, and treemap fill this block; a donut or ring stacks its legend under the disc and grows with it. */
const PIE_BLOCK = 200;
/** Pie slices: the theme ink at these strengths, largest share darkest. */
const PIE_RAMP = [1, 0.7, 0.5, 0.34, 0.22, 0.12];
/** A treemap block under this share of its column is too small for text: a tap shows its data. */
const TREEMAP_TEXT_SHARE = 0.12;

/** The pie card: one of six layouts, values in the Show-data sheet. */
export function PieChartCard({ node, props }: { node: GenuiNode; props: Record<string, any> }) {
  const { i18n } = useTranslation();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const ink = (alpha: number) => withAlpha(theme.foreground, alpha);
  const format = (value: Cell) => (typeof value === 'number' ? value.toLocaleString(i18n.language) : (value ?? '—'));
  const unit = props.unit ? String(props.unit) : '';
  // The source is the chart's title, as a Table caption is; the screen-reader text still says "Source: …".
  const title = unit ? `${String(props.source ?? '')} · ${unit}` : String(props.source ?? '');

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
  const head = ['', unit, '%'];
  const rows = slices.map((slice) => [slice.label, slice.value, `${slice.percent}%`]);

  return (
    <ChartCard title={title} legend={[]} head={head} rows={rows} format={format}>
      <PieFigure
        variant={variant}
        slices={slices}
        total={total}
        unit={unit}
        format={format}
        gap={withAlpha(theme.card, 1)}
        a11y={genuiA11yText(node) ?? undefined}
      />
    </ChartCard>
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

