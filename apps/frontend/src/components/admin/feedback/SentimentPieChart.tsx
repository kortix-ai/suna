'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminSentimentSummary } from '@/hooks/admin/use-admin-feedback';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartConfig,
} from '@/components/ui/chart';
import { Pie, PieChart, Cell } from 'recharts';

const chartConfig = {
  positive: {
    label: 'Positive',
    color: 'hsl(220 80% 50%)',
  },
  neutral: {
    label: 'Neutral',
    color: 'hsl(220 20% 60%)',
  },
  negative: {
    label: 'Negative',
    color: 'hsl(0 70% 50%)',
  },
} satisfies ChartConfig;

const COLORS = ['hsl(220 80% 50%)', 'hsl(220 20% 60%)', 'hsl(0 70% 50%)'];

export function SentimentPieChart() {
  const { data: sentiment, isLoading } = useAdminSentimentSummary();

  const chartData = sentiment ? [
    { name: 'Positive (4-5★)', value: sentiment.positive, fill: COLORS[0] },
    { name: 'Neutral (3-3.5★)', value: sentiment.neutral, fill: COLORS[1] },
    { name: 'Negative (1-2.5★)', value: sentiment.negative, fill: COLORS[2] },
  ].filter(d => d.value > 0) : [];

  const total = chartData.reduce((sum, d) => sum + d.value, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium">Sentiment Breakdown</CardTitle>
        <CardDescription>Overall feedback sentiment</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[250px] w-full" />
        ) : chartData.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-muted-foreground">
            No sentiment data available
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <ChartContainer config={chartConfig} className="h-[200px] w-full">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                  strokeWidth={0}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Pie>
                <ChartTooltip 
                  content={<ChartTooltipContent />}
                  formatter={(value, name) => [
                    `${value} (${total > 0 ? ((Number(value) / total) * 100).toFixed(1) : 0}%)`,
                    name
                  ]}
                />
              </PieChart>
            </ChartContainer>
            <div className="flex flex-wrap justify-center gap-4 mt-2">
              {chartData.map((entry, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div 
                    className="w-3 h-3 rounded-full" 
                    style={{ backgroundColor: entry.fill }}
                  />
                  <span className="text-xs text-muted-foreground">
                    {entry.name}: {entry.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
