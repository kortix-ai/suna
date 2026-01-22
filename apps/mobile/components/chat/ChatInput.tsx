import * as React from 'react';
import { Keyboard, Pressable, TextInput, View, Platform, TouchableOpacity } from 'react-native';
import { BlurView } from 'expo-blur';
import { useColorScheme } from 'nativewind';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, interpolate } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { StopIcon } from '@/components/ui/StopIcon';
import { AudioLines, CornerDownLeft, Paperclip, X } from 'lucide-react-native';
import { AttachmentBar } from '../attachments/AttachmentBar';
import { AudioWaveform } from '../attachments/AudioWaveform';
import { AgentSelector } from '../agents/AgentSelector';
import { useLanguage } from '@/contexts';
import type { Attachment } from '@/hooks/useChat';
import type { Agent } from '@/api/types';
import { log } from '@/lib/logger';

let ContextMenu: React.ComponentType<any> | null = null;
if (Platform.OS !== 'web') {
  try {
    ContextMenu = require('react-native-context-menu-view').default;
  } catch (e) {
    log.warn('react-native-context-menu-view not available');
  }
}

const SWIPE_DOWN_THRESHOLD = 30;
const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 10, bottom: 10, left: 10, right: 10 } : undefined;

export interface ChatInputRef {
  focus: () => void;
}

