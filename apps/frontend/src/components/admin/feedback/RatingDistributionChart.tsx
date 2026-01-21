'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminFeedbackStats } from '@/hooks/admin/use-admin-feedback';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartConfig,
} from '@/components/ui/chart';
import { Bar, BarChart, XAxis, YAxis, Cell } from 'recharts';

const chartConfig = {
  count: {
    label: 'Count',
  },
} satisfies ChartConfig;

const ratingColors: Record<string, string> = {
  '0.5': 'hsl(0 70% 45%)',
  '1': 'hsl(0 65% 50%)',
  '1.5': 'hsl(10 60% 50%)',
  '2': 'hsl(15 55% 50%)',
  '2.5': 'hsl(25 50% 50%)',
  '3': 'hsl(200 40% 50%)',
  '3.5': 'hsl(210 50% 50%)',
  '4': 'hsl(215 60% 50%)',
  '4.5': 'hsl(220 70% 50%)',
  '5': 'hsl(225 80% 50%)',
};

export function RatingDistributionChart() {
  const { data: stats, isLoading } = useAdminFeedbackStats();

  const chartData = stats?.rating_distribution
    ? Object.entries(stats.rating_distribution)
        .map(([rating, count]) => ({
          rating: parseFloat(rating).toFixed(1),
          count: count as number,
          fill: ratingColors[rating] || 'hsl(220 70% 50%)',
        }))
        .sort((a, b) => parseFloat(a.rating) - parseFloat(b.rating))
    : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium">Rating Distribution</CardTitle>
        <CardDescription>Breakdown by star rating</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[250px] w-full" />
        ) : chartData.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-muted-foreground">
            No rating data available
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[250px] w-full">
            <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 20, left: 0, bottom: 0 }}>
              <XAxis 
                type="number" 
                tickLine={false} 
                axisLine={false}
                fontSize={12}
                className="text-muted-foreground"
              />
              <YAxis 
                type="category" 
                dataKey="rating" 
                tickLine={false} 
                axisLine={false}
                fontSize={12}
                width={40}
                tickFormatter={(value) => `${value}★`}
                className="text-muted-foreground"
              />
              <ChartTooltip 
                content={<ChartTooltipContent />}
                formatter={(value) => [`${value} reviews`, 'Count']}
              />
              <Bar 
                dataKey="count" 
                radius={[0, 4, 4, 0]}
                maxBarSize={24}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
