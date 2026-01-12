/**
 * Usage Content Component
 *
 * Mobile-optimized UX/UI:
 * - Thread Usage with summary and filter
 * - Usage stats (conversations and average per chat)
 * - Mobile-friendly cards and visual elements
 */

import * as React from 'react';
import { View, ActivityIndicator, Pressable } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AlertCircle, MessageSquare, Activity, Sparkles } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useThreadUsage } from '@/lib/billing';
import { useBillingContext } from '@/contexts/BillingContext';
import { formatCredits } from '@agentpress/shared';
import { DateRangePicker, type DateRange } from '@/components/billing/DateRangePicker';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { log } from '@/lib/logger';

interface UsageContentProps {
  onThreadPress?: (threadId: string, projectId: string | null) => void;
  onUpgradePress?: () => void;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // If today, show time only
  if (diffDays === 0) {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // If yesterday
  if (diffDays === 1) {
    return 'Yesterday';
  }

  // If within last 7 days, show day name
  if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }

  // Otherwise show short date
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function formatDateShort(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function formatSingleDate(date: Date, formatStr: string): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();

  if (formatStr === 'MMM dd, yyyy') {
    return `${month} ${day}, ${year}`;
  }
  if (formatStr === 'MMM dd') {
    return `${month} ${day}`;
  }
  return `${month} ${day}`;
}

export function UsageContent({ onThreadPress, onUpgradePress }: UsageContentProps) {
  const { t } = useLanguage();
  const { subscriptionData, hasFreeTier } = useBillingContext();
  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();

  // Thread Usage State
  const [threadOffset, setThreadOffset] = React.useState(0);
  const [dateRange, setDateRange] = React.useState<DateRange>({
    from: new Date(new Date().setDate(new Date().getDate() - 29)),
    to: new Date(),
  });
  const threadLimit = 50;

  const {
    data: threadData,
    isLoading: isLoadingThreads,
    error: threadError,
  } = useThreadUsage({
    limit: threadLimit,
    offset: threadOffset,
    startDate: dateRange.from || undefined,
    endDate: dateRange.to || undefined,
  });

  const handleDateRangeUpdate = React.useCallback((values: { range: DateRange }) => {
    setDateRange(values.range);
    setThreadOffset(0); // Reset pagination when date range changes
  }, []);

  const handleThreadPress = React.useCallback(
    (threadId: string, projectId: string | null) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onThreadPress?.(threadId, projectId);
    },
    [onThreadPress]
  );

  const handlePrevThreadPage = React.useCallback(() => {
    if (threadOffset > 0 && !isLoadingThreads) {
      const newOffset = Math.max(0, threadOffset - threadLimit);
      log.log('📄 Previous page:', { from: threadOffset, to: newOffset });
      setThreadOffset(newOffset);
    }
  }, [threadOffset, threadLimit, isLoadingThreads]);

  const handleNextThreadPage = React.useCallback(() => {
    if (threadData?.pagination.has_more && !isLoadingThreads) {
      const newOffset = threadOffset + threadLimit;
      log.log('📄 Next page:', { from: threadOffset, to: newOffset });
      setThreadOffset(newOffset);
    }
  }, [threadData?.pagination.has_more, threadOffset, threadLimit, isLoadingThreads]);

  const threadRecords = threadData?.thread_usage || [];
  const threadSummary = threadData?.summary;

  const currentTier = subscriptionData?.tier?.name || subscriptionData?.tier_key || 'free';
  const isUltraTier = subscriptionData?.tier_key === 'tier_25_200' || currentTier === 'Ultra';

  const totalConversations = threadRecords.length;
  const averagePerConversation =
    totalConversations > 0 && threadSummary?.total_credits_used
      ? threadSummary.total_credits_used / totalConversations
      : 0;

  // Show skeleton loader on initial load
  const showThreadSkeleton = isLoadingThreads && threadOffset === 0;

