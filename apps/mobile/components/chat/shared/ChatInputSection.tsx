import * as React from 'react';
import { View, Platform, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, interpolate, useSharedValue, withTiming } from 'react-native-reanimated';
import { ChatInput, type ChatInputRef } from '../ChatInput';
import { ToolSnack, type ToolSnackData } from '../ToolSnack';
import { AttachmentBar } from '@/components/attachments';
import { QuickActionBar, QuickActionExpandedView, QUICK_ACTIONS } from '@/components/quick-actions';
import { useLanguage } from '@/contexts';
import type { Agent } from '@/api/types';
import type { Attachment } from '@/hooks/useChat';
import { log } from '@/lib/logger';
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

  // Quick actions
  selectedQuickAction: string | null;
  selectedQuickActionOption?: string | null;
  onClearQuickAction: () => void;
  onQuickActionPress?: (actionId: string) => void;
  onQuickActionSelectOption?: (optionId: string) => void;
  onQuickActionSelectPrompt?: (prompt: string) => void;
  onQuickActionThreadPress?: (threadId: string) => void;

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

export const CHAT_INPUT_SECTION_HEIGHT = {
  INPUT: 140,
  QUICK_ACTIONS_BAR: 80,
  ATTACHMENT_BAR: 80,
  THREAD_PAGE: 140 + 20,
  HOME_PAGE: 140 + 80 + 40,
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

  const quickActionsPaddingClosed = Math.max(insets.bottom, 24) + 16;
  const quickActionsPaddingOpened = 8;
  const nonQuickActionsPaddingClosed = Math.max(insets.bottom, 8);
  const nonQuickActionsPaddingOpened = 8;

  const quickActionsAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom: interpolate(
      progress.value,
      [0, 1],
      [quickActionsPaddingClosed, quickActionsPaddingOpened]
    ),
  }), [quickActionsPaddingClosed]);

  const bottomSpacingAnimatedStyle = useAnimatedStyle(() => ({
    height: interpolate(
      progress.value,
      [0, 1],
      [nonQuickActionsPaddingClosed, nonQuickActionsPaddingOpened]
    ),
  }), [nonQuickActionsPaddingClosed]);

  const selectedAction = React.useMemo(() => {
    if (!selectedQuickAction) return null;
    return QUICK_ACTIONS.find(a => a.id === selectedQuickAction) || null;
  }, [selectedQuickAction]);

  const selectedActionLabel = React.useMemo(() => {
    if (!selectedAction) return '';
    return t(`quickActions.${selectedAction.id}`, { defaultValue: selectedAction.label });
  }, [selectedAction, t]);

  const shouldShowExpandedView = showQuickActions && selectedQuickAction && selectedQuickAction !== 'general' && selectedAction;
  const [renderExpandedView, setRenderExpandedView] = React.useState(shouldShowExpandedView);
  
  const expandedViewOpacity = useSharedValue(shouldShowExpandedView ? 1 : 0);
  
  React.useEffect(() => {
    if (shouldShowExpandedView) {
      setRenderExpandedView(true);
      expandedViewOpacity.value = withTiming(1, { duration: 200 });
    } else {
      expandedViewOpacity.value = withTiming(0, { duration: 200 }, () => {
        setRenderExpandedView(false);
      });
    }
  }, [shouldShowExpandedView, expandedViewOpacity]);

  const expandedViewStyle = useAnimatedStyle(() => ({
    opacity: expandedViewOpacity.value,
    pointerEvents: expandedViewOpacity.value > 0 ? 'auto' : 'none',
  }), []);


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
      <View style={{ 
        backgroundColor: Platform.OS === 'ios' 
          ? 'transparent' 
          : getBackgroundColor(Platform.OS, colorScheme),
        overflow: 'hidden',
      }}>
        <AttachmentBar
          attachments={attachments}
          onRemove={onRemoveAttachment}
        />
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
        {renderExpandedView && (
          <Animated.View 
            className="mb-3" 
            collapsable={false}
            style={expandedViewStyle}
          >
            <QuickActionExpandedView
              actionId={selectedQuickAction!}
              actionLabel={selectedActionLabel}
              onSelectOption={(optionId) => onQuickActionSelectOption?.(optionId)}
              selectedOptionId={selectedQuickActionOption}
              onSelectPrompt={onQuickActionSelectPrompt}
              onThreadPress={onQuickActionThreadPress}
            />
          </Animated.View>
        )}
        <View className={containerClassName}>
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

        {!showQuickActions && (
          <Animated.View style={bottomSpacingAnimatedStyle} />
        )}
      </View>
    </KeyboardStickyView>
  );
}));

ChatInputSection.displayName = 'ChatInputSection';
