import * as React from 'react';
import { View, Pressable, Platform, Animated } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Activity, RefreshCw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { formatCredits } from '@agentpress/shared';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { log } from '@/lib/logger';
import { useColorScheme } from 'nativewind';

interface UsageSummaryCardProps {
  threadSummary: {
    total_credits_used: number;
    start_date?: string;
    end_date?: string;
  } | null;
  hasFreeTier: boolean;
  isUltraTier: boolean;
  isLoading?: boolean;
  isSyncing?: boolean;
  onUpgradePress?: () => void;
  onRefresh?: () => void;
  dateRangeLabel?: string;
}

export function UsageSummaryCard({
  threadSummary,
  hasFreeTier,
  isUltraTier,
  isLoading = false,
  isSyncing = false,
  onUpgradePress,
  onRefresh,
  dateRangeLabel,
}: UsageSummaryCardProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();
  const spinAnim = React.useRef(new Animated.Value(0)).current;
  const pulseAnim = React.useRef(new Animated.Value(1)).current;

  const isDark = colorScheme === 'dark';

  // Sync animation
  React.useEffect(() => {
    if (isSyncing) {
      Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        })
      ).start();
      
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.5,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      spinAnim.setValue(0);
      pulseAnim.setValue(1);
    }
  }, [isSyncing, spinAnim, pulseAnim]);

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const handleUpgradePress = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (useNativePaywall) {
      log.log('📱 Using RevenueCat paywall');
      await presentUpgradePaywall();
    } else {
      onUpgradePress?.();
    }
  };

  const buttonText = hasFreeTier
    ? t('usage.upgradeYourPlan', 'Upgrade Your Plan')
    : isUltraTier
      ? t('usage.topUp', 'Top Up')
      : t('usage.upgrade', 'Upgrade');

  return (
    <View
      style={{
        marginBottom: 40,
        alignItems: 'center',
        paddingTop: 16,
      }}
    >
      <View
        style={{
          width: 80,
          height: 80,
          borderRadius: 40,
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 28,
        }}
      >
        <Animated.View style={{ opacity: isSyncing ? pulseAnim : 1 }}>
          <Icon as={Activity} size={36} className="text-foreground" strokeWidth={1.5} />
        </Animated.View>
      </View>
      {isLoading && !threadSummary ? (
        <View style={{ alignItems: 'center', marginBottom: 8 }}>
          <View
            style={{
              width: 140,
              height: 56,
              borderRadius: 12,
              backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
            }}
          />
        </View>
      ) : (
        <Text
          style={{
            fontSize: 50,
            fontWeight: '700',
            letterSpacing: -3,
            marginBottom: 4,
            lineHeight: 70,
          }}
          className="text-foreground font-roobert-semibold"
        >
          {formatCredits(threadSummary?.total_credits_used ?? 0)}
        </Text>
      )}

      <Text
        style={{
          fontSize: 15,
          marginBottom: 6,
        }}
        className="text-muted-foreground font-roobert"
      >
        {t('usage.totalCreditsUsed', 'Total Credits Used')}
      </Text>

      {/* Date Range Label */}
      {dateRangeLabel && (
        <Text
          style={{
            fontSize: 13,
          }}
          className="text-muted-foreground font-roobert"
        >
          {dateRangeLabel}
        </Text>
      )}

      {/* Sync Status */}
      {isSyncing && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginTop: 12,
          }}
        >
          <Animated.View
            style={{
              width: 5,
              height: 5,
              borderRadius: 2.5,
              backgroundColor: isDark ? '#F8F8F8' : '#121215',
              opacity: pulseAnim,
            }}
          />
          <Text
            style={{
              fontSize: 12,
            }}
            className="text-muted-foreground font-roobert"
          >
            {t('usage.syncing', 'Syncing...')}
          </Text>
        </View>
      )}

      {/* Upgrade Button */}
      {(hasFreeTier || isUltraTier || onUpgradePress) && (
        <Pressable
          onPress={handleUpgradePress}
          style={{ marginTop: 32 }}
        >
          <View
            style={{
              paddingHorizontal: 28,
              paddingVertical: 14,
              borderRadius: 100,
              backgroundColor: isDark ? '#F8F8F8' : '#121215',
            }}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: '600',
                color: isDark ? '#121215' : '#F8F8F8',
              }}
              className="font-roobert-medium"
            >
              {buttonText}
            </Text>
          </View>
        </Pressable>
      )}
    </View>
  );
}
