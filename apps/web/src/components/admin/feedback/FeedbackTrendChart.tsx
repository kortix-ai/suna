'use client';

import { useTranslations } from 'next-intl';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useMemo, useState } from 'react';
import { useAdminFeedbackTimeSeries } from '@/hooks/admin/use-admin-feedback';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Bar, BarChart, XAxis, CartesianGrid } from 'recharts';
import { format, parseISO } from 'date-fns';

const chartConfig = {
  positive: {
    label: 'Positive (4-5★)',
    color: 'hsl(221 83% 53%)',
  },
  neutral: {
    label: 'Neutral (3-3.5★)',
    color: 'hsl(220 9% 46%)',
  },
  negative: {
    label: 'Negative (1-2.5★)',
    color: 'hsl(0 84% 60%)',
  },
} satisfies ChartConfig;

export function FeedbackTrendChart() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [days, setDays] = useState(30);
  const [granularity, setGranularity] = useState('day');
  
  const { data: timeSeries, isLoading } = useAdminFeedbackTimeSeries(days, granularity);

  const chartData = useMemo(
    () =>
      timeSeries?.map(point => {
        const neutral = (point.count || 0) - (point.positive_count || 0) - (point.negative_count || 0);
        return {
          date: point.period ? format(parseISO(point.period), granularity === 'month' ? 'MMM yyyy' : 'MMM d') : '',
          positive: point.positive_count || 0,
          neutral: Math.max(0, neutral),
          negative: point.negative_count || 0,
        };
      }) || [],
    [timeSeries, granularity],
  );

  return (
    <Card className='h-full'>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base font-medium">{tHardcodedUi.raw('componentsAdminFeedbackFeedbacktrendchart.line54JsxTextFeedbackVolume')}</CardTitle>
          <CardDescription>{tHardcodedUi.raw('componentsAdminFeedbackFeedbacktrendchart.line55JsxTextStackedBySentimentOverTime')}</CardDescription>
        </div>
        <div className="flex gap-2">
          <Select value={granularity} onValueChange={setGranularity}>
            <SelectTrigger className="w-[100px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Daily</SelectItem>
              <SelectItem value="week">Weekly</SelectItem>
              <SelectItem value="month">Monthly</SelectItem>
            </SelectContent>
          </Select>
          <Select value={days.toString()} onValueChange={(v) => setDays(parseInt(v))}>
            <SelectTrigger className="w-[100px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{tHardcodedUi.raw('componentsAdminFeedbackFeedbacktrendchart.line73JsxTextText7Days')}</SelectItem>
              <SelectItem value="30">{tHardcodedUi.raw('componentsAdminFeedbackFeedbacktrendchart.line74JsxTextText30Days')}</SelectItem>
              <SelectItem value="90">{tHardcodedUi.raw('componentsAdminFeedbackFeedbacktrendchart.line75JsxTextText90Days')}</SelectItem>
              <SelectItem value="180">{tHardcodedUi.raw('componentsAdminFeedbackFeedbacktrendchart.line76JsxTextText6Months')}</SelectItem>
              <SelectItem value="365">{tHardcodedUi.raw('componentsAdminFeedbackFeedbacktrendchart.line77JsxTextText1Year')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : chartData.length === 0 ? (
          <div className="h-[300px] flex items-center justify-center text-muted-foreground">{tHardcodedUi.raw('componentsAdminFeedbackFeedbacktrendchart.line87JsxTextNoDataAvailableForTheSelectedPeriod')}</div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <BarChart accessibilityLayer data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                tickMargin={10}
                axisLine={false}
              />
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                dataKey="positive"
                stackId="a"
                fill="var(--color-positive)"
                radius={[0, 0, 4, 4]}
              />
              <Bar
                dataKey="neutral"
                stackId="a"
                fill="var(--color-neutral)"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="negative"
                stackId="a"
                fill="var(--color-negative)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
