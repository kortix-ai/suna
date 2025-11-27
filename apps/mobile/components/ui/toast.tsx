import React, { useEffect } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
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
import { useColorScheme } from 'nativewind';

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

export function ToastComponent({ toast, onDismiss }: ToastProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
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

  const accentColor = {
    error: '#EF4444',
    success: '#22C55E', 
    warning: '#F59E0B',
    info: '#3B82F6',
  }[toast.type];

  const bgColor = isDark ? 'rgba(28, 28, 30, 0.95)' : 'rgba(255, 255, 255, 0.98)';
  const borderColor = isDark ? 'rgba(44, 44, 46, 0.8)' : 'rgba(229, 229, 229, 0.8)';
  const textColor = isDark ? '#F5F5F5' : '#1C1C1E';

  return (
    <Animated.View
      style={[
        animatedStyle,
        styles.wrapper,
        { top: insets.top + 12 },
      ]}
    >
      <View
        style={[
          styles.container,
          {
            backgroundColor: bgColor,
            borderColor: borderColor,
          },
        ]}
      >
        {/* Accent bar */}
        <View style={[styles.accent, { backgroundColor: accentColor }]} />
        
        {/* Message */}
        <View style={styles.content}>
          <Text 
            style={[styles.message, { color: textColor }]}
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
          style={styles.close}
        >
          <Icon as={X} size={14} color={isDark ? '#8E8E93' : '#8E8E93'} strokeWidth={2} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 9999,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 6,
    overflow: 'hidden',
    minHeight: 48,
  },
  accent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  content: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  message: {
    fontSize: 14,
    fontFamily: 'Roobert-Medium',
    lineHeight: 18,
    letterSpacing: -0.2,
  },
  close: {
    padding: 4,
    borderRadius: 6,
  },
});
