'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Brain,
  AlertTriangle,
  Lightbulb,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  Frown,
  Meh,
  Smile,
  HelpCircle,
  ExternalLink,
  X,
  ArrowLeft,
  UserX,
  TrendingDown,
  Activity,
} from 'lucide-react';
import {
  useConversationInsights,
  useFrustratedConversations,
  useFeatureRequests,
  useAnalyticsQueueStatus,
  useClusteredUseCases,
  useConversationsBySentiment,
  useConversationsByIntent,
  useConversationsByCategory,
  useEngagementSummary,
  useAccountsBySegment,
  type ConversationAnalyticsItem,
  type AccountEngagementItem,
  type SegmentAccount,
} from '@/hooks/admin/use-conversation-analytics';
import { UserEmailLink } from './user-email-link';

interface ConversationInsightsTabProps {
  dateFrom?: string;
  dateTo?: string;
  onUserClick?: (email: string) => void;
}

// Sentiment icon mapping
const SentimentIcon = ({ label, size = 'sm' }: { label?: string | null; size?: 'sm' | 'md' }) => {
  const sizeClass = size === 'md' ? 'h-5 w-5' : 'h-4 w-4';
  switch (label) {
    case 'positive':
      return <Smile className={cn(sizeClass, 'text-emerald-500')} />;
    case 'negative':
      return <Frown className={cn(sizeClass, 'text-red-500')} />;
    case 'mixed':
      return <HelpCircle className={cn(sizeClass, 'text-amber-500')} />;
    default:
      return <Meh className={cn(sizeClass, 'text-muted-foreground')} />;
  }
};

type DrillDownType =
  | { type: 'sentiment'; value: string; label: string }
  | { type: 'intent'; value: string; label: string }
  | { type: 'category'; value: string; label: string }
  | null;

