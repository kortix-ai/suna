'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AdminFeedbackTable } from '@/components/admin/admin-feedback-table';
import {
  FeedbackStatsCards,
  FeedbackTrendChart,
  RatingDistributionChart,
  SentimentPieChart,
  CriticalFeedbackList,
  LLMAnalysisPanel,
} from '@/components/admin/feedback';
import { BarChart3, MessageSquare, Sparkles } from 'lucide-react';

export default function AdminFeedbackPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Feedback Analytics
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor user feedback, analyze trends, and get AI-powered insights
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
              AI Analysis
            </TabsTrigger>
            <TabsTrigger value="all" className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              All Feedback
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <FeedbackTrendChart />
              </div>
              <div>
                <CriticalFeedbackList />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
