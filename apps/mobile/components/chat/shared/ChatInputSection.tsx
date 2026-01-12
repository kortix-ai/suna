import * as React from 'react';
import { View, Platform, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { ChatInput, type ChatInputRef } from '../ChatInput';
import { ToolSnack, type ToolSnackData } from '../ToolSnack';
import { AttachmentBar } from '@/components/attachments';
import { QuickActionBar, QuickActionExpandedView, QUICK_ACTIONS } from '@/components/quick-actions';
import { useLanguage } from '@/contexts';
import type { Agent } from '@/api/types';
import type { Attachment } from '@/hooks/useChat';
import { log } from '@/lib/logger';

export interface ChatInputSectionProps {
  // Chat input props
  value: string;
  onChangeText: (text: string) => void;
  onSendMessage: (content: string, agentId: string, agentName: string) => void;
  onSendAudio: () => Promise<void>;
  placeholder: string;
  agent?: Agent;

  // Attachment props
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  onAttachPress: () => void;

  // Agent selection
  onAgentPress: () => void;

  style?: ViewStyle;

  // Audio recording
  onAudioRecord: () => Promise<void>;
  onCancelRecording: () => void;
  isRecording: boolean;
  recordingDuration: number;
  audioLevel: number;
  audioLevels: number[];

  // Quick actions
  selectedQuickAction: string | null;
  selectedQuickActionOption?: string | null;
  onClearQuickAction: () => void;
  onQuickActionPress?: (actionId: string) => void;
  onQuickActionSelectOption?: (optionId: string) => void;
  onQuickActionSelectPrompt?: (prompt: string) => void;
  onQuickActionThreadPress?: (threadId: string) => void;

  // Agent running state
  isAgentRunning: boolean;
  onStopAgentRun: () => void;

  // Auth
  isAuthenticated: boolean;

  // Loading states
  isSendingMessage: boolean;
  isTranscribing: boolean;

  // Container styles
  containerClassName?: string;

  // Show quick actions (mode selector)
  showQuickActions?: boolean;

  // Tool Snack props (only shown in thread view, not home)
  /** Current/last tool data for the snack display (persisted by parent) */
  activeToolData?: ToolSnackData | null;
  /** Agent name for the snack status text */
  agentName?: string;
  /** Callback when pressing the tool snack to expand */
  onToolSnackPress?: () => void;
  /** Callback when user swipes to dismiss the tool snack */
  onToolSnackDismiss?: () => void;
}

export interface ChatInputSectionRef {
  focusInput: () => void;
}

// Background colors for the solid input area
const DARK_BACKGROUND = '#121215';
const LIGHT_BACKGROUND = '#F8F8F8';

// Gradient colors - fade from transparent to solid background
const DARK_GRADIENT_COLORS = ['rgba(18, 18, 21, 0)', 'rgba(18, 18, 21, 0.8)', 'rgba(18, 18, 21, 1)'] as const;
const LIGHT_GRADIENT_COLORS = ['rgba(248, 248, 248, 0)', 'rgba(248, 248, 248, 0.8)', 'rgba(248, 248, 248, 1)'] as const;
const GRADIENT_LOCATIONS = [0, 0.4, 1] as const;

// Gradient height - just for the fade effect above the solid area
const GRADIENT_HEIGHT = 60;

/**
 * Height constants for ChatInputSection
 * Used by parent components to calculate proper content padding
 * 
 * Layout structure:
 * - Gradient fade (60px) - at top, creates smooth transition
 * - Solid background area - contains all input elements
 */
export const CHAT_INPUT_SECTION_HEIGHT = {
  /** Gradient fade height at top */
  GRADIENT: GRADIENT_HEIGHT,
  /** Base height of chat input card */
  INPUT: 140,
  /** Additional height when quick actions bar is shown */
  QUICK_ACTIONS_BAR: 80,
  /** Height of attachment bar when attachments exist */
  ATTACHMENT_BAR: 80,
  /** 
   * Total height for ThreadPage (gradient + input + margins)
   * Used for ScrollView paddingBottom calculation
   */
  THREAD_PAGE: GRADIENT_HEIGHT + 140 + 20, // gradient + input + bottom margin
  /** 
   * Total height for HomePage (includes quick actions)
   */
  HOME_PAGE: GRADIENT_HEIGHT + 140 + 80 + 40, // gradient + input + quick actions + margins
};


/**
 * ChatInputSection Component
 * 
 * Shared bottom section for HomePage and ThreadPage containing:
 * - Gradient overlay
 * - Attachment bar
 * - Chat input
 * - Keyboard animation handling
 * 
 * KEYBOARD HANDLING:
 * - Uses KeyboardStickyView from react-native-keyboard-controller
 * - Provides native-driven 60fps animations that sync with keyboard
 * - Positioned absolute at bottom, moves up with keyboard via translateY
 * 
 * Optimized with memoization to prevent unnecessary re-renders.
 */
export const ChatInputSection = React.memo(React.forwardRef<ChatInputSectionRef, ChatInputSectionProps>(({
  value,
  onChangeText,
  onSendMessage,
  onSendAudio,
  placeholder,
  agent,
  attachments,
  onRemoveAttachment,
  onAttachPress,
  onAgentPress,
  onAudioRecord,
  onCancelRecording,
  isRecording,
  recordingDuration,
  audioLevel,
  audioLevels,
  selectedQuickAction,
  selectedQuickActionOption,
  onClearQuickAction,
  onQuickActionPress,
  onQuickActionSelectOption,
  onQuickActionSelectPrompt,
  onQuickActionThreadPress,
  isAgentRunning,
  onStopAgentRun,
  style,
  isAuthenticated,
  isSendingMessage,
  isTranscribing,
  containerClassName = "mx-3 mb-4",
  showQuickActions = false,
  activeToolData,
  agentName,
  onToolSnackPress,
  onToolSnackDismiss,
}, ref) => {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const chatInputRef = React.useRef<ChatInputRef>(null);
  
  // Get keyboard animation progress for smooth padding transitions
  // progress goes from 0 (closed) to 1 (open)
  const { progress } = useReanimatedKeyboardAnimation();

  // Calculate padding values
  const quickActionsPaddingClosed = Math.max(insets.bottom, 24) + 16;
  const quickActionsPaddingOpened = 8;
  const nonQuickActionsPaddingClosed = Math.max(insets.bottom, 8);
  const nonQuickActionsPaddingOpened = 8;

  // Animated style for quick actions bar bottom padding
  // Smoothly interpolates between open and closed values
  const quickActionsAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom: interpolate(
      progress.value,
      [0, 1],
      [quickActionsPaddingClosed, quickActionsPaddingOpened]
    ),
  }), [quickActionsPaddingClosed]);

  // Animated style for non-quick-actions bottom spacing
  const bottomSpacingAnimatedStyle = useAnimatedStyle(() => ({
    height: interpolate(
      progress.value,
      [0, 1],
      [nonQuickActionsPaddingClosed, nonQuickActionsPaddingOpened]
    ),
  }), [nonQuickActionsPaddingClosed]);

  // Memoize gradient colors based on color scheme
  const gradientColors = React.useMemo(
    () => colorScheme === 'dark' ? DARK_GRADIENT_COLORS : LIGHT_GRADIENT_COLORS,
    [colorScheme]
  );

  // Find selected action for expanded view
  const selectedAction = React.useMemo(() => {
    if (!selectedQuickAction) return null;
    return QUICK_ACTIONS.find(a => a.id === selectedQuickAction) || null;
  }, [selectedQuickAction]);

  // Get translated label for the selected action
  const selectedActionLabel = React.useMemo(() => {
    if (!selectedAction) return '';
    return t(`quickActions.${selectedAction.id}`, { defaultValue: selectedAction.label });
  }, [selectedAction, t]);

  // Expose focus method via ref
  React.useImperativeHandle(ref, () => ({
    focusInput: () => {
      chatInputRef.current?.focus();
    },
  }), []);

  // Get background color based on theme
  const backgroundColor = colorScheme === 'dark' ? DARK_BACKGROUND : LIGHT_BACKGROUND;

  return (
    <KeyboardStickyView
      style={[
        // Base positioning - absolute at bottom of screen
        {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
        } as ViewStyle,
        // Ensure proper z-ordering on both platforms
        { zIndex: 100 },
        Platform.OS === 'android' ? { elevation: 10 } : undefined,
      ]}
    >
      {/* Gradient fade at top - creates smooth transition from content to input area */}
      <LinearGradient
        colors={[...gradientColors]}
        locations={[...GRADIENT_LOCATIONS]}
        style={{
          height: GRADIENT_HEIGHT,
        }}
        pointerEvents="none"
      />

      {/* Solid background container - ensures input is always on top of content */}
      <View style={{ backgroundColor }}>
        {/* Attachment Bar */}
        <AttachmentBar
          attachments={attachments}
          onRemove={onRemoveAttachment}
        />

        {/* Tool Snack - Above Input (only in thread view, not home) */}
        {(() => {
          log.log('[ChatInputSection] ToolSnack check - showQuickActions:', showQuickActions, 'activeToolData:', activeToolData?.toolName || 'null');
          return null;
        })()}
        {!showQuickActions && (
          <ToolSnack
            toolData={activeToolData || null}
            isAgentRunning={isAgentRunning}
            agentName={agentName}
            onPress={onToolSnackPress}
            onDismiss={onToolSnackDismiss}
          />
        )}

        {/* Quick Action Expanded Content - Above Input (only on home) */}
        {showQuickActions && selectedQuickAction && selectedAction && (
          <View className="mb-3" collapsable={false}>
            <QuickActionExpandedView
              actionId={selectedQuickAction}
              actionLabel={selectedActionLabel}
              onSelectOption={(optionId) => onQuickActionSelectOption?.(optionId)}
              selectedOptionId={selectedQuickActionOption}
              onSelectPrompt={onQuickActionSelectPrompt}
              onThreadPress={onQuickActionThreadPress}
            />
          </View>
        )}

        {/* Chat Input */}
        <View className={containerClassName}>
          <ChatInput
            ref={chatInputRef}
            value={value}
            onChangeText={onChangeText}
            onSendMessage={onSendMessage}
            onSendAudio={onSendAudio}
            onAttachPress={onAttachPress}
            onAgentPress={onAgentPress}
            onAudioRecord={onAudioRecord}
            onCancelRecording={onCancelRecording}
            onStopAgentRun={onStopAgentRun}
            placeholder={placeholder}
            agent={agent}
            isRecording={isRecording}
            recordingDuration={recordingDuration}
            audioLevel={audioLevel}
            audioLevels={audioLevels}
            attachments={attachments}
            onRemoveAttachment={onRemoveAttachment}
            selectedQuickAction={selectedQuickAction}
            selectedQuickActionOption={selectedQuickActionOption}
            onClearQuickAction={onClearQuickAction}
            isAuthenticated={isAuthenticated}
            isAgentRunning={isAgentRunning}
            isSendingMessage={isSendingMessage}
            isTranscribing={isTranscribing}
          />
        </View>

        {/* Quick Action Bar - Below input (camera-style mode selector, only on home) */}
        {showQuickActions && onQuickActionPress && (
          <Animated.View 
            style={quickActionsAnimatedStyle}
            pointerEvents="box-none" 
            collapsable={false}
          >
            <QuickActionBar
              onActionPress={onQuickActionPress}
              selectedActionId={selectedQuickAction}
            />
          </Animated.View>
        )}

        {/* Safe area bottom padding - animates smoothly with keyboard */}
        {/* When keyboard is open, it covers the bottom safe area so less padding is needed */}
        {!showQuickActions && (
          <Animated.View style={bottomSpacingAnimatedStyle} />
        )}
      </View>
    </KeyboardStickyView>
  );
}));

ChatInputSection.displayName = 'ChatInputSection';