export function ConversationInsightsTab({ dateFrom, dateTo, onUserClick }: ConversationInsightsTabProps) {
  const [activeSection, setActiveSection] = useState<'overview' | 'frustrated' | 'features' | 'at-risk'>('overview');
  const [frustratedPage, setFrustratedPage] = useState(1);
  const [featuresPage, setFeaturesPage] = useState(1);
  const [drillDown, setDrillDown] = useState<DrillDownType>(null);
  const [drillDownPage, setDrillDownPage] = useState(1);

  // Data fetching
  const { data: insights, isLoading: insightsLoading } = useConversationInsights(dateFrom, dateTo);
  const { data: clusteredData, isLoading: clusteredLoading } = useClusteredUseCases(dateFrom, dateTo);
  const { data: queueStatus } = useAnalyticsQueueStatus();
  const { data: frustratedData, isLoading: frustratedLoading } = useFrustratedConversations(0.5, frustratedPage, 10, dateFrom, dateTo);
  const { data: featuresData, isLoading: featuresLoading } = useFeatureRequests(featuresPage, 10, dateFrom, dateTo);
  const { data: engagementData, isLoading: engagementLoading } = useEngagementSummary(30, 20);

  // Reset pagination when date filters change
  useEffect(() => {
    setFrustratedPage(1);
    setFeaturesPage(1);
    setDrillDownPage(1);
  }, [dateFrom, dateTo]);

  // Drill-down data
  const { data: sentimentData, isLoading: sentimentLoading } = useConversationsBySentiment(
    drillDown?.type === 'sentiment' ? drillDown.value : null,
    drillDownPage,
    10,
    dateFrom,
    dateTo
  );
  const { data: intentData, isLoading: intentLoading } = useConversationsByIntent(
    drillDown?.type === 'intent' ? drillDown.value : null,
    drillDownPage,
    10,
    dateFrom,
    dateTo
  );
  const { data: categoryData, isLoading: categoryLoading } = useConversationsByCategory(
    drillDown?.type === 'category' ? drillDown.value : null,
    drillDownPage,
    10,
    dateFrom,
    dateTo
  );

  const isLoading = insightsLoading || clusteredLoading;

  const handleDrillDown = (type: 'sentiment' | 'intent' | 'category', value: string, label: string) => {
    setDrillDown({ type, value, label });
    setDrillDownPage(1);
  };

  const closeDrillDown = () => {
    setDrillDown(null);
    setDrillDownPage(1);
  };

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

  // Show drill-down panel if active
  if (drillDown) {
    const data = drillDown.type === 'sentiment' ? sentimentData
      : drillDown.type === 'intent' ? intentData
      : categoryData;
    const loading = drillDown.type === 'sentiment' ? sentimentLoading
      : drillDown.type === 'intent' ? intentLoading
      : categoryLoading;

    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3 pb-4 border-b">
          <Button variant="ghost" size="sm" onClick={closeDrillDown} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            {drillDown.type === 'sentiment' && <SentimentIcon label={drillDown.value} size="md" />}
            <h2 className="text-lg font-medium">{drillDown.label}</h2>
            {data?.pagination && (
              <Badge variant="secondary">{data.pagination.total_items} conversations</Badge>
            )}
          </div>
        </div>

        {/* Conversation List */}
        <DrillDownList
          data={data?.data || []}
          loading={loading}
          pagination={data?.pagination}
          page={drillDownPage}
          onPageChange={setDrillDownPage}
          drillDownType={drillDown.type}
          onUserClick={onUserClick}
        />
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
        <button
          onClick={() => handleDrillDown('sentiment', 'positive', 'Positive Conversations')}
          className="text-center p-4 rounded-xl border bg-card hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-center gap-2">
            <Smile className="h-5 w-5 text-emerald-500" />
            <p className="text-3xl font-bold text-emerald-600">{insights?.sentiment_distribution.positive || 0}</p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Positive</p>
        </button>
        <button
          onClick={() => handleDrillDown('sentiment', 'negative', 'Negative Conversations')}
          className="text-center p-4 rounded-xl border bg-card hover:border-red-500/50 hover:bg-red-500/5 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-center gap-2">
            <Frown className="h-5 w-5 text-red-500" />
            <p className="text-3xl font-bold text-red-600">{insights?.sentiment_distribution.negative || 0}</p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Negative</p>
        </button>
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
          { id: 'features', label: 'Feature Requests', icon: Lightbulb, count: featuresData?.pagination.total_items },
          { id: 'at-risk', label: 'At Risk', icon: UserX, count: engagementData?.at_risk_accounts.length },
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
          {/* Sentiment Distribution - Clickable */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4 flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              Sentiment Distribution
              <span className="text-xs text-muted-foreground font-normal">(click to view)</span>
            </h3>
            <div className="space-y-3">
              {[
                { label: 'Positive', value: insights?.sentiment_distribution.positive || 0, color: 'bg-emerald-500', hoverColor: 'hover:bg-emerald-500/10', key: 'positive' },
                { label: 'Neutral', value: insights?.sentiment_distribution.neutral || 0, color: 'bg-gray-400', hoverColor: 'hover:bg-gray-500/10', key: 'neutral' },
                { label: 'Negative', value: insights?.sentiment_distribution.negative || 0, color: 'bg-red-500', hoverColor: 'hover:bg-red-500/10', key: 'negative' },
                { label: 'Mixed', value: insights?.sentiment_distribution.mixed || 0, color: 'bg-amber-500', hoverColor: 'hover:bg-amber-500/10', key: 'mixed' },
              ].map(({ label, value, color, hoverColor, key }) => {
                const total = insights?.total_analyzed || 1;
                const percent = (value / total) * 100;
                return (
                  <button
                    key={label}
                    onClick={() => value > 0 && handleDrillDown('sentiment', key, `${label} Conversations`)}
                    disabled={value === 0}
                    className={cn(
                      'w-full text-left space-y-1 p-2 -m-2 rounded-lg transition-colors',
                      value > 0 ? `cursor-pointer ${hoverColor}` : 'cursor-default opacity-50'
                    )}
                  >
                    <div className="flex justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <SentimentIcon label={key} />
                        {label}
                      </span>
                      <span className="text-muted-foreground">{value} ({percent.toFixed(0)}%)</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div className={cn('h-full rounded-full', color)} style={{ width: `${percent}%` }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Intent Distribution - Clickable */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4">
              Intent Distribution
              <span className="text-xs text-muted-foreground font-normal ml-2">(click to view)</span>
            </h3>
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: 'Tasks', value: insights?.intent_distribution.task || 0, color: 'bg-blue-500/10 text-blue-700', hoverColor: 'hover:bg-blue-500/20', key: 'task' },
                { label: 'Questions', value: insights?.intent_distribution.question || 0, color: 'bg-purple-500/10 text-purple-700', hoverColor: 'hover:bg-purple-500/20', key: 'question' },
                { label: 'Complaints', value: insights?.intent_distribution.complaint || 0, color: 'bg-red-500/10 text-red-700', hoverColor: 'hover:bg-red-500/20', key: 'complaint' },
                { label: 'Feature Req.', value: insights?.intent_distribution.feature_request || 0, color: 'bg-green-500/10 text-green-700', hoverColor: 'hover:bg-green-500/20', key: 'feature_request' },
              ].map(({ label, value, color, hoverColor, key }) => (
                <button
                  key={label}
                  onClick={() => value > 0 && handleDrillDown('intent', key, `${label}`)}
                  disabled={value === 0}
                  className={cn(
                    'text-center p-3 rounded-lg transition-colors',
                    color,
                    value > 0 ? `cursor-pointer ${hoverColor}` : 'cursor-default opacity-50'
                  )}
                >
                  <p className="text-2xl font-bold">{value}</p>
                  <p className="text-xs mt-1">{label}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Avg Frustration */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4">Risk Indicator</h3>
            <div className="text-center p-4 rounded-lg bg-amber-500/10">
              <p className="text-3xl font-bold text-amber-700">
                {((insights?.avg_frustration || 0) * 100).toFixed(0)}%
              </p>
              <p className="text-xs text-amber-700/80 mt-1">Avg Frustration</p>
            </div>
          </div>

          {/* Top Use Cases */}
          <div className="col-span-2 rounded-xl border bg-card p-5">
            <h3 className="text-sm font-medium mb-4 flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-muted-foreground" />
              Top Use Cases
              {clusteredData?.total_clusters != null && (
                <span className="text-xs text-muted-foreground font-normal">
                  ({clusteredData.total_clusters} categories, click to view)
                </span>
              )}
            </h3>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {clusteredData?.clusters.slice(0, 8).map((cluster) => (
                <button
                  key={cluster.cluster_id}
                  onClick={() => handleDrillDown('category', cluster.label, cluster.label.replace(/_/g, ' '))}
                  className="p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer text-left"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-2xl font-bold">{cluster.count}</span>
                  </div>
                  <p className="text-sm font-medium truncate">{cluster.label.replace(/_/g, ' ')}</p>
                </button>
              ))}
              {(!clusteredData?.clusters || clusteredData.clusters.length === 0) && (
                <p className="text-sm text-muted-foreground col-span-4">No data yet</p>
              )}
            </div>
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
          onUserClick={onUserClick}
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
          onUserClick={onUserClick}
        />
      )}

      {activeSection === 'at-risk' && (
        <AtRiskSection data={engagementData} loading={engagementLoading} onUserClick={onUserClick} />
      )}
    </div>
  );
}

// Segment display helpers with detailed descriptions
// Frequency thresholds based on actual data: p25=1, median=2, p75=4, p90=9
const SEGMENT_CONFIG: Record<string, { label: string; color: string; description: string; criteria: string }> = {
  champion: {
    label: 'Champions',
    color: 'bg-emerald-500',
    description: 'Active power users',
    criteria: 'Used in last 3 days + 5+ runs/month (top 25%)'
  },
  loyal: {
    label: 'Loyal',
    color: 'bg-blue-500',
    description: 'Regular engaged users',
    criteria: 'Used in last 3 days + 2+ runs/month'
  },
  potential: {
    label: 'Potential',
    color: 'bg-cyan-500',
    description: 'Could become loyal',
    criteria: 'Used in last week + 3+ runs/month'
  },
  at_risk: {
    label: 'At Risk',
    color: 'bg-orange-500',
    description: 'Were active, now gone',
    criteria: 'No use in 15+ days but had 3+ runs (above median)'
  },
  hibernating: {
    label: 'Hibernating',
    color: 'bg-gray-500',
    description: 'Inactive users',
    criteria: 'No use in 15+ days + below median activity'
  },
  other: {
    label: 'Other',
    color: 'bg-gray-400',
    description: 'Mixed signals',
    criteria: 'Does not fit other segments'
  },
  unknown: {
    label: 'Unknown',
    color: 'bg-gray-400',
    description: 'No data',
    criteria: 'Unable to calculate'
  },
};

function AtRiskSection({ data, loading, onUserClick }: { data?: { total_accounts: number; segments: Record<string, number>; at_risk_accounts: AccountEngagementItem[]; avg_churn_risk: number }; loading: boolean; onUserClick?: (email: string) => void }) {
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const [segmentPage, setSegmentPage] = useState(1);
  const { data: segmentAccounts, isLoading: segmentLoading } = useAccountsBySegment(selectedSegment, 30, segmentPage, 50);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <UserX className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No engagement data available</p>
      </div>
    );
  }

  const atRiskCount = (data.segments.at_risk || 0) + (data.segments.cant_lose || 0) + (data.segments.hibernating || 0) + (data.segments.about_to_sleep || 0);

  // If a segment is selected, show accounts view
  if (selectedSegment && segmentAccounts) {
    const config = SEGMENT_CONFIG[selectedSegment] || SEGMENT_CONFIG.unknown;
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => { setSelectedSegment(null); setSegmentPage(1); }}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
          <div className={cn('w-3 h-3 rounded-full', config.color)} />
          <h3 className="font-medium">{config.label}</h3>
          <Badge variant="secondary">{segmentAccounts.total} accounts</Badge>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-4">{config.criteria}</p>

          {segmentLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : segmentAccounts.accounts.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">No accounts in this segment</p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground px-3 py-2 border-b">
                <div className="col-span-5">Email / Account</div>
                <div className="col-span-2">RFM Score</div>
                <div className="col-span-2">Last Active</div>
                <div className="col-span-2">Runs (30d)</div>
                <div className="col-span-1">Total</div>
              </div>
              {segmentAccounts.accounts.map((account) => (
                <div key={account.account_id} className="grid grid-cols-12 gap-2 text-sm px-3 py-2 rounded hover:bg-muted/50">
                  <div className="col-span-5 truncate font-medium">
                    {account.email && onUserClick ? (
                      <UserEmailLink email={account.email} onUserClick={onUserClick} />
                    ) : account.email ? (
                      account.email
                    ) : (
                      <span className="text-muted-foreground">{account.account_id.slice(0, 12)}...</span>
                    )}
                  </div>
                  <div className="col-span-2 font-mono">{account.rfm_score}</div>
                  <div className="col-span-2">{account.days_since_last_activity}d ago</div>
                  <div className="col-span-2">{account.runs_in_period}</div>
                  <div className="col-span-1">{account.total_runs}</div>
                </div>
              ))}
            </div>
          )}

          {segmentAccounts.total > 50 && (
            <div className="flex justify-center gap-2 mt-4 pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                disabled={segmentPage === 1}
                onClick={() => setSegmentPage(p => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground px-3 py-1">
                Page {segmentPage} of {Math.ceil(segmentAccounts.total / 50)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={segmentPage >= Math.ceil(segmentAccounts.total / 50)}
                onClick={() => setSegmentPage(p => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="text-center p-4 rounded-xl border bg-card">
          <p className="text-3xl font-bold">{data.total_accounts}</p>
          <p className="text-xs text-muted-foreground mt-1">Active Accounts</p>
        </div>
        <div className="text-center p-4 rounded-xl border bg-card">
          <p className="text-3xl font-bold text-red-600">{atRiskCount}</p>
          <p className="text-xs text-muted-foreground mt-1">At Risk</p>
        </div>
        <div className="text-center p-4 rounded-xl border bg-card">
          <p className="text-3xl font-bold text-amber-600">{(data.avg_churn_risk * 100).toFixed(0)}%</p>
          <p className="text-xs text-muted-foreground mt-1">Avg Churn Risk</p>
        </div>
        <div className="text-center p-4 rounded-xl border bg-card">
          <p className="text-3xl font-bold text-emerald-600">{data.segments.champion || 0}</p>
          <p className="text-xs text-muted-foreground mt-1">Champions</p>
        </div>
      </div>

      {/* Segment Distribution */}
      <div className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          User Segments (RFM)
        </h3>
        <p className="text-xs text-muted-foreground mb-4">
          RFM (Recency, Frequency, Monetary) segments users by engagement. <strong>Recency</strong>: days since last use. <strong>Frequency</strong>: runs in last 30 days. <strong>Monetary</strong>: subscription tier. Click a segment to see accounts.
        </p>
        <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
          {Object.entries(data.segments)
            .sort((a, b) => b[1] - a[1])
            .map(([segment, count]) => {
              const config = SEGMENT_CONFIG[segment] || SEGMENT_CONFIG.unknown;
              return (
                <button
                  key={segment}
                  onClick={() => { setSelectedSegment(segment); setSegmentPage(1); }}
                  className="p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className={cn('w-2 h-2 rounded-full', config.color)} />
                    <span className="text-2xl font-bold">{count}</span>
                  </div>
                  <p className="text-xs font-medium">{config.label}</p>
                  <p className="text-xs text-muted-foreground">{config.criteria}</p>
                </button>
              );
            })}
        </div>
      </div>

      {/* At Risk Accounts List */}
      <div className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-red-500" />
          Accounts at Risk
          <Badge variant="secondary">{data.at_risk_accounts.length}</Badge>
        </h3>
        <p className="text-xs text-muted-foreground mb-4">
          Accounts with 50%+ churn risk based on declining activity. RFM score format: Recency-Frequency-Monetary (each 1-5, higher = better).
        </p>

        {data.at_risk_accounts.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Smile className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
            <p>No at-risk accounts found</p>
          </div>
        ) : (
          <div className="space-y-3">
            {data.at_risk_accounts.map((account) => {
              const config = SEGMENT_CONFIG[account.segment] || SEGMENT_CONFIG.unknown;
              return (
                <div key={account.account_id} className="flex items-center justify-between p-3 rounded-lg border bg-muted/20 hover:bg-muted/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm', config.color)}>
                      {account.rfm_score.split('-')[0]}
                    </div>
                    <div>
                      <p className="font-medium text-sm">
                        {account.user_email && onUserClick ? (
                          <UserEmailLink email={account.user_email} onUserClick={onUserClick} />
                        ) : account.user_email ? (
                          account.user_email
                        ) : (
                          account.account_id.slice(0, 8)
                        )}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-xs">{config.label}</Badge>
                        <span>RFM: {account.rfm_score}</span>
                        <span>{account.days_since_last_activity}d ago</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cn(
                      'text-lg font-bold px-2 py-1 rounded',
                      account.churn_risk >= 0.7 ? 'bg-red-500/10 text-red-700' :
                      account.churn_risk >= 0.5 ? 'bg-amber-500/10 text-amber-700' :
                      'bg-gray-500/10 text-gray-700'
                    )}>
                      {(account.churn_risk * 100).toFixed(0)}%
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{account.runs_in_period} runs</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Drill-down list component with first message preview
interface DrillDownListProps {
  data: ConversationAnalyticsItem[];
  loading: boolean;
  pagination?: {
    total_items: number;
    total_pages: number;
    has_next: boolean;
    has_previous: boolean;
  };
  page: number;
  onPageChange: (page: number) => void;
  drillDownType: 'sentiment' | 'intent' | 'category';
  onUserClick?: (email: string) => void;
}

function DrillDownList({
  data,
  loading,
  pagination,
  page,
  onPageChange,
  drillDownType,
  onUserClick,
}: DrillDownListProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Brain className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No conversations found</p>
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
                {/* Header row */}
                <div className="flex items-center gap-2 mb-2">
                  <SentimentIcon label={item.sentiment_label} />
                  <span className="text-sm font-medium truncate">
                    {item.user_email && onUserClick ? (
                      <UserEmailLink email={item.user_email} onUserClick={onUserClick} />
                    ) : item.user_email ? (
                      item.user_email
                    ) : (
                      'Unknown user'
                    )}
                  </span>
                  {item.intent_type && (
                    <Badge variant="outline" className="text-xs capitalize">
                      {item.intent_type.replace('_', ' ')}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {item.user_message_count} messages
                  </span>
                </div>

                {/* User messages from this conversation */}
                {item.first_user_message && (
                  <div className="mt-2">
                    <p className="text-xs text-muted-foreground mb-1">User said:</p>
                    <p className="text-sm bg-muted/30 p-2 rounded line-clamp-3 overflow-auto">
                      {item.first_user_message}
                    </p>
                  </div>
                )}

                {/* Use case summary */}
                {item.use_case_category && (
                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground mb-1">Use case:</p>
                    <Badge variant="secondary" className="text-xs">
                      {item.use_case_category}
                    </Badge>
                  </div>
                )}

                {/* Frustration signals if any */}
                {item.frustration_signals && item.frustration_signals.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground mb-1">Why flagged:</p>
                    <div className="flex flex-wrap gap-1.5">
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
                  </div>
                )}

                {/* Feature request text */}
                {item.is_feature_request && item.feature_request_text && (
                  <p className="text-sm text-purple-700 mt-2 italic">
                    Feature: {item.feature_request_text}
                  </p>
                )}
              </div>

              <div className="flex flex-col items-end gap-2">
                {/* Frustration score */}
                {item.frustration_score != null && item.frustration_score > 0 && (
                  <div className={cn(
                    'text-sm font-bold px-2 py-1 rounded',
                    item.frustration_score >= 0.7 ? 'bg-red-500/10 text-red-700' :
                    item.frustration_score >= 0.5 ? 'bg-amber-500/10 text-amber-700' :
                    'bg-gray-500/10 text-gray-700'
                  )}>
                    {(item.frustration_score * 100).toFixed(0)}% frustrated
                  </div>
                )}

                <a
                  href={`/share/${item.thread_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline flex items-center gap-1"
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

// Conversation list component
interface ConversationListProps {
  data: Array<{
    id: string;
    thread_id: string;
    user_email?: string | null;
    sentiment_label?: string | null;
    frustration_score?: number | null;
    frustration_signals: string[];
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
  highlightField: 'frustration' | 'feature';
  onUserClick?: (email: string) => void;
}

function ConversationList({
  data,
  loading,
  pagination,
  page,
  onPageChange,
  emptyMessage,
  highlightField,
  onUserClick,
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
                    {item.user_email && onUserClick ? (
                      <UserEmailLink email={item.user_email} onUserClick={onUserClick} />
                    ) : item.user_email ? (
                      item.user_email
                    ) : (
                      'Unknown user'
                    )}
                  </span>
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

                <a
                  href={`/share/${item.thread_id}`}
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
