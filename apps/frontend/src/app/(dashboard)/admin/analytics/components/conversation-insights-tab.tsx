'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Brain,
  AlertTriangle,
  TrendingDown,
  Lightbulb,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  Frown,
  Meh,
  Smile,
  HelpCircle,
  ExternalLink,
} from 'lucide-react';
import {
  useConversationInsights,
  useFrustratedConversations,
  useChurnRiskConversations,
  useFeatureRequests,
  useTopicDistribution,
  useAnalyticsQueueStatus,
  useUseCasePatterns,
  useClusteredUseCases,
} from '@/hooks/admin/use-conversation-analytics';

interface ConversationInsightsTabProps {
  dateFrom?: string;
  dateTo?: string;
}

// Sentiment icon mapping
const SentimentIcon = ({ label }: { label?: string | null }) => {
  switch (label) {
    case 'positive':
      return <Smile className="h-4 w-4 text-emerald-500" />;
    case 'negative':
      return <Frown className="h-4 w-4 text-red-500" />;
    case 'mixed':
      return <HelpCircle className="h-4 w-4 text-amber-500" />;
    default:
      return <Meh className="h-4 w-4 text-muted-foreground" />;
  }
};

// Topic badge colors
const topicColors: Record<string, string> = {
  file_operations: 'bg-blue-500/10 text-blue-700 border-blue-500/20',
  web_browsing: 'bg-purple-500/10 text-purple-700 border-purple-500/20',
  code_execution: 'bg-orange-500/10 text-orange-700 border-orange-500/20',
  api_integration: 'bg-green-500/10 text-green-700 border-green-500/20',
  workflow_automation: 'bg-pink-500/10 text-pink-700 border-pink-500/20',
  data_extraction: 'bg-cyan-500/10 text-cyan-700 border-cyan-500/20',
  other: 'bg-gray-500/10 text-gray-700 border-gray-500/20',
};