interface ChatInputProps {
  value?: string;
  onChangeText?: (text: string) => void;
  onSendMessage?: (content: string, agentId: string, agentName: string) => void;
  onSendAudio?: () => void;
  onAttachPress?: () => void;
  onTakePicture?: () => void;
  onChooseImages?: () => void;
  onChooseFiles?: () => void;
  onAgentPress?: () => void;
  onIntegrationsPress?: () => void;
  onAudioRecord?: () => void;
  onCancelRecording?: () => void;
  onStopAgentRun?: () => void;
  placeholder?: string;
  agent?: Agent;
  isRecording?: boolean;
  recordingDuration?: number;
  audioLevel?: number;
  audioLevels?: number[];
  attachments?: Attachment[];
  onRemoveAttachment?: (index: number) => void;
  isAuthenticated?: boolean;
  isAgentRunning?: boolean;
  isSendingMessage?: boolean;
  isTranscribing?: boolean;
}

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const ChatInput = React.memo(
  React.forwardRef<ChatInputRef, ChatInputProps>(
    (
      {
        value = '',
        onChangeText,
        onSendMessage,
        onSendAudio,
        onAttachPress,
        onTakePicture,
        onChooseImages,
        onChooseFiles,
        onAgentPress,
        onIntegrationsPress,
        onAudioRecord,
        onCancelRecording,
        onStopAgentRun,
        placeholder,
        agent,
        isRecording = false,
        recordingDuration = 0,
        audioLevel = 0,
        audioLevels = [],
        attachments = [],
        onRemoveAttachment,
        isAuthenticated = true,
        isAgentRunning = false,
        isSendingMessage = false,
        isTranscribing = false,
      },
      ref
    ) => {
      const { colorScheme } = useColorScheme();
      const { t } = useLanguage();
      const textInputRef = React.useRef<TextInput>(null);
      const [textHeight, setTextHeight] = React.useState(24);

      // Reset height when input is cleared
      React.useEffect(() => {
        if (!value || value.trim().length === 0) {
          setTextHeight(24);
        }
      }, [value]);

      // Expose focus method
      React.useImperativeHandle(
        ref,
        () => ({
          focus: () => textInputRef.current?.focus(),
        }),
        []
      );

      // Computed values
      const hasContent = value.trim().length > 0 || attachments.length > 0;
      const hasAgent = !!agent?.agent_id;
      const hasUploadingFiles = attachments.some((a) => a.status === 'uploading' || a.isUploading);
      const isDisabled = isSendingMessage || isTranscribing;
      const isBusy = isAgentRunning || isSendingMessage || isTranscribing;
      const hasAttachments = attachments.length > 0;

      // Calculate dynamic height for entire container
      const SINGLE_LINE_HEIGHT = 24;
      const MAX_LINES_BEFORE_SCROLL = 4;
      const MAX_TEXT_HEIGHT_BEFORE_SCROLL = SINGLE_LINE_HEIGHT * MAX_LINES_BEFORE_SCROLL; // 96px
      const ATTACHMENTS_AREA_HEIGHT = 96; // 80px content + 12px marginTop + 4px marginBottom
      const BOTTOM_BAR_HEIGHT = 52;
      const TEXT_PADDING = 32; // 16px top + 8px bottom
      
      // Base height: padding + single line + bottom bar
      const BASE_HEIGHT = TEXT_PADDING + SINGLE_LINE_HEIGHT + BOTTOM_BAR_HEIGHT; // 100px
      
      // Text growth: from single line up to 4 lines
      const textGrowth = Math.max(0, Math.min(textHeight, MAX_TEXT_HEIGHT_BEFORE_SCROLL) - SINGLE_LINE_HEIGHT);
      
      // Attachments add their own section
      const attachmentsHeight = hasAttachments ? ATTACHMENTS_AREA_HEIGHT : 0;
      
      // Total container height
      const MAX_CONTAINER_HEIGHT = 280;
      const containerHeight = Math.min(BASE_HEIGHT + textGrowth + attachmentsHeight, MAX_CONTAINER_HEIGHT);
      
      // Max height for scrollable text area (when text exceeds 4 lines)
      const maxTextHeight = MAX_TEXT_HEIGHT_BEFORE_SCROLL;

      // Animations
      const hasContentValue = useSharedValue(hasContent ? 1 : 0);
      React.useEffect(() => {
        hasContentValue.value = withTiming(hasContent ? 1 : 0, { duration: 200 });
      }, [hasContent, hasContentValue]);

      const voiceIconStyle = useAnimatedStyle(() => ({
        opacity: interpolate(hasContentValue.value, [0, 1], [1, 0]),
        position: 'absolute' as const,
      }));

      const sendIconStyle = useAnimatedStyle(() => ({
        opacity: hasContentValue.value,
        position: 'absolute' as const,
      }));

      // Handlers
      const handleSendMessage = React.useCallback(() => {
        if (!value.trim() || !isAuthenticated || !hasAgent) return;
        onSendMessage?.(value.trim(), agent!.agent_id, agent!.name || '');
      }, [value, isAuthenticated, hasAgent, onSendMessage, agent]);

      const handleSendAudio = React.useCallback(async () => {
        if (!isAuthenticated) {
          onCancelRecording?.();
          return;
        }
        await onSendAudio?.();
      }, [isAuthenticated, onSendAudio, onCancelRecording]);

      const handleButtonPress = React.useCallback(() => {
        // Stop button - when agent is running or sending
        if (isBusy) {
          onStopAgentRun?.();
          return;
        }

        // Send audio recording
        if (isRecording) {
          handleSendAudio();
          return;
        }

        // Send message
        if (hasContent) {
          if (hasUploadingFiles || !hasAgent) return;
          handleSendMessage();
          return;
        }

        // Start recording
        if (!hasAgent || !isAuthenticated) return;
        onAudioRecord?.();
      }, [
        isBusy,
        isRecording,
        hasContent,
        hasUploadingFiles,
        hasAgent,
        isAuthenticated,
        onStopAgentRun,
        handleSendAudio,
        handleSendMessage,
        onAudioRecord,
      ]);

      // Swipe down to dismiss keyboard
      const swipeDownGesture = Gesture.Pan()
        .onEnd((event) => {
          const isDownwardSwipe = event.translationY > SWIPE_DOWN_THRESHOLD;
          const isVertical = Math.abs(event.translationY) > Math.abs(event.translationX);
          const hasDownwardVelocity = event.velocityY > 0;
          if (isDownwardSwipe && isVertical && hasDownwardVelocity) {
            Keyboard.dismiss();
          }
        })
        .minDistance(SWIPE_DOWN_THRESHOLD)
        .activeOffsetY(SWIPE_DOWN_THRESHOLD);

      const borderColor = colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)';

      return (
        <GestureDetector gesture={swipeDownGesture}>
          {Platform.OS === 'ios' ? (
            <BlurView
              intensity={80}
              tint={colorScheme === 'dark' ? 'dark' : 'light'}
              style={{
                borderRadius: 30,
                borderWidth: 0.5,
                borderColor,
                overflow: 'hidden',
                height: containerHeight,
                backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)',
              }}
            >
              <ChatInputContent
                isRecording={isRecording}
                attachments={attachments}
                onRemoveAttachment={onRemoveAttachment}
                audioLevels={audioLevels}
                recordingDuration={recordingDuration}
                isTranscribing={isTranscribing}
                onCancelRecording={onCancelRecording}
                handleSendAudio={handleSendAudio}
                textInputRef={textInputRef}
                value={value}
                onChangeText={onChangeText}
                placeholder={placeholder || t('chat.placeholder')}
                colorScheme={colorScheme}
                isDisabled={isDisabled}
                onAttachPress={onAttachPress}
                onTakePicture={onTakePicture}
                onChooseImages={onChooseImages}
                onChooseFiles={onChooseFiles}
                isAuthenticated={isAuthenticated}
                onAgentPress={onAgentPress}
                onIntegrationsPress={onIntegrationsPress}
                handleButtonPress={handleButtonPress}
                isBusy={isBusy}
                hasAgent={hasAgent}
                hasUploadingFiles={hasUploadingFiles}
                voiceIconStyle={voiceIconStyle}
                sendIconStyle={sendIconStyle}
                setTextHeight={setTextHeight}
                maxTextHeight={maxTextHeight}
              />
            </BlurView>
          ) : (
            <View
              style={{
                borderRadius: 30,
                borderWidth: 1,
                borderColor,
                overflow: 'hidden',
                height: containerHeight,
              }}
              className="bg-muted/40 backdrop-blur-sm"
            >
              <ChatInputContent
                isRecording={isRecording}
                attachments={attachments}
                onRemoveAttachment={onRemoveAttachment}
                audioLevels={audioLevels}
                recordingDuration={recordingDuration}
                isTranscribing={isTranscribing}
                onCancelRecording={onCancelRecording}
                handleSendAudio={handleSendAudio}
                textInputRef={textInputRef}
                value={value}
                onChangeText={onChangeText}
                placeholder={placeholder || t('chat.placeholder')}
                colorScheme={colorScheme}
                isDisabled={isDisabled}
                onAttachPress={onAttachPress}
                onTakePicture={onTakePicture}
                onChooseImages={onChooseImages}
                onChooseFiles={onChooseFiles}
                isAuthenticated={isAuthenticated}
                onAgentPress={onAgentPress}
                onIntegrationsPress={onIntegrationsPress}
                handleButtonPress={handleButtonPress}
                isBusy={isBusy}
                hasAgent={hasAgent}
                hasUploadingFiles={hasUploadingFiles}
                voiceIconStyle={voiceIconStyle}
                sendIconStyle={sendIconStyle}
                setTextHeight={setTextHeight}
                maxTextHeight={maxTextHeight}
              />
            </View>
          )}
        </GestureDetector>
      );
    }
  )
);

