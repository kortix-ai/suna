import React, { useState, useMemo, useCallback } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import type { UnifiedMessage } from '@/api/types';
import { extractToolCallAndResult } from '@/lib/utils/tool-data-extractor';
import { getToolViewComponent } from './tool-views';
import { ToolHeader } from './tool-views/ToolHeader';
import { getToolMetadata } from './tool-views/tool-metadata';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  project?: {
    id: string;
    name: string;
    sandbox?: {
      vnc_preview?: string;
      sandbox_url?: string;
      id?: string;
      pass?: string;
    };
  };
  /** Handler to auto-fill chat input with a prompt (closes panel and fills input) */
  onPromptFill?: (prompt: string) => void;
}

export function ToolCallPanel({
  visible,
  onClose,
  toolMessages,
  initialIndex = 0,
  project,
  onPromptFill,
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

  // Extract tool call and tool result from messages
  const { toolCall, toolResult, isSuccess, assistantTimestamp, toolTimestamp } = useMemo(() => {
    if (!currentPair?.toolMessage) return { toolCall: null, toolResult: null, isSuccess: false, assistantTimestamp: undefined, toolTimestamp: undefined };
    return extractToolCallAndResult(currentPair.assistantMessage, currentPair.toolMessage);
  }, [currentPair]);

  const toolName = useMemo(() => {
    if (!toolCall || !toolCall.function_name) return 'Error';
    return toolCall.function_name.replace(/_/g, '-');
  }, [toolCall]);

  const ToolViewComponent = useMemo(() => {
    return getToolViewComponent(toolName);
  }, [toolName]);

  // Get tool metadata for header
  const toolMetadata = useMemo(() => {
    if (!toolCall || !toolCall.function_name) return null;
    const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
      ? toolCall.arguments
      : typeof toolCall.arguments === 'string'
        ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
        : {};
    return getToolMetadata(toolCall.function_name, args);
  }, [toolCall]);

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

  // Handler to auto-fill chat input - closes panel and fills input
  const handlePromptFill = useCallback((prompt: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    console.log('📝 Prompt fill triggered:', prompt);
    onClose(); // Close the panel first
    onPromptFill?.(prompt); // Then fill the chat input
  }, [onClose, onPromptFill]);

  const isDark = colorScheme === 'dark';

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={isDark ? 0.8 : 0.5}
        pressBehavior="close"
      />
    ),
    [isDark]
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
        backgroundColor: isDark ? '#1a1a1c' : '#ffffff',
      }}
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3a3a3c' : '#d1d1d6',
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
        overflow: 'hidden',
        backgroundColor: isDark ? '#1a1a1c' : '#ffffff',
      }}
    >
      <BottomSheetScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: 20,
          backgroundColor: isDark ? '#1a1a1c' : '#ffffff',
        }}
      >
        {!currentPair || !toolCall || !toolCall.function_name ? (
          <View className="flex-1 justify-center items-center px-6 py-12">
            <Text className="text-foreground font-roobert-semibold text-lg mb-4">
              Error Loading Tool Data
            </Text>
            <Text className="text-foreground/60 text-center font-roobert">
              Unable to parse tool execution data
            </Text>
          </View>
        ) : (
          <View className="flex-1">
            {/* Standardized Tool Header */}
            {toolMetadata && (
              <View className="px-6 pt-4 pb-6">
                <ToolHeader
                  icon={toolMetadata.icon}
                  iconColor={toolMetadata.iconColor}
                  iconBgColor={toolMetadata.iconBgColor}
                  subtitle={toolMetadata.subtitle}
                  title={toolMetadata.title}
                  isSuccess={toolResult?.success !== false}
                  showStatus={true}
                  isStreaming={false}
                />
              </View>
            )}

            {/* Tool View Content */}
            <ToolViewComponent
              toolCall={toolCall}
              toolResult={toolResult || undefined}
              assistantMessage={currentPair.assistantMessage}
              toolMessage={currentPair.toolMessage}
              assistantTimestamp={currentPair.assistantMessage?.created_at}
              toolTimestamp={currentPair.toolMessage?.created_at}
              isSuccess={toolResult?.success !== false}
              currentIndex={currentIndex}
              totalCalls={toolMessages.length}
              project={project}
              onPromptFill={handlePromptFill}
            />
          </View>
        )}
      </BottomSheetScrollView>

      {toolMessages.length > 1 && (
        <View
          className="px-6 border-t border-border"
          style={{
            paddingTop: 12,
            paddingBottom: Math.max(insets.bottom, 12),
            backgroundColor: isDark ? '#1a1a1c' : '#ffffff',
            borderTopColor: isDark ? '#2a2a2c' : '#e5e5e7',
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
