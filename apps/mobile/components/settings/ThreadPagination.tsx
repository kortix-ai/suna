import * as React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { LiquidGlass } from '@/components/ui/liquid-glass';

interface ThreadPaginationProps {
  threadOffset: number;
  threadLimit: number;
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
}

export function ThreadPagination({
  threadOffset,
  threadLimit,
  total,
  hasMore,
  isLoading,
  onPrevPage,
  onNextPage,
}: ThreadPaginationProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
      <Text style={{ fontSize: 13 }} className="text-muted-foreground">
        {`Showing ${threadOffset + 1}-${Math.min(threadOffset + threadLimit, total)} of ${total} threads`}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable onPress={onPrevPage} disabled={threadOffset === 0 || isLoading}>
          <LiquidGlass
            variant="default"
            borderRadius={isIOS ? 12 : 8}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              opacity: threadOffset === 0 || isLoading ? 0.5 : 1,
            }}
            backgroundColor={threadOffset === 0 || isLoading ? (colorScheme === 'dark' ? '#2C2C2E' : '#E8E8ED') : undefined}
            borderColor={
              threadOffset === 0 || isLoading
                ? colorScheme === 'dark'
                  ? 'rgba(255, 255, 255, 0.05)'
                  : 'rgba(0, 0, 0, 0.03)'
                : undefined
            }
            elevation={threadOffset === 0 || isLoading ? 0 : isIOS ? 0 : 1}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: '500',
                color:
                  threadOffset === 0 || isLoading
                    ? colorScheme === 'dark'
                      ? '#8E8E93'
                      : '#6E6E73'
                    : colorScheme === 'dark'
                      ? '#FFFFFF'
                      : '#000000',
              }}
            >
              {t('common.previous', 'Previous')}
            </Text>
          </LiquidGlass>
        </Pressable>
        <Pressable onPress={onNextPage} disabled={!hasMore || isLoading}>
          <LiquidGlass
            variant="default"
            borderRadius={isIOS ? 12 : 8}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              opacity: !hasMore || isLoading ? 0.5 : 1,
            }}
            backgroundColor={!hasMore || isLoading ? (colorScheme === 'dark' ? '#2C2C2E' : '#E8E8ED') : undefined}
            borderColor={
              !hasMore || isLoading
                ? colorScheme === 'dark'
                  ? 'rgba(255, 255, 255, 0.05)'
                  : 'rgba(0, 0, 0, 0.03)'
                : undefined
            }
            elevation={!hasMore || isLoading ? 0 : isIOS ? 0 : 1}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: '500',
                color:
                  !hasMore || isLoading
                    ? colorScheme === 'dark'
                      ? '#8E8E93'
                      : '#6E6E73'
                    : colorScheme === 'dark'
                      ? '#FFFFFF'
                      : '#000000',
              }}
            >
              {t('common.next', 'Next')}
            </Text>
          </LiquidGlass>
        </Pressable>
      </View>
    </View>
  );
}
