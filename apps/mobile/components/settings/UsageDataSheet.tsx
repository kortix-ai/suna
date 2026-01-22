import * as React from 'react';
import { View, Pressable, Platform, ScrollView, StyleSheet } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AlertCircle, X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { ReanimatedTrueSheet } from '@lodev09/react-native-true-sheet/reanimated';
import type { TrueSheet } from '@lodev09/react-native-true-sheet';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { getBorderRadius, getDrawerBackgroundColor } from '@agentpress/shared';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThreadUsageTable } from './ThreadUsageTable';
import { ThreadPagination } from './ThreadPagination';
import { type DateRange } from '@/components/billing/DateRangePicker';

interface ThreadRecord {
  thread_id: string;
  project_id: string | null;
  project_name: string;
  credits_used: number;
  last_used: string;
}

interface UsageDataSheetProps {
  visible: boolean;
  onClose: () => void;
  threadRecords: ThreadRecord[];
  dateRange: DateRange;
  threadOffset: number;
  threadLimit: number;
  pagination?: {
    total: number;
    has_more: boolean;
  };
  isLoading: boolean;
  error: Error | null;
  onThreadPress: (threadId: string, projectId: string | null) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
}

export function UsageDataSheet({
  visible,
  onClose,
  threadRecords,
  dateRange,
  threadOffset,
  threadLimit,
  pagination,
  isLoading,
  error,
  onThreadPress,
  onPrevPage,
  onNextPage,
}: UsageDataSheetProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';
  const trueSheetRef = React.useRef<TrueSheet>(null);
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const cornerRadius = getBorderRadius(Platform.OS, '2xl');
  const snapPoints = React.useMemo(() => ['90%'], []);

  const wasSheetVisibleRef = React.useRef(false);
  React.useEffect(() => {
    if (visible && !wasSheetVisibleRef.current) {
      if (Platform.OS === 'ios') {
        trueSheetRef.current?.present();
      } else {
        bottomSheetRef.current?.present();
      }
      wasSheetVisibleRef.current = true;
    } else if (!visible && wasSheetVisibleRef.current) {
      if (Platform.OS === 'ios') {
        trueSheetRef.current?.dismiss();
      } else {
        bottomSheetRef.current?.dismiss();
      }
      wasSheetVisibleRef.current = false;
    }
  }, [visible]);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  const handleThreadPress = React.useCallback(
    (threadId: string, projectId: string | null) => {
      onThreadPress(threadId, projectId);
      onClose();
    },
    [onThreadPress, onClose]
  );

  const renderContent = () => (
    <View style={{ flex: 1, backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme) }}>
      <View style={{ padding: 16, paddingTop: 30 }}>
        <View className="flex-row items-center" style={{ position: 'relative', minHeight: 32 }}>
          <View style={{ flex: 1 }} />
          <Text
            style={{
              fontSize: 20,
              position: 'absolute',
              left: 0,
              right: 0,
              textAlign: 'center',
              pointerEvents: 'none',
            }}
            className="text-foreground font-roobert-semibold"
          >
            {t('usage.usageData', 'Usage Data')}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}
        showsVerticalScrollIndicator={false}
      >
        {isLoading && threadOffset === 0 ? (
          <View style={{ gap: 8 }}>
            {[...Array(5)].map((_, i) => (
              <View
                key={i}
                style={{
                  height: isIOS ? 44 : 56,
                  borderRadius: isIOS ? 20 : 12,
                  backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)',
                }}
              />
            ))}
          </View>
        ) : error ? (
          <View
            style={{
              borderRadius: isIOS ? 20 : 12,
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? 'rgba(255, 59, 48, 0.2)' : 'rgba(255, 59, 48, 0.2)',
              backgroundColor: colorScheme === 'dark' ? 'rgba(255, 59, 48, 0.1)' : 'rgba(255, 59, 48, 0.1)',
              padding: 16,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <Icon as={AlertCircle} size={16} color="#FF3B30" strokeWidth={2} />
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: '500',
                  flex: 1,
                  color: '#FF3B30',
                }}
              >
                {error instanceof Error ? error.message : t('usage.failedToLoad', 'Failed to load thread usage')}
              </Text>
            </View>
          </View>
        ) : (
          <>
            <ThreadUsageTable threadRecords={threadRecords} dateRange={dateRange} onThreadPress={handleThreadPress} />
            {pagination && (
              <ThreadPagination
                threadOffset={threadOffset}
                threadLimit={threadLimit}
                total={pagination.total}
                hasMore={pagination.has_more}
                isLoading={isLoading}
                onPrevPage={onPrevPage}
                onNextPage={onNextPage}
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );

  if (!visible) return null;

  return (
    <>
      {Platform.OS === 'ios' ? (
        <ReanimatedTrueSheet
          ref={trueSheetRef}
          detents={[0.9]}
          onDidDismiss={onClose}
          cornerRadius={cornerRadius}
          initialDetentIndex={0}
        >
          {renderContent()}
        </ReanimatedTrueSheet>
      ) : (
        <BottomSheetModal
          ref={bottomSheetRef}
          index={0}
          snapPoints={snapPoints}
          onDismiss={onClose}
          backdropComponent={renderBackdrop}
          handleIndicatorStyle={{ display: 'none' }}
          backgroundStyle={{
            backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme),
            borderTopLeftRadius: cornerRadius,
            borderTopRightRadius: cornerRadius,
            overflow: 'hidden',
            width: '100%',
          }}
          style={{
            width: '100%',
          }}
        >
          <BottomSheetView style={{ flex: 1, width: '100%' }}>{renderContent()}</BottomSheetView>
        </BottomSheetModal>
      )}
    </>
  );
}
