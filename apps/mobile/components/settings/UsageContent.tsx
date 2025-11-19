import * as React from 'react';
import { View, ScrollView, ActivityIndicator, useColorScheme, Pressable } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  AlertCircle,
  BarChart3,
  Calendar,
  MessageSquare,
  Sparkles,
  Activity,
  Plus,
  ArrowUpRight
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useThreadUsage, useSubscription } from '@/lib/billing';
import { formatCredits } from '@/lib/utils/credit-formatter';

interface UsageContentProps {
  onThreadPress?: (threadId: string, projectId: string | null) => void;
  onUpgradePress?: () => void;
  onTopUpPress?: () => void;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateShort(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function UsageContent({ onThreadPress, onUpgradePress, onTopUpPress }: UsageContentProps) {
  const { t } = useLanguage();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { data: subscriptionData } = useSubscription();

  const [dateRange] = React.useState({
    from: new Date(new Date().setDate(new Date().getDate() - 29)),
    to: new Date(),
  });

  const { data, isLoading, error, refetch } = useThreadUsage({
    limit: 50,
    offset: 0,
    startDate: dateRange.from,
    endDate: dateRange.to,
  });

  const handleThreadPress = React.useCallback((threadId: string, projectId: string | null) => {
    console.log('🎯 Thread pressed:', threadId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onThreadPress?.(threadId, projectId);
  }, [onThreadPress]);

  const handleUpgradePress = React.useCallback(() => {
    console.log('🎯 Upgrade pressed from usage');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onUpgradePress?.();
  }, [onUpgradePress]);

  const handleTopUpPress = React.useCallback(() => {
    console.log('🎯 Top up pressed from usage');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onTopUpPress?.();
  }, [onTopUpPress]);

  const currentTier = subscriptionData?.tier?.name || subscriptionData?.tier_key || 'free';
  const isFreeTier = currentTier === 'free' || !subscriptionData;
  const isUltraTier = subscriptionData?.tier_key === 'tier_25_200' || currentTier === 'Ultra';

  const threadRecords = data?.thread_usage || [];
  const summary = data?.summary;

  const totalConversations = threadRecords.length;
  const averagePerConversation = totalConversations > 0 && summary?.total_credits_used
    ? summary.total_credits_used / totalConversations
    : 0;

  if (isLoading) {
    return (
      <View className="py-12 items-center justify-center">
        <ActivityIndicator size="large" />
        <Text className="mt-4 text-sm text-muted-foreground">
          {t('usage.loadingUsageData')}
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4 flex-row items-start gap-2">
        <Icon as={AlertCircle} size={16} className="text-destructive" strokeWidth={2} />
        <Text className="text-sm font-roobert-medium text-destructive flex-1">
          {error instanceof Error ? error.message : t('usage.failedToLoad')}
        </Text>
      </View>
    );
  }

  if (!summary) {
    return null;
  }

  return (
    <View className="px-6 pb-8">
      <View className="mb-8 items-center">
        <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Icon as={Activity} size={28} className="text-primary" strokeWidth={2} />
        </View>
        <Text className="mb-1 text-5xl font-roobert-semibold text-foreground tracking-tight">
          {formatCredits(summary.total_credits_used)}
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground">
          {t('usage.totalCreditsUsed')}
        </Text>
        <Text className="text-xs font-roobert text-muted-foreground mt-1">
          {formatDateShort(summary.start_date)} - {formatDateShort(summary.end_date)}
        </Text>

        {isFreeTier ? (
          <Pressable
            onPress={handleUpgradePress}
            className="mt-4 bg-primary rounded-full px-6 py-2.5 active:opacity-80"
          >
            <Text className="text-sm font-roobert-semibold text-primary-foreground">
              {t('usage.upgradeYourPlan')}
            </Text>
          </Pressable>
        ) : isUltraTier ? (
          <Pressable
            onPress={handleTopUpPress}
            className="mt-4 bg-primary rounded-full px-6 py-2.5 active:opacity-80"
          >
            <Text className="text-sm font-roobert-semibold text-primary-foreground">
              {t('usage.topUp')}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleUpgradePress}
            className="mt-4 bg-primary rounded-full px-6 py-2.5 active:opacity-80"
          >
            <Text className="text-sm font-roobert-semibold text-primary-foreground">
              {t('usage.upgrade')}
            </Text>
          </Pressable>
        )}
      </View>

      <UsageGraph
        threadRecords={threadRecords}
        isDark={isDark}
        t={t}
      />

      <View className="mb-6">
        <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
          {t('usage.usageStats')}
        </Text>
        <View className="flex-row gap-3">
          <View className="flex-1 bg-primary/5 rounded-3xl p-5">
            <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-primary">
              <Icon as={MessageSquare} size={18} className="text-primary-foreground" strokeWidth={2.5} />
            </View>
            <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
              {totalConversations}
            </Text>
            <Text className="text-xs font-roobert-medium text-muted-foreground">
              {t('usage.conversations')}
            </Text>
          </View>
          <View className="flex-1 bg-primary/5 rounded-3xl p-5">
            <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-primary">
              <Icon as={Sparkles} size={18} className="text-primary-foreground" strokeWidth={2.5} />
            </View>
            <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
              {formatCredits(averagePerConversation)}
            </Text>
            <Text className="text-xs font-roobert-medium text-muted-foreground">
              {t('usage.avgPerChat')}
            </Text>
          </View>
        </View>
      </View>

      <View className="mb-3">
        <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
          {t('usage.conversationBreakdown')}
        </Text>
      </View>

      {threadRecords.length === 0 ? (
        <View className="py-16 items-center">
          <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-muted/20">
            <Icon as={MessageSquare} size={28} className="text-muted-foreground" strokeWidth={2} />
          </View>
          <Text className="text-sm font-roobert-medium text-foreground mb-1">
            {t('usage.noConversationsYet')}
          </Text>
          <Text className="text-xs text-muted-foreground text-center">
            {t('usage.conversationHistoryAppearHere')}
          </Text>
        </View>
      ) : (
        <View className="rounded-3xl overflow-hidden">
          {threadRecords.map((record, index) => (
            <ConversationCard
              key={record.thread_id}
              record={record}
              isLast={index === threadRecords.length - 1}
              onPress={() => handleThreadPress(record.thread_id, record.project_id)}
              t={t}
            />
          ))}
        </View>
      )}

      {data?.pagination && data.pagination.total > 50 && (
        <View className="mt-6 bg-muted/20 rounded-2xl p-4">
          <Text className="text-xs font-roobert text-muted-foreground text-center">
            {t('usage.showingTopOf', { shown: 50, total: data.pagination.total })}
          </Text>
        </View>
      )}
    </View>
  );
}

interface ConversationCardProps {
  record: any;
  isLast: boolean;
  onPress: () => void;
  t: (key: string, options?: any) => string;
}

function ConversationCard({ record, isLast, onPress, t }: ConversationCardProps) {
  return (
    <Pressable
      onPress={onPress}
      className={`bg-card border border-border/40 rounded-2xl p-5 mb-3 active:opacity-80`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-1 pr-4">
          <View className="flex-row items-center gap-2 mb-2">
            <View className="h-8 w-8 items-center justify-center rounded-full bg-primary/10">
              <Icon as={MessageSquare} size={14} className="text-primary" strokeWidth={2.5} />
            </View>
            <Text className="flex-1 text-base font-roobert-semibold text-foreground" numberOfLines={1}>
              {record.project_name}
            </Text>
          </View>
          <View className="flex-row items-center gap-2 ml-10">
            <Icon as={Calendar} size={12} className="text-muted-foreground" strokeWidth={2} />
            <Text className="text-xs font-roobert text-muted-foreground">
              {formatDate(record.last_used)}
            </Text>
          </View>
        </View>
        <View className="items-end">
          <View className="mb-1 bg-primary/10 rounded-full px-3 py-1.5">
            <Text className="text-sm font-roobert-semibold text-primary">
              {formatCredits(record.credits_used)}
            </Text>
          </View>
          <Text className="text-[10px] font-roobert text-muted-foreground">
            {t('usage.credits')}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

interface UsageGraphProps {
  threadRecords: any[];
  isDark: boolean;
  t: (key: string, options?: any) => string;
}

function UsageGraph({ threadRecords, isDark, t }: UsageGraphProps) {
  const graphData = React.useMemo(() => {
    if (!threadRecords || threadRecords.length === 0) {
      return Array(20).fill(0).map((_, i) => Math.random() * 30 + 20);
    }

    const last20 = threadRecords.slice(0, 20).reverse();
    const maxCredits = Math.max(...last20.map(r => r.credits_used), 1);
    return last20.map(r => (r.credits_used / maxCredits) * 80 + 20);
  }, [threadRecords]);

  const width = 280;
  const height = 80;

  const points = graphData.map((value, index) => {
    // Validate and clamp values to prevent NaN
    const safeValue = typeof value === 'number' && !isNaN(value) && isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : 0;
    const safeIndex = typeof index === 'number' && !isNaN(index) ? index : 0;
    const safeLength = graphData.length > 1 ? graphData.length - 1 : 1;

    const x = (safeIndex / safeLength) * width;
    const y = height - (safeValue / 100) * height;

    // Ensure x and y are valid numbers
    return {
      x: isFinite(x) ? x : 0,
      y: isFinite(y) ? y : height
    };
  });

  const pathData = points.map((point, index) => {
    if (index === 0) {
      return `M ${point.x} ${point.y}`;
    }
    const prevPoint = points[index - 1];
    const controlX = (prevPoint.x + point.x) / 2;
    // Validate all values before using in path
    const safeControlX = isFinite(controlX) ? controlX : point.x;
    const safePrevY = isFinite(prevPoint.y) ? prevPoint.y : point.y;
    return `Q ${safeControlX} ${safePrevY}, ${point.x} ${point.y}`;
  }).join(' ');

  const strokeColor = isDark ? '#ffffff' : '#000000';

  return (
    <View className="mb-6">
      <View className="rounded-3xl p-5 overflow-hidden">
        <View className="absolute inset-0 bg-primary/5 rounded-3xl" />
        <View className="relative">
          <View className="flex-row items-start justify-between">
            <View className="h-8 w-8 items-center justify-center rounded-full bg-foreground">
              <Icon as={BarChart3} size={20} className="text-background" strokeWidth={2.5} />
            </View>
            <View className="absolute right-0 top-0">
              <Svg width={180} height={60} viewBox={`0 0 ${width} ${height}`}>
                <Path
                  d={pathData}
                  stroke={strokeColor}
                  strokeWidth="2.5"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </View>
          </View>

          <View className="mt-4">
            <Text className="text-sm font-roobert text-muted-foreground mb-1">
              {t('usage.usageTrend')}
            </Text>
            <Text className="text-lg font-roobert-medium text-muted-foreground">
              {t('usage.lastConversations', { count: Math.min(threadRecords.length, 20) })}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

