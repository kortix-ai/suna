import React, { useEffect } from 'react';
import { View, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

export type ToastType = 'error' | 'success' | 'info' | 'warning';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

const TOAST_DURATION = 4000;

const ACCENT_CLASS: Record<ToastType, string> = {
  error: 'bg-destructive',
  success: 'bg-kortix-green',
  warning: 'bg-kortix-orange',
  info: 'bg-kortix-blue',
};

export function ToastComponent({ toast, onDismiss }: ToastProps) {
  const insets = useSafeAreaInsets();

  const translateY = useSharedValue(-120);
  const opacity = useSharedValue(0);

  useEffect(() => {
    translateY.value = withSpring(0, {
      damping: 30,
      stiffness: 400,
      mass: 0.5,
    });
    opacity.value = withTiming(1, { duration: 200 });

    Haptics.notificationAsync(
      toast.type === 'error'
        ? Haptics.NotificationFeedbackType.Error
        : toast.type === 'success'
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning
    );

    const timer = setTimeout(dismiss, toast.duration ?? TOAST_DURATION);
    return () => clearTimeout(timer);
  }, []);

  const dismiss = () => {
    translateY.value = withTiming(-120, { duration: 200 });
    opacity.value = withTiming(0, { duration: 200 });
    setTimeout(() => runOnJS(onDismiss)(toast.id), 250);
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[animatedStyle, { top: insets.top + 12 }]}
      className="absolute left-4 right-4 z-[9999]"
    >
      <View className="bg-surface border-border min-h-12 flex-row items-center overflow-hidden rounded-xl border px-3.5 py-3 shadow-lg shadow-black/5">
        {/* Accent bar */}
        <View className={`absolute bottom-0 left-0 top-0 w-[3px] ${ACCENT_CLASS[toast.type]}`} />

        {/* Message */}
        <View className="ml-3 mr-2 flex-1">
          <Text
            className="font-roobert-medium text-foreground text-sm leading-[18px] tracking-[-0.2px]"
            numberOfLines={3}
          >
            {toast.message}
          </Text>
        </View>

        {/* Close button */}
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            dismiss();
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          className="rounded-md p-1"
        >
          <Icon as={X} size={14} className="text-muted-foreground" strokeWidth={2} />
        </Pressable>
      </View>
    </Animated.View>
  );
}
