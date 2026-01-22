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
import { QuickActionBar } from '@/components/quick-actions';
import { useLanguage } from '@/contexts';
import type { Agent } from '@/api/types';
import type { Attachment } from '@/hooks/useChat';
import { log } from '@/lib/logger';
import { BlurFooter } from '@/components/ui';
import { getBackgroundColor } from '@agentpress/shared';

export interface ChatInputSectionProps {
  value: string;
  onChangeText: (text: string) => void;
  onSendMessage: (content: string, agentId: string, agentName: string) => void;
  onSendAudio: () => Promise<void>;
  placeholder: string;
  agent?: Agent;

  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  onAttachPress: () => void;
  onTakePicture?: () => void;
  onChooseImages?: () => void;
  onChooseFiles?: () => void;
  onAgentPress: () => void;
  onIntegrationsPress?: () => void;

  style?: ViewStyle;
  isNewThread?: boolean;

  onAudioRecord: () => Promise<void>;
  onCancelRecording: () => void;
  isRecording: boolean;
  recordingDuration: number;
  audioLevel: number;
  audioLevels: number[];

  onQuickActionSelectMode?: (modeId: string, prompt: string) => void;

  isAgentRunning: boolean;
  onStopAgentRun: () => void;

  isAuthenticated: boolean;
  isSendingMessage: boolean;
  isTranscribing: boolean;

  containerClassName?: string;
  showQuickActions?: boolean;

  activeToolData?: ToolSnackData | null;
  agentName?: string;
  onToolSnackPress?: () => void;
  onToolSnackDismiss?: () => void;
}

export interface ChatInputSectionRef {
  focusInput: () => void;
}

const DARK_BACKGROUND = '#121215';
const LIGHT_BACKGROUND = '#F8F8F8';

const DARK_GRADIENT_COLORS = ['rgba(18, 18, 21, 0)', 'rgba(18, 18, 21, 0.8)', 'rgba(18, 18, 21, 1)'] as const;
const LIGHT_GRADIENT_COLORS = ['rgba(248, 248, 248, 0)', 'rgba(248, 248, 248, 0.8)', 'rgba(248, 248, 248, 1)'] as const;
const GRADIENT_LOCATIONS = [0, 0.4, 1] as const;

const GRADIENT_HEIGHT = 60;

export const CHAT_INPUT_SECTION_HEIGHT = {
  GRADIENT: GRADIENT_HEIGHT,
  INPUT: 140,
  QUICK_ACTIONS_BAR: 80,
  ATTACHMENT_BAR: 80,
  THREAD_PAGE: GRADIENT_HEIGHT + 140 + 20,
  HOME_PAGE: GRADIENT_HEIGHT + 140 + 80 + 40,
};


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
  onTakePicture,
  onChooseImages,
  onChooseFiles,
  onAgentPress,
  onIntegrationsPress,
  onAudioRecord,
  onCancelRecording,
  isRecording,
  recordingDuration,
  audioLevel,
  audioLevels,
  onQuickActionSelectMode,
  isAgentRunning,
  onStopAgentRun,
  style,
  isAuthenticated,
  isSendingMessage,
  isTranscribing,
  containerClassName = "mx-3",
  showQuickActions = false,
  activeToolData,
  agentName,
  onToolSnackPress,
  onToolSnackDismiss,
  isNewThread = false,
}, ref) => {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const chatInputRef = React.useRef<ChatInputRef>(null);

  const [keyboardTrackingEnabled, setKeyboardTrackingEnabled] = React.useState(() => !isNewThread);

  React.useEffect(() => {
    if (isNewThread) {
      setKeyboardTrackingEnabled(false);
      const timer = setTimeout(() => {
        setKeyboardTrackingEnabled(true);
      }, 350);
      return () => clearTimeout(timer);
    } else {
      setKeyboardTrackingEnabled(true);
    }
  }, [isNewThread]);

  const { progress } = useReanimatedKeyboardAnimation();

  const nonQuickActionsPaddingClosed = 24;
  const nonQuickActionsPaddingOpened = 8;

  const bottomSpacingAnimatedStyle = useAnimatedStyle(() => ({
    height: interpolate(
      progress.value,
      [0, 1],
      [nonQuickActionsPaddingClosed, nonQuickActionsPaddingOpened]
    ),
  }), [nonQuickActionsPaddingClosed]);


  React.useImperativeHandle(ref, () => ({
    focusInput: () => {
      chatInputRef.current?.focus();
    },
  }), []);

  const backgroundColor = colorScheme === 'dark' ? DARK_BACKGROUND : LIGHT_BACKGROUND;
  const stickyViewKey = keyboardTrackingEnabled ? 'kb-enabled' : 'kb-disabled';

  return (
    <KeyboardStickyView
      key={stickyViewKey}
      enabled={keyboardTrackingEnabled}
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
        } as ViewStyle,
        { zIndex: 100 },
        Platform.OS === 'android' ? { elevation: 10 } : undefined,
      ]}
    >


      {!showQuickActions && (
          <ToolSnack
            toolData={activeToolData || null}
            isAgentRunning={isAgentRunning}
            agentName={agentName}
            onPress={onToolSnackPress}
            onDismiss={onToolSnackDismiss}
          />
        )}

      <BlurFooter height={GRADIENT_HEIGHT + 40} intensity={100} />

      <View style={{ 
        backgroundColor: Platform.OS === 'ios' 
          ? 'transparent' 
          : getBackgroundColor(Platform.OS, colorScheme),
        overflow: 'hidden',
      }}>
        {(() => {
          log.log('[ChatInputSection] ToolSnack check - showQuickActions:', showQuickActions, 'activeToolData:', activeToolData?.toolName || 'null');
          return null;
        })()}
        
        <View className={showQuickActions ? "mx-3 mb-6 -mt-1" : containerClassName} style={{ overflow: 'hidden' }}>
          {showQuickActions && (
            <View className="px-3 mb-6" style={{ zIndex: 9999 }}>
              <QuickActionBar
                onSelectMode={onQuickActionSelectMode}
              />
            </View>
          )}
          <ChatInput
            ref={chatInputRef}
            value={value}
            onChangeText={onChangeText}
            onSendMessage={onSendMessage}
            onSendAudio={onSendAudio}
            onAttachPress={onAttachPress}
            onTakePicture={onTakePicture}
            onChooseImages={onChooseImages}
            onChooseFiles={onChooseFiles}
            onAgentPress={onAgentPress}
            onIntegrationsPress={onIntegrationsPress}
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
            isAuthenticated={isAuthenticated}
            isAgentRunning={isAgentRunning}
            isSendingMessage={isSendingMessage}
            isTranscribing={isTranscribing}
          />

        </View>
        {!showQuickActions && (
          <Animated.View style={bottomSpacingAnimatedStyle} />
        )}
      </View>
    </KeyboardStickyView>
  );
}));

ChatInputSection.displayName = 'ChatInputSection';
