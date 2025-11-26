import * as React from 'react';
import { View, KeyboardAvoidingView, Platform, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import { ChatInput, type ChatInputRef } from '../ChatInput';
import { AttachmentBar } from '@/components/attachments';
import { QuickActionBar } from '@/components/quick-actions';
import type { Agent } from '@/api/types';
import type { Attachment } from '@/hooks/useChat';

export interface ChatInputSectionProps {
  // Chat input props
  value: string;
  onChangeText: (text: string) => void;
  onSendMessage: (content: string, agentId: string, agentName: string) => void;
  onSendAudio: (uri: string) => Promise<void>;
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

// Empty function for onSendAudio - stable reference
const NOOP_SEND_AUDIO = async () => {};

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
  isAgentRunning,
  onStopAgentRun,
  style,
  isAuthenticated,
  isSendingMessage,
  isTranscribing,
  containerClassName = "mx-3 mb-8",
}, ref) => {
  const { colorScheme } = useColorScheme();
  const chatInputRef = React.useRef<ChatInputRef>(null);
  
  // Memoize gradient colors based on color scheme
  const gradientColors = React.useMemo(
    () => colorScheme === 'dark' ? DARK_GRADIENT_COLORS : LIGHT_GRADIENT_COLORS,
    [colorScheme]
  );

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
      
      {/* Quick Action Bar - Above everything */}
      {onQuickActionPress && (
        <View className="pb-2" pointerEvents="box-none">
          <QuickActionBar 
            onActionPress={onQuickActionPress}
            selectedActionId={selectedQuickAction}
            selectedOptionId={selectedQuickActionOption}
            onSelectOption={onQuickActionSelectOption}
            onSelectPrompt={onQuickActionSelectPrompt}
          />
        </View>
      )}

      {/* Attachment Bar - Above Input */}
      <AttachmentBar 
        attachments={attachments}
        onRemove={onRemoveAttachment}
      />
      
      {/* Chat Input */}
      <View className={containerClassName}>
        <ChatInput
          ref={chatInputRef}
          value={value}
          onChangeText={onChangeText}
          onSendMessage={onSendMessage}
          onSendAudio={NOOP_SEND_AUDIO}
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
    </KeyboardAvoidingView>
  );
}));

ChatInputSection.displayName = 'ChatInputSection';