ChatInput.displayName = 'ChatInput';

// Content component
interface ChatInputContentProps {
  isRecording: boolean;
  attachments: Attachment[];
  onRemoveAttachment?: (index: number) => void;
  audioLevels: number[];
  recordingDuration: number;
  isTranscribing: boolean;
  onCancelRecording?: () => void;
  handleSendAudio: () => void;
  textInputRef: React.RefObject<TextInput | null>;
  value: string;
  onChangeText?: (text: string) => void;
  placeholder: string;
  colorScheme: 'light' | 'dark' | null | undefined;
  isDisabled: boolean;
  onAttachPress?: () => void;
  onTakePicture?: () => void;
  onChooseImages?: () => void;
  onChooseFiles?: () => void;
  isAuthenticated: boolean;
  onAgentPress?: () => void;
  onIntegrationsPress?: () => void;
  handleButtonPress: () => void;
  isBusy: boolean;
  hasAgent: boolean;
  hasUploadingFiles: boolean;
  voiceIconStyle: any;
  sendIconStyle: any;
  setTextHeight: (height: number) => void;
  maxTextHeight: number;
}

const ChatInputContent = React.memo<ChatInputContentProps>(
  ({
    isRecording,
    attachments,
    onRemoveAttachment,
    audioLevels,
    recordingDuration,
    isTranscribing,
    onCancelRecording,
    handleSendAudio,
    textInputRef,
    value,
    onChangeText,
    placeholder,
    colorScheme,
    isDisabled,
    onAttachPress,
    onTakePicture,
    onChooseImages,
    onChooseFiles,
    isAuthenticated,
    onAgentPress,
    onIntegrationsPress,
    handleButtonPress,
    isBusy,
    hasAgent,
    hasUploadingFiles,
    voiceIconStyle,
    sendIconStyle,
    setTextHeight,
    maxTextHeight,
  }) => {
    const { t } = useLanguage();
    const hasAttachments = attachments.length > 0;

    if (isRecording) {
      return (
        <View style={{ height: 120 }}>
          <View className="flex-1 items-center justify-center">
            <AudioWaveform isRecording={true} audioLevels={audioLevels} />
          </View>
          <View className="absolute bottom-6 right-16 items-center">
            <Text className="text-xs font-roobert-medium text-foreground/50">
              {isTranscribing ? 'Transcribing...' : formatDuration(recordingDuration)}
            </Text>
          </View>
          <View className="absolute bottom-4 left-4 right-4 flex-row items-center justify-between">
            <TouchableOpacity
              onPress={onCancelRecording}
              className="bg-primary/5 rounded-full items-center justify-center"
              style={{ width: 40, height: 40 }}
              hitSlop={ANDROID_HIT_SLOP}
              activeOpacity={0.7}
            >
              <Icon as={X} size={16} className="text-foreground" strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSendAudio}
              className="bg-primary rounded-full items-center justify-center"
              style={{ width: 40, height: 40 }}
              hitSlop={ANDROID_HIT_SLOP}
              activeOpacity={0.7}
            >
              <Icon as={CornerDownLeft} size={16} className="text-primary-foreground" strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    const placeholderTextColor =
      colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)';

    return (
      <>
        {hasAttachments && onRemoveAttachment && (
          <View 
            style={{ 
              height: 80,
              marginTop: 12,
              marginHorizontal: 16,
              marginBottom: 4,
              overflow: 'hidden',
            }}
          >
            <AttachmentBar attachments={attachments} onRemove={onRemoveAttachment} />
          </View>
        )}
        <View 
          style={{ 
            paddingHorizontal: 16, 
            paddingTop: hasAttachments ? 8 : 16, 
          }}
        >
          <TextInput
            ref={textInputRef}
            {...(Platform.OS === 'ios' ? { value } : { defaultValue: value })}
            onChangeText={onChangeText}
            onContentSizeChange={(e) => {
              const height = e.nativeEvent.contentSize.height;
              setTextHeight(height);
            }}
            onFocus={() => {
              if (!isAuthenticated) {
                textInputRef.current?.blur();
              }
            }}
            placeholder={placeholder}
            placeholderTextColor={placeholderTextColor}
            multiline
            scrollEnabled={true}
            editable={!isDisabled}
            className="text-foreground text-base font-roobert"
            style={{
              maxHeight: maxTextHeight,
              minHeight: 30,
              opacity: isDisabled ? 0.5 : 1,
            }}
            textAlignVertical="top"
            underlineColorAndroid="transparent"
          />
        </View>
        <View
            className="flex-row items-center justify-between"
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 52, paddingHorizontal: 16, paddingBottom: 16 }}
          >
            {ContextMenu && Platform.OS === 'ios' && onTakePicture && onChooseImages && onChooseFiles ? (
            <ContextMenu
              actions={[
                { title: t('attachments.takePicture', 'Take Picture'), systemIcon: 'camera' },
                { title: t('attachments.chooseImages', 'Choose Images'), systemIcon: 'photo' },
                { title: t('attachments.chooseFiles', 'Choose Files'), systemIcon: 'folder' },
              ]}
              onPress={(e: any) => {
                const index = e.nativeEvent.index;
                if (index === 0) onTakePicture();
                else if (index === 1) onChooseImages();
                else if (index === 2) onChooseFiles();
              }}
              dropdownMenuMode={true}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderWidth: 1,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: isDisabled ? 0.4 : 1,
                }}
                className="border-border"
              >
                <Icon as={Paperclip} size={16} className="text-foreground" />
              </View>
            </ContextMenu>
          ) : (
            <TouchableOpacity
              onPress={() => {
                if (!isAuthenticated) return;
                onAttachPress?.();
              }}
              disabled={isDisabled}
              style={{
                width: 36,
                height: 36,
                borderWidth: 1,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: isDisabled ? 0.4 : 1,
              }}
              className="border-border"
              hitSlop={ANDROID_HIT_SLOP}
              activeOpacity={0.7}
            >
              <Icon as={Paperclip} size={16} className="text-foreground" />
            </TouchableOpacity>
          )}
          <View className="flex-row items-center gap-1">
            <AgentSelector onPress={onAgentPress} onIntegrationsPress={onIntegrationsPress} compact={false} />
            <TouchableOpacity
              onPress={handleButtonPress}
              disabled={hasUploadingFiles || (!hasAgent && !isBusy)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: hasUploadingFiles || (!hasAgent && !isBusy) ? 0.4 : 1,
              }}
              className={isBusy ? 'bg-foreground' : 'bg-primary'}
              hitSlop={ANDROID_HIT_SLOP}
              activeOpacity={0.7}
            >
              {isBusy ? (
                <StopIcon size={14} className="text-background" />
              ) : (
                <>
                  <Animated.View style={voiceIconStyle}>
                    <Icon as={AudioLines} size={18} className="text-primary-foreground" strokeWidth={2} />
                  </Animated.View>
                  <Animated.View style={sendIconStyle}>
                    <Icon as={CornerDownLeft} size={18} className="text-primary-foreground" strokeWidth={2} />
                  </Animated.View>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </>
    );
  }
);

ChatInputContent.displayName = 'ChatInputContent';
