import * as React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BarChart3, ChevronRight } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

interface ViewUsageDataButtonProps {
  threadCount: number;
  onPress: () => void;
  isLoading?: boolean;
}

export function ViewUsageDataButton({ threadCount, onPress, isLoading = false }: ViewUsageDataButtonProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';
  const isDark = colorScheme === 'dark';

  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 16,
        borderRadius: isIOS ? 16 : 12,
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        borderWidth: 1,
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        opacity: isLoading ? 0.6 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon as={BarChart3} size={20} className="text-foreground" strokeWidth={1.5} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 15,
              marginBottom: 2,
            }}
            className="text-foreground font-roobert-medium"
          >
            {t('usage.viewUsageData', 'View usage data')}
          </Text>
          <Text
            style={{
              fontSize: 13,
            }}
            className="text-muted-foreground font-roobert"
          >
            {isLoading
              ? t('usage.loading', 'Loading...')
              : threadCount > 0
                ? `${threadCount} ${t('usage.conversations', 'conversations')}`
                : t('usage.noData', 'No data available')}
          </Text>
        </View>
      </View>
      <Icon as={ChevronRight} size={20} className="text-muted-foreground" strokeWidth={2} />
    </Pressable>
  );
}
