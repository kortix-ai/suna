import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { CheckCircle2, AlertCircle, LucideIcon, AlertTriangle } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

interface StatusBadgeProps {
  variant: 'success' | 'error' | 'streaming' | 'warning' | 'outline';
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
          defaultIcon: null, // Uses KortixLoader for streaming
          isStreaming: true,
        };
      case 'warning':
        return {
          bg: isDark ? 'bg-amber-900/60' : 'bg-amber-100',
          text: isDark ? 'text-amber-300' : 'text-amber-700',
          border: isDark ? 'border-amber-800/50' : 'border-amber-200',
          defaultIcon: AlertTriangle,
        };
      case 'outline':
        return {
          bg: isDark ? 'bg-white/0' : 'bg-black/0',
          text: 'text-muted-foreground',
          border: isDark ? 'border-white/15' : 'border-black/10',
          defaultIcon: undefined,
        };
    }
    return {
      bg: isDark ? 'bg-white/0' : 'bg-black/0',
      text: 'text-muted-foreground',
      border: isDark ? 'border-white/15' : 'border-black/10',
      defaultIcon: undefined,
    };
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
        {(styles as any).isStreaming ? (
          <KortixLoader size="small" customSize={14} />
        ) : IconComponent ? (
          <Icon
            as={IconComponent}
            size={14}
            className={styles.text}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View
      className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full border ${styles.bg} ${styles.border} ${className}`}
    >
      {(styles as any).isStreaming ? (
        <KortixLoader size="small" customSize={14} />
      ) : IconComponent ? (
        <Icon
          as={IconComponent}
          size={14}
          className={styles.text}
        />
      ) : null}
      {label && (
        <Text className={`text-xs font-roobert-medium ${styles.text}`}>
          {label}
        </Text>
      )}
    </View>
  );
}

