import React, { useState, useMemo, useCallback } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import type { UnifiedMessage } from '@/api/types';
import { parseToolMessage } from '@/lib/utils/tool-parser';
import { getToolViewComponent } from './tool-views';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { X, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { vars } from 'nativewind';

export interface ToolMessagePair {
  assistantMessage: UnifiedMessage | null;
  toolMessage: UnifiedMessage;
}

interface ToolCallPanelProps {
  visible: boolean;
  onClose: () => void;
  toolMessages: ToolMessagePair[];
  initialIndex?: number;
  project?: {
    id: string;
    name: string;
    sandbox_id?: string;
  };
}

export function ToolCallPanel({
  visible,
  onClose,
  toolMessages,
  initialIndex = 0,
  project,
}: ToolCallPanelProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['85%'], []);
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  React.useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      console.log('📳 Haptic Feedback: Tool Drawer Opened');
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible, initialIndex]);

  const currentPair = toolMessages[currentIndex];

  const toolData = useMemo(() => {
    if (!currentPair?.toolMessage) return null;
    return parseToolMessage(currentPair.toolMessage.content);
  }, [currentPair]);

  const { toolName } = toolData || { toolName: 'Error' };

  const ToolViewComponent = useMemo(() => {
    return getToolViewComponent(toolName);
  }, [toolName]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      console.log('◀️ Tool Navigation: Previous', { from: currentIndex, to: currentIndex - 1 });
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex < toolMessages.length - 1) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      console.log('▶️ Tool Navigation: Next', { from: currentIndex, to: currentIndex + 1 });
      setCurrentIndex(currentIndex + 1);
    }
  }, [currentIndex, toolMessages.length]);

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    console.log('❌ Tool Drawer Closed');
    onClose();
  }, [onClose]);

  const renderBackdrop = useCallback(
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

  const handleSheetChange = useCallback((index: number) => {
    if (index === -1) {
      onClose();
    }
  }, [onClose]);

  const isPrevDisabled = currentIndex <= 0;
  const isNextDisabled = currentIndex >= toolMessages.length - 1;

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={vars({ '--card': 'backgroundColor' })}
      handleIndicatorStyle={{
        ...vars({ '--border': 'backgroundColor' }),
        width: 36,
        height: 5,
        borderRadius: 3,
        marginTop: 8,
        marginBottom: 0
      }}
      enableDynamicSizing={false}
      style={{
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden'
      }}
    >
      <BottomSheetScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 20 }}
      >
        {!currentPair || !toolData ? (
          <View className="flex-1 justify-center items-center px-6 py-12">
            <Text className="text-foreground font-roobert-semibold text-lg mb-4">
              Error Loading Tool Data
            </Text>
            <Text className="text-foreground/60 text-center font-roobert">
              Unable to parse tool execution data
            </Text>
          </View>
        ) : (
          <ToolViewComponent
            toolData={toolData}
            assistantMessage={currentPair.assistantMessage}
            toolMessage={currentPair.toolMessage}
            currentIndex={currentIndex}
            totalCalls={toolMessages.length}
            project={project}
          />
        )}
      </BottomSheetScrollView>

      {toolMessages.length > 1 && (
        <View
          className=" bg-card px-6"
          style={{
            paddingTop: 12,
            paddingBottom: Math.max(insets.bottom, 12),
          }}
        >
          <View className="flex-row items-center justify-between gap-3">
            <Button
              onPress={handlePrev}
              disabled={isPrevDisabled}
              variant="default"
              size="sm"
              className="rounded-2xl px-4"
            >
              <Icon
                as={ChevronLeft}
                size={14}
                className="text-primary-foreground"
              />
              <Text className="text-sm font-roobert-medium text-primary-foreground">
                Prev
              </Text>
            </Button>

            <View className="px-2">
              <Text className="text-sm font-roobert-semibold text-foreground tabular-nums">
                {currentIndex + 1}/{toolMessages.length}
              </Text>
            </View>

            <Button
              onPress={handleNext}
              disabled={isNextDisabled}
              variant="default"
              size="sm"
              className="rounded-2xl px-4"
            >
              <Text className="text-sm font-roobert-medium text-primary-foreground">
                Next
              </Text>
              <Icon
                as={ChevronRight}
                size={14}
                className="text-primary-foreground"
              />
            </Button>
          </View>
        </View>
      )}
    </BottomSheet>
  );
}
