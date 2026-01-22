import * as React from 'react';
import { View, ActivityIndicator, Platform, Animated } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { useThreadUsage } from '@/lib/billing';
import { useBillingContext } from '@/contexts/BillingContext';
import { type DateRange } from '@/components/billing/DateRangePicker';
import { UsageSummaryCard } from './UsageSummaryCard';
import { UsageStatsCards } from './UsageStatsCards';
import { DateRangeSelector } from './DateRangeSelector';
import { ViewUsageDataButton } from './ViewUsageDataButton';
import { UsageDataSheet } from './UsageDataSheet';
import { log } from '@/lib/logger';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { formatDateRange } from './usage-utils';

interface UsageContentProps {
  onThreadPress?: (threadId: string, projectId: string | null) => void;
  onUpgradePress?: () => void;
}

export function UsageContent({ onThreadPress, onUpgradePress }: UsageContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { subscriptionData, hasFreeTier } = useBillingContext();
  const isIOS = Platform.OS === 'ios';
  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  // Thread Usage State
  const [threadOffset, setThreadOffset] = React.useState(0);
  const [selectedPresetLabel, setSelectedPresetLabel] = React.useState<string>(t('usage.last30Days', 'Last 30 days'));
  const [dateRange, setDateRange] = React.useState<DateRange>({
    from: new Date(new Date().setDate(new Date().getDate() - 29)),
    to: new Date(),
  });
  const [isUsageDataSheetVisible, setIsUsageDataSheetVisible] = React.useState(false);
  const [isManualRefresh, setIsManualRefresh] = React.useState(false);
  const threadLimit = 50;

  const {
    data: threadData,
    isLoading: isLoadingThreads,
    error: threadError,
    refetch,
    isFetching,
  } = useThreadUsage({
    limit: threadLimit,
    offset: threadOffset,
    startDate: dateRange.from || undefined,
    endDate: dateRange.to || undefined,
  });

  // Fade in animation when data loads
  React.useEffect(() => {
    if (threadData && !isLoadingThreads) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [threadData, isLoadingThreads, fadeAnim]);

  const datePresets = React.useMemo(() => {
    const now = new Date();
    return [
      {
        label: t('usage.today', 'Today'),
        getRange: () => {
          const from = new Date(now);
          from.setHours(0, 0, 0, 0);
          const to = new Date(now);
          to.setHours(23, 59, 59, 999);
          return { from, to };
        },
      },
      {
        label: t('usage.yesterday', 'Yesterday'),
        getRange: () => {
          const from = new Date(now);
          from.setDate(from.getDate() - 1);
          from.setHours(0, 0, 0, 0);
          const to = new Date(now);
          to.setDate(to.getDate() - 1);
          to.setHours(23, 59, 59, 999);
          return { from, to };
        },
      },
      {
        label: t('usage.last7Days', 'Last 7 days'),
        getRange: () => {
          const to = new Date(now);
          to.setHours(23, 59, 59, 999);
          const from = new Date(now);
          from.setDate(from.getDate() - 6);
          from.setHours(0, 0, 0, 0);
          return { from, to };
        },
      },
      {
        label: t('usage.last30Days', 'Last 30 days'),
        getRange: () => {
          const to = new Date(now);
          to.setHours(23, 59, 59, 999);
          const from = new Date(now);
          from.setDate(from.getDate() - 29);
          from.setHours(0, 0, 0, 0);
          return { from, to };
        },
      },
      {
        label: t('usage.thisMonth', 'This Month'),
        getRange: () => {
          const from = new Date(now.getFullYear(), now.getMonth(), 1);
          from.setHours(0, 0, 0, 0);
          const to = new Date(now);
          to.setHours(23, 59, 59, 999);
          return { from, to };
        },
      },
      {
        label: t('usage.lastMonth', 'Last Month'),
        getRange: () => {
          const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          from.setHours(0, 0, 0, 0);
          const to = new Date(now.getFullYear(), now.getMonth(), 0);
          to.setHours(23, 59, 59, 999);
          return { from, to };
        },
      },
    ];
  }, [t]);

  const handleDateRangeChange = React.useCallback((range: DateRange) => {
    setDateRange(range);
    setThreadOffset(0);
    
    // Find matching preset label
    for (const preset of datePresets) {
      const presetRange = preset.getRange();
      if (
        range.from?.toDateString() === presetRange.from?.toDateString() &&
        range.to?.toDateString() === presetRange.to?.toDateString()
      ) {
        setSelectedPresetLabel(preset.label);
        return;
      }
    }
    setSelectedPresetLabel(formatDateRange(range.from, range.to, t));
  }, [datePresets, t]);

  const handleRefresh = React.useCallback(async () => {
    log.log('🔄 Manual refresh triggered');
    setIsManualRefresh(true);
    try {
      await refetch();
    } finally {
      setTimeout(() => setIsManualRefresh(false), 500);
    }
  }, [refetch]);

  const handleOpenUsageData = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsUsageDataSheetVisible(true);
  }, []);

  const handleCloseUsageData = React.useCallback(() => {
    setIsUsageDataSheetVisible(false);
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
  const threadSummary = threadData?.summary || null;

  const currentTier = subscriptionData?.tier?.name || subscriptionData?.tier_key || 'free';
  const isUltraTier = subscriptionData?.tier_key === 'tier_25_200' || currentTier === 'Ultra';

  const totalConversations = threadRecords.length;
  const averagePerConversation =
    totalConversations > 0 && threadSummary?.total_credits_used
      ? threadSummary.total_credits_used / totalConversations
      : 0;

  // Determine sync state
  const isSyncing = isFetching && !isLoadingThreads && !isManualRefresh;
  const isInitialLoad = isLoadingThreads && threadOffset === 0 && !threadData;

  // Format date range for display
  const dateRangeLabel = selectedPresetLabel;

  // Show skeleton loader only on very first load
  if (isInitialLoad) {
    return (
      <View style={{ padding: 16, width: '100%' }}>
        <UsageSummaryCard
          threadSummary={null}
          hasFreeTier={hasFreeTier}
          isUltraTier={isUltraTier}
          isLoading={true}
          dateRangeLabel={dateRangeLabel}
        />
        <UsageStatsCards
          totalConversations={0}
          averagePerConversation={0}
          isLoading={true}
        />
        <View style={{ alignItems: 'center', paddingVertical: 24 }}>
          <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#F8F8F8' : '#121215'} />
          <Text className="mt-3 text-sm text-muted-foreground font-roobert">
            {t('usage.loadingUsageData', 'Loading usage data...')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <Animated.View style={{ padding: 16, width: '100%', opacity: fadeAnim }}>
      <UsageSummaryCard
        threadSummary={threadSummary}
        hasFreeTier={hasFreeTier}
        isUltraTier={isUltraTier}
        isLoading={isLoadingThreads}
        isSyncing={isSyncing || isManualRefresh}
        onUpgradePress={onUpgradePress}
        onRefresh={handleRefresh}
        dateRangeLabel={dateRangeLabel}
      />

      <UsageStatsCards
        totalConversations={totalConversations}
        averagePerConversation={averagePerConversation}
        isLoading={isLoadingThreads && !threadData}
      />

      <DateRangeSelector
        dateRange={dateRange}
        datePresets={datePresets}
        onDateRangeChange={handleDateRangeChange}
        selectedPresetLabel={selectedPresetLabel}
      />

      <ViewUsageDataButton
        threadCount={threadRecords.length}
        onPress={handleOpenUsageData}
        isLoading={isLoadingThreads && !threadData}
      />

      <UsageDataSheet
        visible={isUsageDataSheetVisible}
        onClose={handleCloseUsageData}
        threadRecords={threadRecords}
        dateRange={dateRange}
        threadOffset={threadOffset}
        threadLimit={threadLimit}
        pagination={threadData?.pagination}
        isLoading={isLoadingThreads}
        error={threadError}
        onThreadPress={handleThreadPress}
        onPrevPage={handlePrevThreadPage}
        onNextPage={handleNextThreadPage}
      />
    </Animated.View>
  );
}
