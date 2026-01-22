/**
 * Usage Content Component
 *
 * Mobile-optimized UX/UI:
 * - Thread Usage with summary and filter
 * - Usage stats (conversations and average per chat)
 * - Mobile-friendly cards and visual elements
 */

import * as React from 'react';
import { View, ActivityIndicator, Pressable, Platform, StyleSheet, ViewStyle, ScrollView } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AlertCircle, MessageSquare, Activity, Sparkles, Calendar, ChevronRight, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useThreadUsage } from '@/lib/billing';
import { useBillingContext } from '@/contexts/BillingContext';
import { formatCredits } from '@agentpress/shared';
import { type DateRange } from '@/components/billing/DateRangePicker';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { log } from '@/lib/logger';
import { useColorScheme } from 'nativewind';
import { isLiquidGlassAvailable, GlassView } from 'expo-glass-effect';
import { ReanimatedTrueSheet } from '@lodev09/react-native-true-sheet/reanimated';
import type { TrueSheet } from '@lodev09/react-native-true-sheet';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { getBorderRadius, getDrawerBackgroundColor } from '@agentpress/shared';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Only import ContextMenu on native platforms
let ContextMenu: React.ComponentType<any> | null = null;
if (Platform.OS !== 'web') {
  try {
    ContextMenu = require('react-native-context-menu-view').default;
  } catch (e) {
    log.warn('react-native-context-menu-view not available');
  }
}

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
  const { colorScheme } = useColorScheme();
  const { subscriptionData, hasFreeTier } = useBillingContext();
  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();
  const isIOS = Platform.OS === 'ios';
  
  const groupedBackgroundStyle = isIOS 
    ? { borderRadius: 20, overflow: 'hidden' }
    : { 
        backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF',
        borderRadius: 12,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
      };

  // Thread Usage State
  const [threadOffset, setThreadOffset] = React.useState(0);
  const [dateRange, setDateRange] = React.useState<DateRange>({
    from: new Date(new Date().setDate(new Date().getDate() - 29)),
    to: new Date(),
  });
  const [isUsageDataSheetVisible, setIsUsageDataSheetVisible] = React.useState(false);
  const [isDateMenuOpen, setIsDateMenuOpen] = React.useState(false);
  const threadLimit = 50;

  // TrueSheet and BottomSheet refs
  const trueSheetRef = React.useRef<TrueSheet>(null);
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const cornerRadius = getBorderRadius(Platform.OS, '2xl');
  const snapPoints = React.useMemo(() => ['90%'], []);

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

  // Date range presets
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

  const formatDateRange = React.useCallback((from: Date | null, to: Date | null): string => {
    if (!from || !to) return t('usage.selectPeriod', 'Select period');
    const formatDate = (date: Date) => date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return `${formatDate(from)} - ${formatDate(to)}`;
  }, [t]);

  const handleDatePresetSelect = React.useCallback((preset: typeof datePresets[0]) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const newRange = preset.getRange();
    handleDateRangeUpdate({ range: newRange });
    setIsDateMenuOpen(false);
  }, [handleDateRangeUpdate]);

  // Handle usage data sheet
  const wasSheetVisibleRef = React.useRef(false);
  React.useEffect(() => {
    // Only handle sheet visibility changes, not initial mount
    if (isUsageDataSheetVisible && !wasSheetVisibleRef.current) {
      // Opening the sheet
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (Platform.OS === 'ios') {
        trueSheetRef.current?.present();
      } else {
        bottomSheetRef.current?.present();
      }
      wasSheetVisibleRef.current = true;
    } else if (!isUsageDataSheetVisible && wasSheetVisibleRef.current) {
      // Closing the sheet
      if (Platform.OS === 'ios') {
        trueSheetRef.current?.dismiss();
      } else {
        bottomSheetRef.current?.dismiss();
      }
      wasSheetVisibleRef.current = false;
    }
  }, [isUsageDataSheetVisible]);

  const handleOpenUsageData = React.useCallback(() => {
    setIsUsageDataSheetVisible(true);
  }, []);

  const handleCloseUsageData = React.useCallback(() => {
    setIsUsageDataSheetVisible(false);
  }, []);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

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
    <View style={{ padding: 16, width: '100%' }}>
      {/* Summary Card with Liquid Glass */}
      {threadSummary && (
        <View 
          style={[
            groupedBackgroundStyle as ViewStyle,
            { 
              marginBottom: isIOS ? 20 : 16, 
              paddingTop: 32,
              paddingBottom: 28,
              paddingHorizontal: 24,
              alignItems: 'center',
              overflow: 'visible',
            }
          ]}
          className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
        >
          {isLiquidGlassAvailable() && isIOS ? (
            <GlassView
              glassEffectStyle="regular"
              tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20,
              }}
            >
              <Icon as={Activity} size={32} className="text-primary" strokeWidth={2} />
            </GlassView>
          ) : (
            <View style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.15)' : 'rgba(0, 122, 255, 0.1)',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
            }}>
              <Icon as={Activity} size={32} color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'} strokeWidth={2} />
            </View>
          )}
          
          <Text 
            style={{ 
              fontSize: 48,
              fontWeight: '700',
              letterSpacing: -1,
              marginBottom: 8,
              lineHeight: 56,
            }}
            className="text-foreground"
          >
            {formatCredits(threadSummary.total_credits_used)}
          </Text>
          <Text 
            style={{ 
              fontSize: 15,
              marginBottom: 6,
              lineHeight: 20,
            }}
            className="text-muted-foreground"
          >
            {t('usage.totalCreditsUsed', 'Total Credits Used')}
          </Text>
          {threadSummary.start_date && threadSummary.end_date && (
            <Text 
              style={{ 
                fontSize: 13,
                marginTop: 2,
                lineHeight: 18,
              }}
              className="text-muted-foreground"
            >
              {formatDateShort(threadSummary.start_date)} -{' '}
              {formatDateShort(threadSummary.end_date)}
            </Text>
          )}

          {/* Upgrade Button with Liquid Glass */}
          {hasFreeTier ? (
            <Pressable
              onPress={onUpgradePress}
              style={{ marginTop: 20 }}
            >
              {isLiquidGlassAvailable() && isIOS ? (
                <GlassView
                  glassEffectStyle="regular"
                  tintColor="rgba(0, 122, 255, 0.15)"
                  style={{
                    paddingHorizontal: 24,
                    paddingVertical: 12,
                    borderRadius: 20,
                    borderWidth: 0.5,
                    borderColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.3)' : 'rgba(0, 122, 255, 0.2)',
                  }}
                >
                  <Text 
                    style={{ 
                      fontSize: 15,
                      fontWeight: '600',
                      color: colorScheme === 'dark' ? '#0A84FF' : '#007AFF',
                    }}
                  >
                    {t('usage.upgradeYourPlan', 'Upgrade Your Plan')}
                  </Text>
                </GlassView>
              ) : (
                <View style={{
                  paddingHorizontal: 24,
                  paddingVertical: 12,
                  borderRadius: 20,
                  backgroundColor: colorScheme === 'dark' ? '#0A84FF' : '#007AFF',
                  ...(isIOS ? {} : {
                    elevation: 2,
                    shadowColor: '#007AFF',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.3,
                    shadowRadius: 4,
                  }),
                }}>
                  <Text 
                    style={{ 
                      fontSize: 15,
                      fontWeight: '600',
                      color: '#FFFFFF',
                    }}
                  >
                    {t('usage.upgradeYourPlan', 'Upgrade Your Plan')}
                  </Text>
                </View>
              )}
            </Pressable>
          ) : isUltraTier ? (
            <Pressable
              onPress={async () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                if (useNativePaywall) {
                  log.log('📱 Using RevenueCat paywall for top-ups');
                  await presentUpgradePaywall();
                } else {
                  onUpgradePress?.();
                }
              }}
              style={{ marginTop: 20 }}
            >
              {isLiquidGlassAvailable() && isIOS ? (
                <GlassView
                  glassEffectStyle="regular"
                  tintColor="rgba(0, 122, 255, 0.15)"
                  style={{
                    paddingHorizontal: 24,
                    paddingVertical: 12,
                    borderRadius: 20,
                    borderWidth: 0.5,
                    borderColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.3)' : 'rgba(0, 122, 255, 0.2)',
                  }}
                >
                  <Text 
                    style={{ 
                      fontSize: 15,
                      fontWeight: '600',
                      color: colorScheme === 'dark' ? '#0A84FF' : '#007AFF',
                    }}
                  >
                    {t('usage.topUp', 'Top Up')}
                  </Text>
                </GlassView>
              ) : (
                <View style={{
                  paddingHorizontal: 24,
                  paddingVertical: 12,
                  borderRadius: 20,
                  backgroundColor: colorScheme === 'dark' ? '#0A84FF' : '#007AFF',
                  ...(isIOS ? {} : {
                    elevation: 2,
                    shadowColor: '#007AFF',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.3,
                    shadowRadius: 4,
                  }),
                }}>
                  <Text 
                    style={{ 
                      fontSize: 15,
                      fontWeight: '600',
                      color: '#FFFFFF',
                    }}
                  >
                    {t('usage.topUp', 'Top Up')}
                  </Text>
                </View>
              )}
            </Pressable>
          ) : (
            <Pressable
              onPress={onUpgradePress}
              style={{ marginTop: 20 }}
            >
              {isLiquidGlassAvailable() && isIOS ? (
                <GlassView
                  glassEffectStyle="regular"
                  tintColor="rgba(0, 122, 255, 0.15)"
                  style={{
                    paddingHorizontal: 24,
                    paddingVertical: 12,
                    borderRadius: 20,
                    borderWidth: 0.5,
                    borderColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.3)' : 'rgba(0, 122, 255, 0.2)',
                  }}
                >
                  <Text 
                    style={{ 
                      fontSize: 15,
                      fontWeight: '600',
                      color: colorScheme === 'dark' ? '#0A84FF' : '#007AFF',
                    }}
                  >
                    {t('usage.upgrade', 'Upgrade')}
                  </Text>
                </GlassView>
              ) : (
                <View style={{
                  paddingHorizontal: 24,
                  paddingVertical: 12,
                  borderRadius: 20,
                  backgroundColor: colorScheme === 'dark' ? '#0A84FF' : '#007AFF',
                  ...(isIOS ? {} : {
                    elevation: 2,
                    shadowColor: '#007AFF',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.3,
                    shadowRadius: 4,
                  }),
                }}>
                  <Text 
                    style={{ 
                      fontSize: 15,
                      fontWeight: '600',
                      color: '#FFFFFF',
                    }}
                  >
                    {t('usage.upgrade', 'Upgrade')}
                  </Text>
                </View>
              )}
            </Pressable>
          )}
        </View>
      )}

      {/* Stats Cards with Liquid Glass */}
      {threadSummary && (
        <View style={{ marginBottom: isIOS ? 20 : 16 }}>
          <Text 
            style={{ 
              fontSize: 13,
              fontWeight: '400',
              marginBottom: 8,
              paddingLeft: isIOS ? 16 : 0,
              textTransform: 'uppercase',
            }}
            className="text-muted-foreground"
          >
            {t('usage.usageStats', 'Usage Stats')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {/* Conversations Card */}
            {isLiquidGlassAvailable() && isIOS ? (
              <GlassView
                glassEffectStyle="regular"
                tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                style={{
                  flex: 1,
                  borderRadius: 20,
                  padding: 20,
                  borderWidth: 0.5,
                  borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)',
                }}
              >
                <View style={{ marginBottom: 12, height: 32, width: 32, borderRadius: 16, backgroundColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.2)' : 'rgba(0, 122, 255, 0.15)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon as={MessageSquare} size={18} color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'} strokeWidth={2.5} />
                </View>
                <Text style={{ fontSize: 28, fontWeight: '700', marginBottom: 4 }} className="text-foreground">
                  {totalConversations}
                </Text>
                <Text style={{ fontSize: 13 }} className="text-muted-foreground">
                  {t('usage.conversations', 'Conversations')}
                </Text>
              </GlassView>
            ) : (
              <View style={{
                flex: 1,
                backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF',
                borderRadius: isIOS ? 20 : 12,
                padding: 20,
                ...(isIOS ? {} : {
                  elevation: 2,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.1,
                  shadowRadius: 4,
                }),
              }}>
                <View style={{ marginBottom: 12, height: 32, width: 32, borderRadius: 16, backgroundColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.2)' : 'rgba(0, 122, 255, 0.15)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon as={MessageSquare} size={18} color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'} strokeWidth={2.5} />
                </View>
                <Text style={{ fontSize: 28, fontWeight: '700', marginBottom: 4 }} className="text-foreground">
                  {totalConversations}
                </Text>
                <Text style={{ fontSize: 13 }} className="text-muted-foreground">
                  {t('usage.conversations', 'Conversations')}
                </Text>
              </View>
            )}
            
            {/* Avg per Chat Card */}
            {isLiquidGlassAvailable() && isIOS ? (
              <GlassView
                glassEffectStyle="regular"
                tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                style={{
                  flex: 1,
                  borderRadius: 20,
                  padding: 20,
                  borderWidth: 0.5,
                  borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)',
                }}
              >
                <View style={{ marginBottom: 12, height: 32, width: 32, borderRadius: 16, backgroundColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.2)' : 'rgba(0, 122, 255, 0.15)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon as={Sparkles} size={18} color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'} strokeWidth={2.5} />
                </View>
                <Text style={{ fontSize: 28, fontWeight: '700', marginBottom: 4 }} className="text-foreground">
                  {formatCredits(averagePerConversation)}
                </Text>
                <Text style={{ fontSize: 13 }} className="text-muted-foreground">
                  {t('usage.avgPerChat', 'Avg per Chat')}
                </Text>
              </GlassView>
            ) : (
              <View style={{
                flex: 1,
                backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF',
                borderRadius: isIOS ? 20 : 12,
                padding: 20,
                ...(isIOS ? {} : {
                  elevation: 2,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.1,
                  shadowRadius: 4,
                }),
              }}>
                <View style={{ marginBottom: 12, height: 32, width: 32, borderRadius: 16, backgroundColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.2)' : 'rgba(0, 122, 255, 0.15)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon as={Sparkles} size={18} color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'} strokeWidth={2.5} />
                </View>
                <Text style={{ fontSize: 28, fontWeight: '700', marginBottom: 4 }} className="text-foreground">
                  {formatCredits(averagePerConversation)}
                </Text>
                <Text style={{ fontSize: 13 }} className="text-muted-foreground">
                  {t('usage.avgPerChat', 'Avg per Chat')}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Date Range Selector */}
      <View style={{ marginBottom: isIOS ? 20 : 16 }}>
        <Text 
          style={{ 
            fontSize: isIOS ? 17 : 16,
            fontWeight: isIOS ? '400' : '500',
            marginBottom: 12,
          }}
          className="text-foreground"
        >
          {t('usage.usage', 'Usage')}
        </Text>
        
        {/* iOS Context Menu or Android Fallback */}
        {ContextMenu && Platform.OS === 'ios' ? (
          <ContextMenu
            actions={datePresets.map((preset) => ({ title: preset.label }))}
            onPress={(e: any) => {
              const index = e.nativeEvent.index;
              if (index >= 0 && index < datePresets.length) {
                handleDatePresetSelect(datePresets[index]);
              }
            }}
            dropdownMenuMode={true}
          >
            <Pressable
              style={[
                groupedBackgroundStyle as ViewStyle,
                {
                  paddingHorizontal: 16,
                  paddingVertical: isIOS ? 14 : 16,
                  minHeight: isIOS ? 44 : 56,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }
              ]}
              className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                <Icon as={Calendar} size={20} className="text-foreground" strokeWidth={2} />
                <Text 
                  style={{ 
                    fontSize: isIOS ? 17 : 16,
                    fontWeight: isIOS ? '400' : '500',
                    flex: 1,
                  }}
                  className="text-foreground"
                >
                  {formatDateRange(dateRange.from, dateRange.to)}
                </Text>
              </View>
              <Icon as={ChevronRight} size={18} className="text-muted-foreground" strokeWidth={2} />
            </Pressable>
          </ContextMenu>
        ) : (
          <Pressable
            onPress={() => setIsDateMenuOpen(!isDateMenuOpen)}
            style={[
              groupedBackgroundStyle as ViewStyle,
              {
                paddingHorizontal: 16,
                paddingVertical: isIOS ? 14 : 16,
                minHeight: isIOS ? 44 : 56,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }
            ]}
            className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
              <Icon as={Calendar} size={20} className="text-foreground" strokeWidth={2} />
              <Text 
                style={{ 
                  fontSize: isIOS ? 17 : 16,
                  fontWeight: isIOS ? '400' : '500',
                  flex: 1,
                }}
                className="text-foreground"
              >
                {formatDateRange(dateRange.from, dateRange.to)}
              </Text>
            </View>
            <Icon as={ChevronRight} size={18} className="text-muted-foreground" strokeWidth={2} />
          </Pressable>
        )}
        {Platform.OS === 'android' && isDateMenuOpen && (
          <>
            <Pressable
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 999,
              }}
              onPress={() => setIsDateMenuOpen(false)}
            />
            <View style={{
              position: 'absolute',
              top: 60,
              left: 16,
              right: 16,
              zIndex: 1000,
              ...(groupedBackgroundStyle as ViewStyle),
              padding: 8,
              marginTop: 8,
            }}
            className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
            >
              {datePresets.map((preset, index) => (
                <Pressable
                  key={index}
                  onPress={() => handleDatePresetSelect(preset)}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    minHeight: 48,
                    borderBottomWidth: index < datePresets.length - 1 ? StyleSheet.hairlineWidth : 0,
                    borderBottomColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
                  }}
                >
                  <Text 
                    style={{ 
                      fontSize: 16,
                      fontWeight: '400',
                    }}
                    className="text-foreground"
                  >
                    {preset.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </View>

      {/* View Usage Data Button */}
      <View style={{ marginBottom: isIOS ? 20 : 16 }}>
        <Pressable
          onPress={handleOpenUsageData}
          style={[
            groupedBackgroundStyle as ViewStyle,
            {
              paddingHorizontal: 16,
              paddingVertical: isIOS ? 16 : 18,
              minHeight: isIOS ? 56 : 64,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }
          ]}
          className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
            <View style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.15)' : 'rgba(0, 122, 255, 0.1)',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Icon as={MessageSquare} size={20} color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'} strokeWidth={2.5} />
            </View>
            <View style={{ flex: 1 }}>
              <Text 
                style={{ 
                  fontSize: isIOS ? 17 : 16,
                  fontWeight: isIOS ? '400' : '500',
                  marginBottom: 2,
                }}
                className="text-foreground"
              >
                {t('usage.viewUsageData', 'View usage data')}
              </Text>
              <Text 
                style={{ 
                  fontSize: 13,
                }}
                className="text-muted-foreground"
              >
                {threadRecords.length > 0 
                  ? `${threadRecords.length} ${t('usage.conversations', 'conversations')}`
                  : t('usage.noData', 'No data available')}
              </Text>
            </View>
          </View>
          <Icon as={ChevronRight} size={20} className="text-muted-foreground" strokeWidth={2} />
        </Pressable>
      </View>
      {isUsageDataSheetVisible && (
        <>
          {Platform.OS === 'ios' ? (
            <ReanimatedTrueSheet
              ref={trueSheetRef}
              detents={[0.9]}
              onDidDismiss={handleCloseUsageData}
              cornerRadius={cornerRadius}
              initialDetentIndex={0}
            >
              {renderUsageDataSheetContent()}
            </ReanimatedTrueSheet>
          ) : (
            <BottomSheetModal
              ref={bottomSheetRef}
              index={0}
              snapPoints={snapPoints}
              onDismiss={handleCloseUsageData}
              backdropComponent={renderBackdrop}
              handleIndicatorStyle={{ display: 'none' }}
              backgroundStyle={{
                backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme),
                borderTopLeftRadius: cornerRadius,
                borderTopRightRadius: cornerRadius,
                overflow: 'hidden',
                width: '100%',
              }}
              style={{
                width: '100%',
              }}
            >
              <BottomSheetView style={{ flex: 1, width: '100%' }}>
                {renderUsageDataSheetContent()}
              </BottomSheetView>
            </BottomSheetModal>
          )}
        </>
      )}
    </View>
  );
  function renderUsageDataSheetContent() {
    return (
      <View style={{ flex: 1, backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme) }}>
        <View style={{ padding: 16, paddingTop: insets.top + 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <Text 
              style={{ 
                fontSize: isIOS ? 28 : 24,
                fontWeight: '700',
              }}
              className="text-foreground"
            >
              {t('usage.usageData', 'Usage Data')}
            </Text>
            <Pressable onPress={handleCloseUsageData}>
              {isLiquidGlassAvailable() && isIOS ? (
                <GlassView
                  glassEffectStyle="regular"
                  tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 0.5,
                    borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)',
                  }}
                >
                  <Icon as={X} size={18} className="text-foreground" strokeWidth={2} />
                </GlassView>
              ) : (
                <View style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Icon as={X} size={18} className="text-foreground" strokeWidth={2} />
                </View>
              )}
            </Pressable>
          </View>
        </View>

        <ScrollView 
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}
          showsVerticalScrollIndicator={false}
        >
          {showThreadSkeleton ? (
            <View style={{ gap: 8 }}>
              {[...Array(5)].map((_, i) => (
                <View 
                  key={i} 
                  style={{
                    height: isIOS ? 44 : 56,
                    borderRadius: isIOS ? 20 : 12,
                    backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)',
                  }}
                />
              ))}
            </View>
          ) : threadError ? (
            <View style={{
              borderRadius: isIOS ? 20 : 12,
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? 'rgba(255, 59, 48, 0.2)' : 'rgba(255, 59, 48, 0.2)',
              backgroundColor: colorScheme === 'dark' ? 'rgba(255, 59, 48, 0.1)' : 'rgba(255, 59, 48, 0.1)',
              padding: 16,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                <Icon as={AlertCircle} size={16} color="#FF3B30" strokeWidth={2} />
                <Text 
                  style={{ 
                    fontSize: 15,
                    fontWeight: '500',
                    flex: 1,
                    color: '#FF3B30',
                  }}
                >
                  {threadError instanceof Error
                    ? threadError.message
                    : t('usage.failedToLoad', 'Failed to load thread usage')}
                </Text>
              </View>
            </View>
          ) : threadRecords.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 32 }}>
              <Text 
                style={{ 
                  fontSize: 15,
                  textAlign: 'center',
                }}
                className="text-muted-foreground"
              >
                {dateRange.from && dateRange.to
                  ? `No thread usage found between ${formatSingleDate(dateRange.from, 'MMM dd, yyyy')} and ${formatSingleDate(dateRange.to, 'MMM dd, yyyy')}.`
                  : t('usage.noThreadUsageFoundSimple', 'No thread usage found.')}
              </Text>
            </View>
          ) : (
            <>
              <View 
                style={[
                  groupedBackgroundStyle as ViewStyle,
                  { marginBottom: 16 }
                ]}
                className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
              >
                <View style={{
                  flexDirection: 'row',
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 0, 0, 0.02)',
                }}>
                  <View style={{ flex: 1, paddingRight: 16 }}>
                    <Text 
                      style={{ 
                        fontSize: 13,
                        fontWeight: '600',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                      }}
                      className="text-muted-foreground"
                    >
                      {t('usage.thread', 'Thread')}
                    </Text>
                  </View>
                  <View style={{ width: 100, alignItems: 'flex-end', paddingRight: 12 }}>
                    <Text 
                      style={{ 
                        fontSize: 13,
                        fontWeight: '600',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                      }}
                      className="text-muted-foreground"
                    >
                      {t('usage.creditsUsed', 'Credits')}
                    </Text>
                  </View>
                  <View style={{ width: 90, alignItems: 'flex-end' }}>
                    <Text 
                      style={{ 
                        fontSize: 13,
                        fontWeight: '600',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                      }}
                      className="text-muted-foreground"
                    >
                      {t('usage.lastUsed', 'Used')}
                    </Text>
                  </View>
                </View>
                <View>
                  {threadRecords.map((record, index) => (
                    <Pressable
                      key={record.thread_id}
                      onPress={() => {
                        log.log('🎯 Thread row pressed:', record.thread_id);
                        handleThreadPress(record.thread_id, record.project_id);
                        handleCloseUsageData();
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 16,
                        paddingVertical: isIOS ? 12 : 14,
                        minHeight: isIOS ? 44 : 56,
                        borderBottomWidth: index === threadRecords.length - 1 ? 0 : StyleSheet.hairlineWidth,
                        borderBottomColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
                      }}
                    >
                      <View style={{ flex: 1, paddingRight: 16, minWidth: 0 }}>
                        <Text
                          style={{ 
                            fontSize: isIOS ? 17 : 16,
                            fontWeight: isIOS ? '400' : '500',
                          }}
                          className="text-foreground"
                          numberOfLines={1}
                          ellipsizeMode="tail">
                          {record.project_name}
                        </Text>
                      </View>
                      <View style={{ width: 100, alignItems: 'flex-end', paddingRight: 12 }}>
                        <Text 
                          style={{ 
                            fontSize: isIOS ? 17 : 16,
                            fontWeight: '600',
                          }}
                          className="text-foreground"
                        >
                          {formatCredits(record.credits_used)}
                        </Text>
                      </View>
                      <View style={{ width: 90, alignItems: 'flex-end' }}>
                        <Text
                          style={{ 
                            fontSize: 13,
                          }}
                          className="text-muted-foreground"
                          numberOfLines={1}
                          ellipsizeMode="tail">
                          {formatDate(record.last_used)}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Thread Pagination */}
              {threadData?.pagination && (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
                  <Text 
                    style={{ fontSize: 13 }}
                    className="text-muted-foreground"
                  >
                    {`Showing ${threadOffset + 1}-${Math.min(threadOffset + threadLimit, threadData.pagination.total)} of ${threadData.pagination.total} threads`}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Pressable
                      onPress={handlePrevThreadPage}
                      disabled={threadOffset === 0 || isLoadingThreads}
                    >
                      {isLiquidGlassAvailable() && isIOS ? (
                        <GlassView
                          glassEffectStyle="regular"
                          tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                          style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 12,
                            borderWidth: 0.5,
                            borderColor: (threadOffset === 0 || isLoadingThreads)
                              ? (colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)')
                              : (colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)'),
                            opacity: (threadOffset === 0 || isLoadingThreads) ? 0.5 : 1,
                          }}
                        >
                          <Text
                            style={{ 
                              fontSize: 13,
                              fontWeight: '500',
                              color: (threadOffset === 0 || isLoadingThreads)
                                ? (colorScheme === 'dark' ? '#8E8E93' : '#6E6E73')
                                : (colorScheme === 'dark' ? '#FFFFFF' : '#000000'),
                            }}
                          >
                            {t('common.previous', 'Previous')}
                          </Text>
                        </GlassView>
                      ) : (
                        <View style={{
                          paddingHorizontal: 16,
                          paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor: (threadOffset === 0 || isLoadingThreads)
                            ? (colorScheme === 'dark' ? '#2C2C2E' : '#E8E8ED')
                            : (colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF'),
                          borderWidth: 1,
                          borderColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
                          opacity: (threadOffset === 0 || isLoadingThreads) ? 0.5 : 1,
                          ...(isIOS ? {} : {
                            elevation: (threadOffset === 0 || isLoadingThreads) ? 0 : 1,
                          }),
                        }}>
                          <Text
                            style={{ 
                              fontSize: 13,
                              fontWeight: '500',
                              color: (threadOffset === 0 || isLoadingThreads)
                                ? (colorScheme === 'dark' ? '#8E8E93' : '#6E6E73')
                                : (colorScheme === 'dark' ? '#FFFFFF' : '#000000'),
                            }}
                          >
                            {t('common.previous', 'Previous')}
                          </Text>
                        </View>
                      )}
                    </Pressable>
                    <Pressable
                      onPress={handleNextThreadPage}
                      disabled={!threadData.pagination.has_more || isLoadingThreads}
                    >
                      {isLiquidGlassAvailable() && isIOS ? (
                        <GlassView
                          glassEffectStyle="regular"
                          tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                          style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 12,
                            borderWidth: 0.5,
                            borderColor: (!threadData.pagination.has_more || isLoadingThreads)
                              ? (colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)')
                              : (colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)'),
                            opacity: (!threadData.pagination.has_more || isLoadingThreads) ? 0.5 : 1,
                          }}
                        >
                          <Text
                            style={{ 
                              fontSize: 13,
                              fontWeight: '500',
                              color: (!threadData.pagination.has_more || isLoadingThreads)
                                ? (colorScheme === 'dark' ? '#8E8E93' : '#6E6E73')
                                : (colorScheme === 'dark' ? '#FFFFFF' : '#000000'),
                            }}
                          >
                            {t('common.next', 'Next')}
                          </Text>
                        </GlassView>
                      ) : (
                        <View style={{
                          paddingHorizontal: 16,
                          paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor: (!threadData.pagination.has_more || isLoadingThreads)
                            ? (colorScheme === 'dark' ? '#2C2C2E' : '#E8E8ED')
                            : (colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF'),
                          borderWidth: 1,
                          borderColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
                          opacity: (!threadData.pagination.has_more || isLoadingThreads) ? 0.5 : 1,
                          ...(isIOS ? {} : {
                            elevation: (!threadData.pagination.has_more || isLoadingThreads) ? 0 : 1,
                          }),
                        }}>
                          <Text
                            style={{ 
                              fontSize: 13,
                              fontWeight: '500',
                              color: (!threadData.pagination.has_more || isLoadingThreads)
                                ? (colorScheme === 'dark' ? '#8E8E93' : '#6E6E73')
                                : (colorScheme === 'dark' ? '#FFFFFF' : '#000000'),
                            }}
                          >
                            {t('common.next', 'Next')}
                          </Text>
                        </View>
                      )}
                    </Pressable>
                  </View>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </View>
    );
  }
}
