'use client';

import { useTranslations } from 'next-intl';

import { AdminFeedbackTable } from '@/components/admin/admin-feedback-table';
import {
  CriticalFeedbackList,
  FeedbackStatsCards,
  LLMAnalysisPanel,
} from '@/components/admin/feedback';
import { LegacyBanner } from '@/components/admin/legacy-banner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChartBar as BarChart3, Message as MessageSquare, Sparkles } from '@mynaui/icons-react';
import dynamic from 'next/dynamic';

// The three recharts charts are the only recharts consumers on this page; load
// them lazily so recharts stays out of the feedback page chunk.
const chartLoading = () => (
  <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
    <ChartLoadingText />
  </div>
);

function ChartLoadingText() {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return tHardcodedUi.raw('autoComponentsPagesAdminFeedbackPageJsxTextLoadingChartc252c8eb');
}
const FeedbackTrendChart = dynamic(
  () => import('@/components/admin/feedback/FeedbackTrendChart').then((m) => m.FeedbackTrendChart),
  { ssr: false, loading: chartLoading },
);
const RatingDistributionChart = dynamic(
  () =>
    import('@/components/admin/feedback/RatingDistributionChart').then(
      (m) => m.RatingDistributionChart,
    ),
  { ssr: false, loading: chartLoading },
);
const SentimentPieChart = dynamic(
  () => import('@/components/admin/feedback/SentimentPieChart').then((m) => m.SentimentPieChart),
  { ssr: false, loading: chartLoading },
);

export default function AdminFeedbackPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <LegacyBanner feature="Feedback" />
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {tHardcodedUi.raw('componentsPagesAdminFeedbackPage.line24JsxTextFeedbackAnalytics')}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {tHardcodedUi.raw(
                'componentsPagesAdminFeedbackPage.line27JsxTextMonitorUserFeedbackAnalyzeTrendsAndGetAi',
              )}
            </p>
          </div>
        </div>
        <FeedbackStatsCards />
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="grid w-full max-w-md grid-cols-3">
            <TabsTrigger value="overview" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="analysis" className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              {tHardcodedUi.raw('componentsPagesAdminFeedbackPage.line40JsxTextAiAnalysis')}
            </TabsTrigger>
            <TabsTrigger value="all" className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              {tHardcodedUi.raw('componentsPagesAdminFeedbackPage.line44JsxTextAllFeedback')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-6">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <FeedbackTrendChart />
              </div>
              <div>
                <CriticalFeedbackList />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <RatingDistributionChart />
              <SentimentPieChart />
            </div>
          </TabsContent>
          <TabsContent value="analysis" className="space-y-6">
            <LLMAnalysisPanel />
          </TabsContent>
          <TabsContent value="all" className="space-y-6">
            <AdminFeedbackTable />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
