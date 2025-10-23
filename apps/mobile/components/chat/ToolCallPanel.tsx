/**
 * Tool Call Panel
 * 
 * Bottom drawer displaying detailed tool call information.
 * Supports navigation between multiple tool calls.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import type { UnifiedMessage } from '@/api/types';
import { parseToolMessage } from '@/lib/utils/tool-parser';
import { getToolViewComponent } from './tool-views';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { X, ChevronLeft, ChevronRight } from 'lucide-react-native';

export interface ToolMessagePair {
  assistantMessage: UnifiedMessage | null;
  toolMessage: UnifiedMessage;
}

interface ToolCallPanelProps {
  visible: boolean;
  onClose: () => void;
  toolMessages: ToolMessagePair[];
  initialIndex?: number;
}

/**
 * Tool Call Panel Component
 */
export function ToolCallPanel({
  visible,
  onClose,
  toolMessages,
  initialIndex = 0,
}: ToolCallPanelProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['85%'], []);
  const { colorScheme } = useColorScheme();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  // Reset index when panel opens
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

  // Get current tool data
  const currentPair = toolMessages[currentIndex];
  
  const toolData = useMemo(() => {
    if (!currentPair?.toolMessage) return null;
    return parseToolMessage(currentPair.toolMessage.content);
  }, [currentPair]);

  const { toolName } = toolData || { toolName: 'Error' };

  const ToolViewComponent = useMemo(() => {
    return getToolViewComponent(toolName);
  }, [toolName]);

  // Navigation handlers
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
      backgroundStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF'
      }}
      handleIndicatorStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
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
      {/* Header */}
      <View className="border-b border-border bg-card px-6 pb-4 pt-6">
        <View className="flex-row items-center justify-between">
          <View className="flex-1">
            <Text className="text-lg font-roobert-semibold text-foreground" numberOfLines={1}>
              {toolName}
            </Text>
          </View>

          <Pressable
            onPress={handleClose}
            className="p-2 rounded-full bg-secondary active:bg-secondary/80"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon as={X} size={20} className="text-foreground/60" />
          </Pressable>
        </View>
      </View>

      {/* Content */}
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
          />
        )}
      </BottomSheetScrollView>

      {/* Footer Navigation */}
      {toolMessages.length > 1 && (
        <View className="border-t border-border bg-card px-6 py-3">
          <View className="flex-row items-center justify-between">
            {/* Previous Button */}
            <Pressable
              onPress={handlePrev}
              disabled={isPrevDisabled}
              className={`flex-row items-center px-4 py-2 rounded-xl ${
                isPrevDisabled
                  ? 'bg-secondary/50 opacity-40'
                  : 'bg-secondary active:bg-secondary/80'
              }`}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Icon 
                as={ChevronLeft} 
                size={16} 
                className={isPrevDisabled ? 'text-foreground/30' : 'text-foreground/60'} 
              />
              <Text 
                className={`text-sm ml-1 font-roobert-medium ${
                  isPrevDisabled 
                    ? 'text-foreground/30' 
                    : 'text-foreground/60'
                }`}
              >
                Prev
              </Text>
            </Pressable>

            {/* Counter */}
            <View className="px-4">
              <Text className="text-sm font-roobert-semibold text-foreground tabular-nums">
                {currentIndex + 1}/{toolMessages.length}
              </Text>
            </View>

            {/* Next Button */}
            <Pressable
              onPress={handleNext}
              disabled={isNextDisabled}
              className={`flex-row items-center px-4 py-2 rounded-xl ${
                isNextDisabled
                  ? 'bg-secondary/50 opacity-40'
                  : 'bg-secondary active:bg-secondary/80'
              }`}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text 
                className={`text-sm mr-1 font-roobert-medium ${
                  isNextDisabled
                    ? 'text-foreground/30' 
                    : 'text-foreground/60'
                }`}
              >
                Next
              </Text>
              <Icon 
                as={ChevronRight} 
                size={16} 
                className={isNextDisabled ? 'text-foreground/30' : 'text-foreground/60'} 
              />
            </Pressable>
          </View>
        </View>
      )}
    </BottomSheet>
  );
}
