import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, AlertCircle, Loader2, LucideIcon } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

interface StatusBadgeProps {
  variant: 'success' | 'error' | 'streaming';
  label?: string;
  icon?: LucideIcon;
  className?: string;
  iconOnly?: boolean;
}

export function StatusBadge({
  variant,
  label,
  icon,
  className = '',
  iconOnly = false,
}: StatusBadgeProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const getVariantStyles = () => {
    switch (variant) {
      case 'success':
        return {
          bg: isDark ? 'bg-emerald-900/60' : 'bg-emerald-100',
          text: isDark ? 'text-emerald-300' : 'text-emerald-700',
          border: isDark ? 'border-emerald-800/50' : 'border-emerald-200',
          defaultIcon: CheckCircle2,
        };
      case 'error':
        return {
          bg: isDark ? 'bg-rose-900/60' : 'bg-rose-100',
          text: isDark ? 'text-rose-300' : 'text-rose-700',
          border: isDark ? 'border-rose-800/50' : 'border-rose-200',
          defaultIcon: AlertCircle,
        };
      case 'streaming':
        return {
          bg: isDark ? 'bg-blue-900/60' : 'bg-blue-100',
          text: isDark ? 'text-blue-300' : 'text-blue-700',
          border: isDark ? 'border-blue-800/50' : 'border-blue-200',
          defaultIcon: Loader2,
        };
    }
  };

  const styles = getVariantStyles();
  const IconComponent = icon || styles.defaultIcon;

  if (iconOnly) {
    return (
      <View
        className={`items-center justify-center ${styles.bg} ${styles.border} ${className}`}
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
        }}
      >
        {IconComponent === Loader2 ? (
          <Icon
            as={Loader2}
            size={14}
            className={`${styles.text} animate-spin`}
          />
        ) : (
          <Icon
            as={IconComponent}
            size={14}
            className={styles.text}
          />
        )}
      </View>
    );
  }

  return (
    <View
      className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full border ${styles.bg} ${styles.border} ${className}`}
    >
      {IconComponent === Loader2 ? (
        <Icon
          as={Loader2}
          size={14}
          className={`${styles.text} animate-spin`}
        />
      ) : (
        <Icon
          as={IconComponent}
          size={14}
          className={styles.text}
        />
      )}
      {label && (
        <Text className={`text-xs font-roobert-medium ${styles.text}`}>
          {label}
        </Text>
      )}
    </View>
  );
}