export function ConversationInsightsTab({ dateFrom, dateTo }: ConversationInsightsTabProps) {
  const [activeSection, setActiveSection] = useState<'overview' | 'frustrated' | 'churn' | 'features'>('overview');
  const [frustratedPage, setFrustratedPage] = useState(1);
  const [churnPage, setChurnPage] = useState(1);
  const [featuresPage, setFeaturesPage] = useState(1);

  // Data fetching
  const { data: insights, isLoading: insightsLoading } = useConversationInsights(dateFrom, dateTo);
  const { data: topicData, isLoading: topicsLoading } = useTopicDistribution(dateFrom, dateTo);
  const { data: useCaseData, isLoading: useCasesLoading } = useUseCasePatterns(dateFrom, dateTo);
  const { data: clusteredData, isLoading: clusteredLoading } = useClusteredUseCases(dateFrom, dateTo);
  const { data: queueStatus } = useAnalyticsQueueStatus();
  const { data: frustratedData, isLoading: frustratedLoading } = useFrustratedConversations(0.5, frustratedPage, 10);
  const { data: churnData, isLoading: churnLoading } = useChurnRiskConversations(0.7, churnPage, 10);
  const { data: featuresData, isLoading: featuresLoading } = useFeatureRequests(featuresPage, 10);

  const isLoading = insightsLoading || topicsLoading || useCasesLoading || clusteredLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Queue Status Banner */}
      {queueStatus && queueStatus.queue.pending > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <Brain className="h-4 w-4 text-amber-600" />
          <span className="text-sm text-amber-700">
            {queueStatus.queue.pending} conversations queued for analysis
            {queueStatus.queue.processing > 0 && `, ${queueStatus.queue.processing} processing`}
          </span>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-5 gap-4">
        <div className="text-center p-4 rounded-xl border bg-card">
          <p className="text-3xl font-bold">{insights?.total_analyzed || 0}</p>
          <p className="text-xs text-muted-foreground mt-1">Analyzed</p>
        </div>
        <div className="text-center p-4 rounded-xl border bg-card">
          <div className="flex items-center justify-center gap-2">
            <Smile className="h-5 w-5 text-emerald-500" />
            <p className="text-3xl font-bold text-emerald-600">{insights?.sentiment_distribution.positive || 0}</p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Positive</p>
        </div>
        <div className="text-center p-4 rounded-xl border bg-card">
          <div className="flex items-center justify-center gap-2">
            <Frown className="h-5 w-5 text-red-500" />
            <p className="text-3xl font-bold text-red-600">{insights?.sentiment_distribution.negative || 0}</p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Negative</p>
        </div>
        <div className="text-center p-4 rounded-xl border bg-card">
          <p className="text-3xl font-bold text-amber-600">{((insights?.avg_frustration || 0) * 100).toFixed(0)}%</p>
          <p className="text-xs text-muted-foreground mt-1">Avg Frustration</p>
        </div>
        <div className="text-center p-4 rounded-xl border bg-card">
          <p className="text-3xl font-bold text-purple-600">{insights?.feature_request_count || 0}</p>
          <p className="text-xs text-muted-foreground mt-1">Feature Requests</p>
        </div>
      </div>

      {/* Section Tabs */}
      <div className="flex gap-2 border-b pb-2">
        {[
          { id: 'overview', label: 'Overview', icon: Brain },
          { id: 'frustrated', label: 'Frustrated', icon: AlertTriangle, count: frustratedData?.pagination.total_items },
          { id: 'churn', label: 'Churn Risk', icon: TrendingDown, count: churnData?.pagination.total_items },
          { id: 'features', label: 'Feature Requests', icon: Lightbulb, count: featuresData?.pagination.total_items },
        ].map(({ id, label, icon: Icon, count }) => (
          <Button
            key={id}
            variant={activeSection === id ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setActiveSection(id as typeof activeSection)}
            className="gap-1.5"
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {count !== undefined && count > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                {count}
              </Badge>
            )}
          </Button>
        ))}
      </div>

      {/* Section Content */}
      {activeSection === 'overview' && (
        <div className="grid grid-cols-2 gap-6">
          {/* Sentiment Distribution */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4 flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              Sentiment Distribution
            </h3>
            <div className="space-y-3">
              {[
                { label: 'Positive', value: insights?.sentiment_distribution.positive || 0, color: 'bg-emerald-500' },
                { label: 'Neutral', value: insights?.sentiment_distribution.neutral || 0, color: 'bg-gray-400' },
                { label: 'Negative', value: insights?.sentiment_distribution.negative || 0, color: 'bg-red-500' },
                { label: 'Mixed', value: insights?.sentiment_distribution.mixed || 0, color: 'bg-amber-500' },
              ].map(({ label, value, color }) => {
                const total = insights?.total_analyzed || 1;
                const percent = (value / total) * 100;
                return (
                  <div key={label} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>{label}</span>
                      <span className="text-muted-foreground">{value} ({percent.toFixed(0)}%)</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div className={cn('h-full rounded-full', color)} style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Topic Distribution */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4 flex items-center gap-2">
              <Brain className="h-4 w-4 text-muted-foreground" />
              Topic Distribution
            </h3>
            <div className="flex flex-wrap gap-2">
              {topicData?.distribution && Object.entries(topicData.distribution)
                .sort(([, a], [, b]) => b - a)
                .map(([topic, count]) => (
                  <Badge
                    key={topic}
                    variant="outline"
                    className={cn('text-xs', topicColors[topic] || topicColors.other)}
                  >
                    {topic.replace('_', ' ')} ({count})
                  </Badge>
                ))}
              {(!topicData?.distribution || Object.keys(topicData.distribution).length === 0) && (
                <p className="text-sm text-muted-foreground">No topic data available</p>
              )}
            </div>
          </div>

          {/* Intent Distribution */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4">Intent Distribution</h3>
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: 'Tasks', value: insights?.intent_distribution.task || 0, color: 'bg-blue-500/10 text-blue-700' },
                { label: 'Questions', value: insights?.intent_distribution.question || 0, color: 'bg-purple-500/10 text-purple-700' },
                { label: 'Complaints', value: insights?.intent_distribution.complaint || 0, color: 'bg-red-500/10 text-red-700' },
                { label: 'Feature Req.', value: insights?.intent_distribution.feature_request || 0, color: 'bg-green-500/10 text-green-700' },
              ].map(({ label, value, color }) => (
                <div key={label} className={cn('text-center p-3 rounded-lg', color)}>
                  <p className="text-2xl font-bold">{value}</p>
                  <p className="text-xs mt-1">{label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Risk Scores */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4">Risk Indicators</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-4 rounded-lg bg-amber-500/10">
                <p className="text-3xl font-bold text-amber-700">
                  {((insights?.avg_frustration || 0) * 100).toFixed(0)}%
                </p>
                <p className="text-xs text-amber-700/80 mt-1">Avg Frustration</p>
              </div>
              <div className="text-center p-4 rounded-lg bg-red-500/10">
                <p className="text-3xl font-bold text-red-700">
                  {((insights?.avg_churn_risk || 0) * 100).toFixed(0)}%
                </p>
                <p className="text-xs text-red-700/80 mt-1">Avg Churn Risk</p>
              </div>
            </div>
          </div>

          {/* What Users Are Doing - Full Width */}
          <div className="col-span-2 rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4 flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-muted-foreground" />
              What Users Are Doing
            </h3>

            <div className="grid grid-cols-3 gap-6">
              {/* Clustered Use Cases */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-3">
                  Top Use Cases (Grouped)
                  {clusteredData?.total_clusters != null && (
                    <span className="ml-1 text-muted-foreground/60">
                      ({clusteredData.total_clusters} groups)
                    </span>
                  )}
                </p>
                <div className="space-y-2">
                  {clusteredData?.clusters.slice(0, 8).map((cluster) => (
                    <div key={cluster.cluster_id} className="flex items-center justify-between text-sm group">
                      <div className="truncate flex-1 min-w-0">
                        <span>{cluster.label}</span>
                        {cluster.use_cases.length > 1 && (
                          <span className="text-xs text-muted-foreground ml-1.5 opacity-60 group-hover:opacity-100">
                            +{cluster.use_cases.length - 1} similar
                          </span>
                        )}
                      </div>
                      <Badge variant="secondary" className="ml-2 shrink-0">{cluster.count}</Badge>
                    </div>
                  ))}
                  {(!clusteredData?.clusters || clusteredData.clusters.length === 0) && (
                    useCaseData?.top_use_cases.slice(0, 8).map((item, i) => (
                      <div key={i} className="flex items-center justify-between text-sm">
                        <span className="truncate">{item.use_case}</span>
                        <Badge variant="secondary" className="ml-2 shrink-0">{item.count}</Badge>
                      </div>
                    ))
                  )}
                  {(!clusteredData?.clusters || clusteredData.clusters.length === 0) &&
                   (!useCaseData?.top_use_cases || useCaseData.top_use_cases.length === 0) && (
                    <p className="text-sm text-muted-foreground">No data yet</p>
                  )}
                </div>
              </div>

              {/* Output Types */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-3">What They&apos;re Creating</p>
                <div className="flex flex-wrap gap-2">
                  {useCaseData?.output_types && Object.entries(useCaseData.output_types)
                    .sort(([, a], [, b]) => b - a)
                    .map(([type, count]) => (
                      <Badge key={type} variant="outline" className="capitalize">
                        {type} ({count})
                      </Badge>
                    ))}
                  {(!useCaseData?.output_types || Object.keys(useCaseData.output_types).length === 0) && (
                    <p className="text-sm text-muted-foreground">No data yet</p>
                  )}
                </div>
              </div>

              {/* Domains */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-3">Business Areas</p>
                <div className="flex flex-wrap gap-2">
                  {useCaseData?.domains && Object.entries(useCaseData.domains)
                    .sort(([, a], [, b]) => b - a)
                    .map(([domain, count]) => (
                      <Badge key={domain} variant="outline" className="capitalize">
                        {domain} ({count})
                      </Badge>
                    ))}
                  {(!useCaseData?.domains || Object.keys(useCaseData.domains).length === 0) && (
                    <p className="text-sm text-muted-foreground">No data yet</p>
                  )}
                </div>
              </div>
            </div>

            {/* Keywords Cloud */}
            {useCaseData?.top_keywords && useCaseData.top_keywords.length > 0 && (
              <div className="mt-6 pt-4 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-3">Trending Keywords</p>
                <div className="flex flex-wrap gap-2">
                  {useCaseData.top_keywords.slice(0, 15).map((item, i) => (
                    <Badge
                      key={i}
                      variant="secondary"
                      className={cn(
                        "text-xs",
                        i < 3 && "bg-primary/10 text-primary"
                      )}
                    >
                      {item.keyword} ({item.count})
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {activeSection === 'frustrated' && (
        <ConversationList
          data={frustratedData?.data || []}
          loading={frustratedLoading}
          pagination={frustratedData?.pagination}
          page={frustratedPage}
          onPageChange={setFrustratedPage}
          emptyMessage="No frustrated conversations found"
          highlightField="frustration"
        />
      )}

      {activeSection === 'churn' && (
        <ConversationList
          data={churnData?.data || []}
          loading={churnLoading}
          pagination={churnData?.pagination}
          page={churnPage}
          onPageChange={setChurnPage}
          emptyMessage="No high churn risk conversations found"
          highlightField="churn"
        />
      )}

      {activeSection === 'features' && (
        <ConversationList
          data={featuresData?.data || []}
          loading={featuresLoading}
          pagination={featuresData?.pagination}
          page={featuresPage}
          onPageChange={setFeaturesPage}
          emptyMessage="No feature requests detected"
          highlightField="feature"
        />
      )}
    </div>
  );
}

// Conversation list component
interface ConversationListProps {
  data: Array<{
    id: string;
    thread_id: string;
    user_email?: string | null;
    sentiment_label?: string | null;
    frustration_score?: number | null;
    frustration_signals: string[];
    churn_risk_score?: number | null;
    churn_signals: string[];
    primary_topic?: string | null;
    feature_request_text?: string | null;
    user_message_count?: number | null;
    analyzed_at: string;
  }>;
  loading: boolean;
  pagination?: {
    total_items: number;
    total_pages: number;
    has_next: boolean;
    has_previous: boolean;
  };
  page: number;
  onPageChange: (page: number) => void;
  emptyMessage: string;
  highlightField: 'frustration' | 'churn' | 'feature';
}

function ConversationList({
  data,
  loading,
  pagination,
  page,
  onPageChange,
  emptyMessage,
  highlightField,
}: ConversationListProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Brain className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {data.map((item) => (
          <div key={item.id} className="rounded-lg border bg-card p-4 hover:border-border/80 transition-colors">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <SentimentIcon label={item.sentiment_label} />
                  <span className="text-sm font-medium truncate">
                    {item.user_email || 'Unknown user'}
                  </span>
                  {item.primary_topic && (
                    <Badge variant="outline" className={cn('text-xs', topicColors[item.primary_topic] || topicColors.other)}>
                      {item.primary_topic.replace('_', ' ')}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {item.user_message_count} messages
                  </span>
                </div>

                {highlightField === 'frustration' && item.frustration_signals.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {item.frustration_signals.slice(0, 3).map((signal, i) => (
                      <Badge key={i} variant="secondary" className="text-xs bg-amber-500/10 text-amber-700">
                        {signal}
                      </Badge>
                    ))}
                    {item.frustration_signals.length > 3 && (
                      <Badge variant="secondary" className="text-xs">
                        +{item.frustration_signals.length - 3} more
                      </Badge>
                    )}
                  </div>
                )}

                {highlightField === 'churn' && item.churn_signals.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {item.churn_signals.slice(0, 3).map((signal, i) => (
                      <Badge key={i} variant="secondary" className="text-xs bg-red-500/10 text-red-700">
                        {signal}
                      </Badge>
                    ))}
                    {item.churn_signals.length > 3 && (
                      <Badge variant="secondary" className="text-xs">
                        +{item.churn_signals.length - 3} more
                      </Badge>
                    )}
                  </div>
                )}

                {highlightField === 'feature' && item.feature_request_text && (
                  <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                    &ldquo;{item.feature_request_text}&rdquo;
                  </p>
                )}
              </div>

              <div className="flex flex-col items-end gap-2">
                {highlightField === 'frustration' && item.frustration_score != null && (
                  <div className={cn(
                    'text-lg font-bold px-2 py-1 rounded',
                    item.frustration_score >= 0.7 ? 'bg-red-500/10 text-red-700' :
                    item.frustration_score >= 0.5 ? 'bg-amber-500/10 text-amber-700' :
                    'bg-gray-500/10 text-gray-700'
                  )}>
                    {(item.frustration_score * 100).toFixed(0)}%
                  </div>
                )}

                {highlightField === 'churn' && item.churn_risk_score != null && (
                  <div className={cn(
                    'text-lg font-bold px-2 py-1 rounded',
                    item.churn_risk_score >= 0.8 ? 'bg-red-500/10 text-red-700' :
                    item.churn_risk_score >= 0.7 ? 'bg-amber-500/10 text-amber-700' :
                    'bg-gray-500/10 text-gray-700'
                  )}>
                    {(item.churn_risk_score * 100).toFixed(0)}%
                  </div>
                )}

                <a
                  href={`/threads/${item.thread_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                >
                  View thread <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {pagination && pagination.total_pages > 1 && (
        <div className="flex items-center justify-between pt-4 border-t">
          <span className="text-sm text-muted-foreground">
            Page {page} of {pagination.total_pages} ({pagination.total_items} total)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!pagination.has_previous}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!pagination.has_next}
              onClick={() => onPageChange(page + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ConversationInsightsTab;