  if (showThreadSkeleton) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator size="large" />
        <Text className="mt-4 text-sm text-muted-foreground">
          {t('usage.loadingUsageData', 'Loading usage data...')}
        </Text>
      </View>
    );
  }

  return (
    <View className="px-6 pb-8">
      {/* Mobile-Friendly Summary Card */}
      {threadSummary && (
        <View className="mb-8 items-center">
          <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Icon as={Activity} size={28} className="text-primary" strokeWidth={2} />
          </View>
          <Text className="mb-1 font-roobert-semibold text-5xl tracking-tight text-foreground">
            {formatCredits(threadSummary.total_credits_used)}
          </Text>
          <Text className="font-roobert text-sm text-muted-foreground">
            {t('usage.totalCreditsUsed', 'Total Credits Used')}
          </Text>
          {threadSummary.start_date && threadSummary.end_date && (
            <Text className="mt-1 font-roobert text-xs text-muted-foreground">
              {formatDateShort(threadSummary.start_date)} -{' '}
              {formatDateShort(threadSummary.end_date)}
            </Text>
          )}

          {hasFreeTier ? (
            <Pressable
              onPress={onUpgradePress}
              className="mt-4 rounded-full bg-primary px-6 py-2.5 active:opacity-80">
              <Text className="font-roobert-semibold text-sm text-primary-foreground">
                {t('usage.upgradeYourPlan', 'Upgrade Your Plan')}
              </Text>
            </Pressable>
          ) : isUltraTier ? (
            <Pressable
              onPress={async () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                // Use RevenueCat paywall for top-ups
                if (useNativePaywall) {
                  log.log('📱 Using RevenueCat paywall for top-ups');
                  await presentUpgradePaywall();
                } else {
                  // Fallback to upgrade press if RevenueCat not available
                  onUpgradePress?.();
                }
              }}
              className="mt-4 rounded-full bg-primary px-6 py-2.5 active:opacity-80">
              <Text className="font-roobert-semibold text-sm text-primary-foreground">
                {t('usage.topUp', 'Top Up')}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={onUpgradePress}
              className="mt-4 rounded-full bg-primary px-6 py-2.5 active:opacity-80">
              <Text className="font-roobert-semibold text-sm text-primary-foreground">
                {t('usage.upgrade', 'Upgrade')}
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Mobile Stats Cards */}
      {threadSummary && (
        <View className="mb-6">
          <Text className="mb-3 font-roobert-medium text-xs uppercase tracking-wider text-muted-foreground">
            {t('usage.usageStats', 'Usage Stats')}
          </Text>
          <View className="flex-row gap-3">
            <View className="flex-1 rounded-3xl bg-primary/5 p-5">
              <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-primary">
                <Icon
                  as={MessageSquare}
                  size={18}
                  className="text-primary-foreground"
                  strokeWidth={2.5}
                />
              </View>
              <Text className="mb-1 font-roobert-semibold text-2xl text-foreground">
                {totalConversations}
              </Text>
              <Text className="font-roobert-medium text-xs text-muted-foreground">
                {t('usage.conversations', 'Conversations')}
              </Text>
            </View>
            <View className="flex-1 rounded-3xl bg-primary/5 p-5">
              <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-primary">
                <Icon
                  as={Sparkles}
                  size={18}
                  className="text-primary-foreground"
                  strokeWidth={2.5}
                />
              </View>
              <Text className="mb-1 font-roobert-semibold text-2xl text-foreground">
                {formatCredits(averagePerConversation)}
              </Text>
              <Text className="font-roobert-medium text-xs text-muted-foreground">
                {t('usage.avgPerChat', 'Avg per Chat')}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* Thread Usage Section */}
      <View className="mb-8">
        <View className="mb-4 flex-row items-center justify-between">
          <View className="flex-1">
            <Text className="mb-1 font-roobert-semibold text-lg text-foreground">
              {t('usage.usage', 'Usage')}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {t('usage.creditConsumptionPerConversation', 'Credit consumption per conversation')}
            </Text>
          </View>
          {/* Date Range Picker */}
          <DateRangePicker
            initialDateFrom={dateRange.from || undefined}
            initialDateTo={dateRange.to || undefined}
            onUpdate={handleDateRangeUpdate}
            t={t}
          />
        </View>

        {showThreadSkeleton ? (
          <View className="gap-2">
            {[...Array(5)].map((_, i) => (
              <View key={i} className="h-16 rounded-xl bg-muted/20" />
            ))}
          </View>
        ) : threadError ? (
          <View className="rounded-[18px] border border-destructive/20 bg-destructive/10 p-4">
            <View className="flex-row items-start gap-2">
              <Icon as={AlertCircle} size={16} className="text-destructive" strokeWidth={2} />
              <Text className="flex-1 font-roobert-medium text-sm text-destructive">
                {threadError instanceof Error
                  ? threadError.message
                  : t('usage.failedToLoad', 'Failed to load thread usage')}
              </Text>
            </View>
          </View>
        ) : threadRecords.length === 0 ? (
          <View className="items-center py-8">
            <Text className="text-center text-sm text-muted-foreground">
              {dateRange.from && dateRange.to
                ? `No thread usage found between ${formatSingleDate(dateRange.from, 'MMM dd, yyyy')} and ${formatSingleDate(dateRange.to, 'MMM dd, yyyy')}.`
                : t('usage.noThreadUsageFoundSimple', 'No thread usage found.')}
            </Text>
          </View>
        ) : (
          <>
            {/* Mobile-Friendly Table Format */}
            <View className="mb-4 overflow-hidden rounded-2xl border border-border bg-card">
              {/* Table Header */}
              <View className="flex-row border-b border-border/50 bg-muted/50 px-4 py-3">
                <View className="flex-1">
                  <Text className="font-roobert-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    {t('usage.thread', 'Thread')}
                  </Text>
                </View>
                <View className="w-[90px] items-end">
                  <Text className="font-roobert-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    {t('usage.creditsUsed', 'Credits')}
                  </Text>
                </View>
                <View className="ml-2 w-[80px] items-end">
                  <Text className="font-roobert-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    {t('usage.lastUsed', 'Used')}
                  </Text>
                </View>
              </View>

              {/* Table Rows */}
              <View>
                {threadRecords.map((record, index) => (
                  <Pressable
                    key={record.thread_id}
                    onPress={() => {
                      log.log('🎯 Thread row pressed:', record.thread_id);
                      handleThreadPress(record.thread_id, record.project_id);
                    }}
                    className={`flex-row items-center border-b border-border/30 px-4 py-3 ${
                      index === threadRecords.length - 1 ? 'border-b-0' : ''
                    } active:bg-muted/30`}>
                    <View className="flex-1 pr-3">
                      <Text
                        className="font-roobert-semibold text-base text-foreground"
                        numberOfLines={1}>
                        {record.project_name}
                      </Text>
                    </View>
                    <View className="w-[90px] items-end">
                      <Text className="font-roobert-semibold text-sm text-foreground">
                        {formatCredits(record.credits_used)}
                      </Text>
                    </View>
                    <View className="ml-2 w-[80px] items-end">
                      <Text
                        className="font-roobert text-xs text-muted-foreground"
                        numberOfLines={1}>
                        {formatDate(record.last_used)}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Thread Pagination */}
            {threadData?.pagination && (
              <View className="flex-row items-center justify-between">
                <Text className="text-xs text-muted-foreground">
                  {`Showing ${threadOffset + 1}-${Math.min(threadOffset + threadLimit, threadData.pagination.total)} of ${threadData.pagination.total} threads`}
                </Text>
                <View className="flex-row gap-2">
                  <Pressable
                    onPress={handlePrevThreadPage}
                    disabled={threadOffset === 0 || isLoadingThreads}
                    className={`rounded-xl border px-4 py-2 ${
                      threadOffset === 0 || isLoadingThreads
                        ? 'border-border/30 bg-muted/20 opacity-50'
                        : 'border-border bg-card active:opacity-80'
                    }`}>
                    <Text
                      className={`font-roobert-medium text-xs ${
                        threadOffset === 0 || isLoadingThreads
                          ? 'text-muted-foreground'
                          : 'text-foreground'
                      }`}>
                      {t('common.previous', 'Previous')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={handleNextThreadPage}
                    disabled={!threadData.pagination.has_more || isLoadingThreads}
                    className={`rounded-xl border px-4 py-2 ${
                      !threadData.pagination.has_more || isLoadingThreads
                        ? 'border-border/30 bg-muted/20 opacity-50'
                        : 'border-border bg-card active:opacity-80'
                    }`}>
                    <Text
                      className={`font-roobert-medium text-xs ${
                        !threadData.pagination.has_more || isLoadingThreads
                          ? 'text-muted-foreground'
                          : 'text-foreground'
                      }`}>
                      {t('common.next', 'Next')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}
