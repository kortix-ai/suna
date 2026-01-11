import React, { useState, useMemo, useCallback } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import type { UnifiedMessage } from '@/api/types';
import { extractToolCallAndResult } from '@/lib/utils/tool-data-extractor';
import { getToolViewComponent } from './tool-views';
import { ToolHeader } from './tool-views/shared/ToolHeader';
import { getToolMetadata } from './tool-views/tool-metadata';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { X, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { log } from '@/lib/logger';

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
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  React.useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      log.log('📳 Haptic Feedback: Tool Drawer Opened');
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
      log.log('◀️ Tool Navigation: Previous', { from: currentIndex, to: currentIndex - 1 });
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex < toolMessages.length - 1) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      log.log('▶️ Tool Navigation: Next', { from: currentIndex, to: currentIndex + 1 });
      setCurrentIndex(currentIndex + 1);
    }
  }, [currentIndex, toolMessages.length]);

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    log.log('❌ Tool Drawer Closed');
    onClose();
  }, [onClose]);

  // Handler to auto-fill chat input - closes panel and fills input
  const handlePromptFill = useCallback((prompt: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    log.log('📝 Prompt fill triggered:', prompt);
    onClose(); // Close the panel first
    onPromptFill?.(prompt); // Then fill the chat input
  }, [onClose, onPromptFill]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.7}
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
      handleIndicatorStyle={{
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
      }}
    >
      <BottomSheetScrollView
        className="flex-1 bg-background"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: 20,
        }}
      >
        {!currentPair || !toolCall || !toolCall.function_name ? (
          <View className="flex-1 justify-center items-center px-6 py-12">
            <Text className="text-primary font-roobert-semibold text-lg mb-4">
              Error Loading Tool Data
            </Text>
            <Text className="text-primary opacity-50 text-center font-roobert">
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
              threadId={currentPair.toolMessage?.thread_id || currentPair.assistantMessage?.thread_id}
              onPromptFill={handlePromptFill}
            />
          </View>
        )}
      </BottomSheetScrollView>

      {toolMessages.length > 1 && (
        <View
          className="px-6 pt-3 border-t border-border bg-background"
          style={{
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
                className="text-background"
              />
              <Text className="text-sm font-roobert-medium text-background">
                Prev
              </Text>
            </Button>

            <View className="px-2">
              <Text className="text-sm font-roobert-semibold text-primary tabular-nums">
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
              <Text className="text-sm font-roobert-medium text-background">
                Next
              </Text>
              <Icon
                as={ChevronRight}
                size={14}
                className="text-background"
              />
            </Button>
          </View>
        </View>
      )}
    </BottomSheet>
  );
}
