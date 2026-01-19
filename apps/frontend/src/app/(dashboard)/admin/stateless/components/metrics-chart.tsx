"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Line,
  LineChart,
  XAxis,
  YAxis,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Loader2 } from "lucide-react";

interface ChartDataPoint {
  [key: string]: string | number;
}

interface MetricsChartProps {
  title: string;
  description?: string;
  data: ChartDataPoint[];
  dataKeys: Array<{
    key: string;
    label: string;
    color: string;
  }>;
  xAxisKey?: string;
  type?: "area" | "line" | "bar";
  stacked?: boolean;
  height?: number;
  isLoading?: boolean;
  showLegend?: boolean;
  showGrid?: boolean;
  className?: string;
  emptyMessage?: string;
}

export function MetricsChart({
  title,
  description,
  data,
  dataKeys,
  xAxisKey = "time",
  type = "area",
  stacked = false,
  height = 300,
  isLoading = false,
  showLegend = true,
  showGrid = true,
  className,
  emptyMessage = "No data available",
}: MetricsChartProps) {
  // Build chart config from dataKeys
  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    dataKeys.forEach((dk) => {
      config[dk.key] = {
        label: dk.label,
        color: dk.color,
      };
    });
    return config;
  }, [dataKeys]);

  const renderAreaChart = () => (
    <AreaChart
      accessibilityLayer
      data={data}
      margin={{ left: -30, right: 12, top: 12, bottom: 12 }}
    >
      {showGrid && <CartesianGrid vertical={false} />}
      <XAxis
        dataKey={xAxisKey}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        fontSize={11}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        fontSize={11}
      />
      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
      {showLegend && <ChartLegend content={<ChartLegendContent payload={[]} />} />}
      <defs>
        {dataKeys.map((dk) => (
          <linearGradient key={dk.key} id={`fill-${dk.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={dk.color} stopOpacity={0.8} />
            <stop offset="95%" stopColor={dk.color} stopOpacity={0.1} />
          </linearGradient>
        ))}
      </defs>
      {dataKeys.map((dk) => (
        <Area
          key={dk.key}
          dataKey={dk.key}
          type="natural"
          fill={`url(#fill-${dk.key})`}
          fillOpacity={0.4}
          stroke={dk.color}
          strokeWidth={2}
          stackId={stacked ? "stack" : undefined}
        />
      ))}
    </AreaChart>
  );

  const renderBarChart = () => (
    <BarChart
      accessibilityLayer
      data={data}
      margin={{ left:-30, right: 12, top: 12, bottom: 12 }}
    >
      {showGrid && <CartesianGrid vertical={false} />}
      <XAxis
        dataKey={xAxisKey}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        fontSize={11}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        fontSize={11}
      />
      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
      {showLegend && <ChartLegend content={<ChartLegendContent payload={[]} />} />}
      {dataKeys.map((dk) => (
        <Bar
          key={dk.key}
          dataKey={dk.key}
          fill={dk.color}
          radius={[4, 4, 0, 0]}
          stackId={stacked ? "stack" : undefined}
        />
      ))}
    </BarChart>
  );

  const renderLineChart = () => (
    <LineChart
      accessibilityLayer
      data={data}
      margin={{ left: -30, right: 12, top: 12, bottom: 12 }}
    >
      {showGrid && <CartesianGrid vertical={false} />}
      <XAxis
        dataKey={xAxisKey}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        fontSize={11}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        fontSize={11}
      />
      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
      {showLegend && <ChartLegend content={<ChartLegendContent payload={[]} />} />}
      {dataKeys.map((dk) => (
        <Line
          key={dk.key}
          dataKey={dk.key}
          type="natural"
          stroke={dk.color}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: dk.color }}
        />
      ))}
    </LineChart>
  );

  const renderChart = () => {
    switch (type) {
      case "area":
        return renderAreaChart();
      case "bar":
        return renderBarChart();
      case "line":
        return renderLineChart();
      default:
        return renderAreaChart();
    }
  };

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center" style={{ height }}>
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : data.length === 0 ? (
          <div className="flex items-center justify-center text-muted-foreground" style={{ height }}>
            {emptyMessage}
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="w-full" style={{ height }}>
            {renderChart()}
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

// Donut Chart for distributions
interface DonutChartProps {
  title: string;
  description?: string;
  data: Array<{ name: string; value: number; color: string }>;
  height?: number;
  isLoading?: boolean;
  className?: string;
  centerLabel?: string;
  centerValue?: string | number;
}

export function DonutChart({
  title,
  description,
  data,
  height = 250,
  isLoading = false,
  className,
  centerLabel,
  centerValue,
}: DonutChartProps) {
  const total = useMemo(() => data.reduce((acc, d) => acc + d.value, 0), [data]);

  // Build chart config from data
  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    data.forEach((d) => {
      config[d.name] = {
        label: d.name,
        color: d.color,
      };
    });
    return config;
  }, [data]);

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center" style={{ height }}>
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : data.length === 0 || total === 0 ? (
          <div className="flex items-center justify-center text-muted-foreground" style={{ height }}>
            No data available
          </div>
        ) : (
          <div className="flex items-center gap-6">
            <div style={{ height, width: height }} className="relative">
              <ChartContainer config={chartConfig} className="w-full h-full">
                <PieChart>
                  <ChartTooltip
                    cursor={false}
                    content={<ChartTooltipContent hideLabel />}
                  />
                  <Pie
                    data={data}
                    cx="50%"
                    cy="50%"
                    innerRadius={height * 0.28}
                    outerRadius={height * 0.38}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                  >
                    {data.map((entry, index) => (
                      <Cell key={index} fill={entry.color} stroke="transparent" />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
              {(centerLabel || centerValue !== undefined) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  {centerValue !== undefined && (
                    <span className="text-2xl font-bold">{centerValue}</span>
                  )}
                  {centerLabel && (
                    <span className="text-xs text-muted-foreground">{centerLabel}</span>
                  )}
                </div>
              )}
            </div>
            <div className="flex-1 space-y-2">
              {data.map((entry, index) => (
                <div key={index} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="text-muted-foreground">{entry.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{entry.value}</span>
                    <span className="text-xs text-muted-foreground">
                      ({((entry.value / total) * 100).toFixed(1)}%)
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
