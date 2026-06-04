import React, { useState, useEffect } from 'react';
import { View, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, ExternalLink, LucideIcon } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

export type AlertBannerVariant = 'warning' | 'error' | 'info';

interface AlertBannerProps {
  title: string;
  message?: string;
  variant?: AlertBannerVariant;
  icon: LucideIcon;
  dismissKey: string;
  statusUrl?: string;
  countdown?: string;
  onDismiss?: () => void;
}

const variantStyles: Record<AlertBannerVariant, {
  bg: string;
  border: string;
  textColor: string;
  iconColor: string;
}> = {
  warning: {
    bg: 'bg-muted',
    border: 'border-muted-foreground/20',
    textColor: 'text-foreground',
    iconColor: 'text-amber-500',
  },
  error: {
    bg: 'bg-muted',
    border: 'border-muted-foreground/20',
    textColor: 'text-foreground',
    iconColor: 'text-red-500',
  },
  info: {
    bg: 'bg-muted',
    border: 'border-muted-foreground/20',
    textColor: 'text-foreground',
    iconColor: 'text-blue-500',
  },
};

export function AlertBanner({
  title,
  message,
  variant = 'warning',
  icon: IconComponent,
  dismissKey,
  statusUrl,
  countdown,
  onDismiss,
}: AlertBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  const storageKey = `alert-dismissed-${dismissKey}`;

  useEffect(() => {
    setIsMounted(true);
    AsyncStorage.getItem(storageKey).then((value) => {
      if (value === 'true') {
        setIsDismissed(true);
      }
    }).catch(() => {});
  }, [storageKey]);

  const handleDismiss = async () => {
    setIsDismissed(true);
    try {
      await AsyncStorage.setItem(storageKey, 'true');
    } catch {}
    onDismiss?.();
  };

  const handleStatusPress = () => {
    if (statusUrl) {
      const url = statusUrl.startsWith('http') ? statusUrl : `https://kortix.ai${statusUrl}`;
      Linking.openURL(url).catch(() => {});
    }
  };

  if (!isMounted || isDismissed) {
    return null;
  }

  const styles = variantStyles[variant];

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
    >
      <View className={`mx-4 rounded-3xl border p-3 ${styles.bg} ${styles.border}`}>
        <View className="flex-row items-center gap-2">
          <Icon as={IconComponent} size={16} className={styles.iconColor} />
          
          <View className="flex-1 flex-row items-center gap-2 flex-wrap">
            <Text className={`font-roobert-medium text-sm ${styles.textColor}`}>
              {title}
            </Text>
            {countdown && (
              <>
                <Text className={`text-sm ${styles.textColor}`}>•</Text>
                <Text className={`text-sm ${styles.textColor}`}>{countdown}</Text>
              </>
            )}
          </View>
          
          <Pressable
            onPress={handleDismiss}
            hitSlop={8}
            className="h-6 w-6 items-center justify-center rounded-full"
          >
            <Icon as={X} size={12} className={styles.textColor} />
          </Pressable>
        </View>

        {message && (
          <Text className={`mt-1.5 ml-6 text-xs ${styles.textColor} opacity-80`}>
            {message}
          </Text>
        )}

        {statusUrl && (
          <Pressable
            onPress={handleStatusPress}
            className="mt-2 ml-6 flex-row items-center gap-1"
          >
            <Text className={`font-roobert-medium text-xs ${styles.textColor}`}>
              View Status
            </Text>
            <Icon as={ExternalLink} size={10} className={styles.textColor} />
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}
