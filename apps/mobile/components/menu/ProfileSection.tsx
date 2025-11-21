import * as React from 'react';
import { Pressable, View, Image } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import type { UserProfile } from './types';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ProfileSectionProps {
  profile?: UserProfile;
  onPress?: () => void;
}

/**
 * ProfileSection Component
 * 
 * Clean profile header with settings/auth access.
 * 
 * Design Specifications:
 * - Horizontal layout: Avatar + Name
 * - Avatar: 40x40px circular (shows "?" for guests)
 * - Typography: Roobert-Medium 17px (name)
 * - Press animation: Scale to 0.98
 * - Clean, minimal design (no arrow icon)
 * 
 * Features:
 * - Shows "Sign in" for guests, name for authenticated users
 * - Opens auth page for guests
 * - Opens settings page for authenticated users
 * - Authenticated user data from Supabase
 * - Press animation with haptic feedback
 * - Guest mode support with clear call-to-action
 */
export function ProfileSection({ profile, onPress }: ProfileSectionProps) {
  const { user } = useAuthContext();
  const { t } = useLanguage();
  const scale = useSharedValue(1);
  
  // Get user data from auth context or fallback to profile prop
  const userName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || profile?.name || t('auth.guest.label');
  const userAvatar = user?.user_metadata?.avatar_url || profile?.avatar;
  const isGuest = !user;
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };
  
  const handlePress = () => {
    console.log('🎯 Profile section pressed - Opening settings');
    console.log('📊 User:', { userName, isGuest });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.();
  };
  
  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="flex-row items-center gap-3 w-full"
      accessibilityLabel={isGuest ? t('auth.signIn') : t('settings.title')}
      accessibilityRole="button"
    >
      {/* Avatar - 40x40px circular */}
      <View 
        className="rounded-full overflow-hidden bg-secondary"
        style={{ width: 40, height: 40 }}
      >
        {userAvatar ? (
          <Image 
            source={{ uri: userAvatar }}
            style={{ width: 40, height: 40 }}
            resizeMode="cover"
          />
        ) : (
          <View className="size-full items-center justify-center bg-primary/10">
            <Text className="text-base font-roobert-semibold text-foreground">
              {isGuest ? '?' : userName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
      </View>
      
      {/* Name or Sign in prompt */}
      <View className="flex-1">
        <Text className="text-[17px] font-roobert-medium text-foreground" numberOfLines={1}>
          {isGuest ? t('auth.signIn') : userName}
        </Text>
        {isGuest && (
          <Text className="text-xs font-roobert text-muted-foreground">
            {t('auth.tapToContinue')}
          </Text>
        )}
      </View>
    </AnimatedPressable>
  );
}

