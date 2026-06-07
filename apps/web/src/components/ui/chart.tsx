'use client';

import * as React from 'react';
import * as RechartsPrimitive from 'recharts';

import { cn } from '@/lib/utils';

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
  }
>;

function ChartContainer({
  config,
  className,
  children,
}: {
  config: ChartConfig;
  className?: string;
  children: React.ReactElement;
}) {
  const style = Object.fromEntries(
    Object.entries(config)
      .filter(([, item]) => item.color)
      .map(([key, item]) => [`--color-${key}`, item.color]),
  ) as React.CSSProperties;

  return (
    <div className={cn('w-full text-xs', className)} style={style}>
      <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  );
}

const ChartTooltip = RechartsPrimitive.Tooltip;
const ChartLegend = RechartsPrimitive.Legend;

function getPayloadKey(item: any): string {
  return String(item?.dataKey ?? item?.name ?? item?.value ?? '');
}

function getPayloadLabel(config: ChartConfig, item: any): React.ReactNode {
  const key = getPayloadKey(item);
  return config[key]?.label ?? item?.name ?? key;
}

function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  className,
}: {
  active?: boolean;
  payload?: any[];
  label?: unknown;
  labelFormatter?: (label: unknown) => React.ReactNode;
  className?: string;
}) {
  if (!active || !payload?.length) return null;

  const config = (payload[0]?.payload?.__chartConfig ?? {}) as ChartConfig;

  return (
    <div className={cn('rounded-2xl border bg-popover px-3 py-2 text-popover-foreground shadow-md', className)}>
      {label != null && (
        <div className="mb-1.5 text-xs font-medium">
          {labelFormatter ? labelFormatter(label) : String(label)}
        </div>
      )}
      <div className="space-y-1">
        {payload.map((item, index) => (
          <div key={`${getPayloadKey(item)}-${index}`} className="flex min-w-[140px] items-center justify-between gap-4">
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: item.color ?? item.fill }}
              />
              {getPayloadLabel(config, item)}
            </span>
            <span className="font-mono tabular-nums text-foreground">{String(item.value ?? '—')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartLegendContent({
  payload,
  className,
}: {
  payload?: any[];
  className?: string;
}) {
  if (!payload?.length) return null;

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-4 pt-2 text-xs', className)}>
      {payload.map((item, index) => (
        <div key={`${getPayloadKey(item)}-${index}`} className="inline-flex items-center gap-1.5 text-muted-foreground">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: item.color }}
          />
          <span>{String(item.value ?? getPayloadKey(item))}</span>
        </div>
      ))}
    </div>
  );
}

export { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent };
