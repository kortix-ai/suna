import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';
import { Coins, Sparkles, TextAlignStart } from 'lucide-react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useCreditBalance } from '@/lib/billing';
import { formatCredits } from '@agentpress/shared';
import { useLanguage } from '@/contexts';
import { log } from '@/lib/logger';
import { router, useRouter } from 'expo-router';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
interface TopNavProps {
  onMenuPress?: () => void;
  onUpgradePress?: () => void;
  onCreditsPress?: () => void;
  visible?: boolean;
  colorScheme: any;
}

export function TopNav({
  onMenuPress,
  onUpgradePress,
  onCreditsPress,
  visible = true,
  colorScheme
}: TopNavProps) {
  const { t } = useLanguage();
  const { data: creditBalance, refetch: refetchCredits } = useCreditBalance();
  const creditsScale = useSharedValue(1);
  const rightUpgradeScale = useSharedValue(1);

  React.useEffect(() => {
    refetchCredits();
  }, []);

  const creditsAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsScale.value }],
  }));

  const rightUpgradeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: rightUpgradeScale.value }],
  }));

  const handleMenuPress = () => {
    router.push('/menu');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleUpgradePress = () => {
    log.log('🎯 Upgrade button pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onUpgradePress?.();
  };

  const handleCreditsPress = () => {
    log.log('🎯 Credits button pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    refetchCredits();
    onCreditsPress?.();
  };

  if (!visible) {
    return null;
  }

  return (
    <View 
      className="absolute left-0 right-0 top-[62px] z-50 h-[41px] flex-row items-center px-0"
      style={Platform.OS === 'android' ? { elevation: 50, zIndex: 50 } : undefined}
    >
      <Pressable
        onPress={handleMenuPress}
        style={{ position: 'absolute', left: 24, top: 4.5, width: 44, height: 44, borderRadius: 100 }}
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        accessibilityHint="Opens the navigation drawer">
        <LiquidGlass
          variant="default"
          isInteractive
          borderRadius={22}
          elevation={Platform.OS === 'android' ? 3 : 0}
          shadow={{
            color: colorScheme === 'dark' ? '#000000' : '#000000',
            offset: { width: 0, height: 2 },
            opacity: colorScheme === 'dark' ? 0.3 : 0.1,
            radius: 4,
          }}
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            borderWidth: 0.5,
            borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
            shadowColor: colorScheme === 'dark' ? '#000000' : '#000000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: colorScheme === 'dark' ? 0.3 : 0.1,
            shadowRadius: 4,
          }}
        >
          <Icon as={TextAlignStart} size={20} className="text-foreground" strokeWidth={2} />
        </LiquidGlass>
      </Pressable>
      <View className="absolute right-6 top-2 flex-row items-center gap-2">
        <AnimatedPressable
          onPressIn={() => {
            rightUpgradeScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
          }}
          onPressOut={() => {
            rightUpgradeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          onPress={handleUpgradePress}
          style={[
            rightUpgradeAnimatedStyle,
            {
              height: 36,
              borderRadius: 18,
              overflow: 'hidden',
              shadowColor: '#000000',
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.15,
              shadowRadius: 6,
              elevation: 4,
            }
          ]}
          accessibilityRole="button"
          accessibilityLabel="Upgrade">
          <View className="h-full flex-row items-center gap-1.5 rounded-full border-[1.5px] border-primary bg-primary px-3">
            <Icon as={Sparkles} size={14} className="text-primary-foreground" strokeWidth={2.5} />
            <Text className="font-roobert-semibold text-xs text-primary-foreground">
              {t('billing.upgrade')}
            </Text>
          </View>
        </AnimatedPressable>
        <AnimatedPressable
          onPressIn={() => {
            creditsScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
          }}
          onPressOut={() => {
            creditsScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          onPress={handleCreditsPress}
          style={[
            creditsAnimatedStyle,
            { borderRadius: 18, overflow: 'hidden' }
          ]}
          accessibilityRole="button"
          accessibilityLabel="View usage"
          accessibilityHint="Opens usage details">
          <LiquidGlass
            variant="subtle"
            isInteractive
            borderRadius={18}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
            className="bg-primary/5"
          >
            <Icon as={Coins} size={16} className="text-primary" strokeWidth={2.5} />
            <Text className="font-roobert-semibold text-sm text-primary">
              {formatCredits(creditBalance?.balance || 0)}
            </Text>
          </LiquidGlass>
        </AnimatedPressable>
      </View>
    </View>
  );
}
