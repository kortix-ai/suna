import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Bell } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useNotifications } from '@/hooks/useNotifications';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface NotificationBellProps {
  size?: number;
}

export function NotificationBell({ size = 20 }: NotificationBellProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const [mounted, setMounted] = useState(false);
  
  // Only fetch after component is mounted to avoid state update errors
  const { data } = useNotifications(
    { page: 1, page_size: 1, is_read: false },
    { enabled: mounted }
  );
  
  const scale = useSharedValue(1);

  useEffect(() => {
    // Set mounted after component mounts to avoid state update during render
    setMounted(true);
  }, []);

  const unreadCount = data?.unread_count || 0;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/notifications');
  };

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      style={animatedStyle}
      className="relative"
    >
      <Icon as={Bell} size={size} className="text-foreground" strokeWidth={2} />
      {unreadCount > 0 && (
        <View className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-blue-500 items-center justify-center">
          <Text className="text-[10px] font-medium text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </Text>
        </View>
      )}
    </AnimatedPressable>
  );
}
