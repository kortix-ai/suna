import * as React from 'react';
import { View, KeyboardAvoidingView, Platform, ViewStyle, Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import { ChatInput, type ChatInputRef } from '../ChatInput';
import { AttachmentBar } from '@/components/attachments';
import { QuickActionBar, QuickActionExpandedView, QUICK_ACTIONS } from '@/components/quick-actions';
import { useLanguage } from '@/contexts';
import type { Agent } from '@/api/types';
import type { Attachment } from '@/hooks/useChat';

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
}

export interface ChatInputSectionRef {
  focusInput: () => void;
}

// Gradient colors defined outside component for stable reference
const DARK_GRADIENT_COLORS = ['rgba(18, 18, 21, 0)', 'rgba(18, 18, 21, 0.85)', 'rgba(18, 18, 21, 1)'] as const;
const LIGHT_GRADIENT_COLORS = ['rgba(248, 248, 248, 0)', 'rgba(248, 248, 248, 0.85)', 'rgba(248, 248, 248, 1)'] as const;
const GRADIENT_LOCATIONS = [0, 0.4, 1] as const;
const GRADIENT_STYLE = {
  position: 'absolute' as const,
  bottom: 0,
  left: 0,
  right: 0,
  height: 250,
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
}, ref) => {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const chatInputRef = React.useRef<ChatInputRef>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = React.useState(false);

  // Track keyboard visibility
  React.useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardWillShow', () => {
      setIsKeyboardVisible(true);
    });
    const hideSubscription = Keyboard.addListener('keyboardWillHide', () => {
      setIsKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

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

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="absolute bottom-0 left-0 right-0"
      keyboardVerticalOffset={0}
    >
      {/* Gradient fade from transparent to background */}
      <LinearGradient
        colors={gradientColors as unknown as string[]}
        locations={GRADIENT_LOCATIONS as unknown as number[]}
        style={GRADIENT_STYLE}
        pointerEvents="none"
      />

      {/* Attachment Bar - Above everything */}
      <AttachmentBar
        attachments={attachments}
        onRemove={onRemoveAttachment}
      />

      {/* Quick Action Expanded Content - Above Input (only on home) */}
      {showQuickActions && selectedQuickAction && selectedAction && (
        <View className="mb-3">
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
        <View className="pb-8" pointerEvents="box-none">
          <QuickActionBar
            onActionPress={onQuickActionPress}
            selectedActionId={selectedQuickAction}
          />
        </View>
      )}

      {/* Safe area bottom padding (only when keyboard is NOT visible and quick actions are hidden) */}
      {!showQuickActions && !isKeyboardVisible && (
        <View style={{ paddingBottom: Math.max(insets.bottom - 8, 0) }} />
      )}
    </KeyboardAvoidingView>
  );
}));

ChatInputSection.displayName = 'ChatInputSection';
