import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { AudioLines, CornerDownLeft, Paperclip, X, Loader2, ArrowUp } from 'lucide-react-native';
import { StopIcon } from '@/components/ui/StopIcon';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Keyboard, Pressable, ScrollView, TextInput, View, ViewStyle, Platform, TouchableOpacity, type ViewProps, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData, type TextInputSelectionChangeEventData } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  withRepeat
} from 'react-native-reanimated';
import type { Attachment } from '@/hooks/useChat';
import { AgentSelector } from '../agents/AgentSelector';
import { AudioWaveform } from '../attachments/AudioWaveform';
import type { Agent } from '@/api/types';
import { MarkdownToolbar, insertMarkdownFormat, type MarkdownFormat } from './MarkdownToolbar';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

// Spring config - defined once outside component
const SPRING_CONFIG = { damping: 15, stiffness: 400 };

// Android hit slop for better touch targets
const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 10, bottom: 10, left: 10, right: 10 } : undefined;

export interface ChatInputRef {
  focus: () => void;
}

interface ChatInputProps extends ViewProps {
  value?: string;
  onChangeText?: (text: string) => void;
  onSendMessage?: (content: string, agentId: string, agentName: string) => void;
  onSendAudio?: () => void;
  onAttachPress?: () => void;
  onAgentPress?: () => void;
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
  selectedQuickAction?: string | null;
  selectedQuickActionOption?: string | null;
  onClearQuickAction?: () => void;
  isAuthenticated?: boolean;
  isAgentRunning?: boolean;
  isSendingMessage?: boolean;
  isTranscribing?: boolean;
}

// Format duration as M:SS - pure function outside component
const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};


/**
 * ChatInput Component
 * Optimized for performance with memoized handlers and reduced re-renders
 */
export const ChatInput = React.memo(React.forwardRef<ChatInputRef, ChatInputProps>(({
  value,
  onChangeText,
  onSendMessage,
  onSendAudio,
  onAttachPress,
  onAgentPress,
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
  selectedQuickAction,
  selectedQuickActionOption,
  onClearQuickAction,
  isAuthenticated = true,
  isAgentRunning = false,
  isSendingMessage = false,
  isTranscribing = false,
  style,
  ...props
}, ref) => {
  // Animation shared values
  const attachScale = useSharedValue(1);
  const cancelScale = useSharedValue(1);
  const stopScale = useSharedValue(1);
  const sendScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(1);
  const rotation = useSharedValue(0);

  // TextInput ref for programmatic focus
  const textInputRef = React.useRef<TextInput>(null);
  const contentHeightRef = React.useRef(0);

  // State
  const [contentHeight, setContentHeight] = React.useState(0);
  const [isFocused, setIsFocused] = React.useState(false);
  const [selection, setSelection] = React.useState({ start: 0, end: 0 });
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();

  // Derived values - computed once per render
  const hasText = !!(value && value.trim());
  const hasAttachments = attachments.length > 0;
  const hasContent = hasText || hasAttachments;
  const hasAgent = !!agent?.agent_id;
  // Allow input to be editable during streaming - only disable when sending or transcribing
  const isDisabled = isSendingMessage || isTranscribing;


  // Memoized placeholder
  const effectivePlaceholder = React.useMemo(
    () => placeholder || t('chat.placeholder'),
    [placeholder, t]
  );

  // Memoized dynamic height - adjusted for content-based sizing
  const dynamicHeight = React.useMemo(() => {
    const minTextHeight = 24; // Minimum single line text height
    const buttonRowHeight = 40; // Height for the bottom button row (h-10)
    const verticalPadding = 24; // py-3 = 12px top + 12px bottom
    const textBottomPadding = 12; // Space between text and buttons
    
    // Calculate total height: padding + text content + spacing + buttons
    const textHeight = Math.max(minTextHeight, contentHeight || minTextHeight);
    const totalHeight = verticalPadding + textHeight + textBottomPadding + buttonRowHeight;
    
    // Ensure minimum height and cap maximum
    const minHeight = verticalPadding + minTextHeight + textBottomPadding + buttonRowHeight; // ~100px minimum
    const maxHeight = verticalPadding + 120 + textBottomPadding + buttonRowHeight; // Max text area of 120px
    
    return Math.max(minHeight, Math.min(totalHeight, maxHeight));
  }, [contentHeight]);

  // Recording status text
  const recordingStatusText = isTranscribing ? 'Transcribing...' : formatDuration(recordingDuration);

  // Placeholder color using neutral shades
  const placeholderTextColor = React.useMemo(
    () => colorScheme === 'dark' ? 'rgba(212, 212, 212, 0.4)' : 'rgba(64, 64, 64, 0.4)', // neutral-300 / neutral-700 with opacity
    [colorScheme]
  );

  // Text input style - memoized
  const textInputStyle = React.useMemo(() => ({
    fontFamily: 'Roobert-Medium',
    paddingVertical: 0, // Remove default padding
    opacity: isDisabled ? 0.5 : 1,
  }), [isDisabled]);

  // Expose focus method via ref
  React.useImperativeHandle(ref, () => ({
    focus: () => {
      textInputRef.current?.focus();
    },
  }), []);

  // Animation effects
  React.useEffect(() => {
    if (isAgentRunning) {
      pulseOpacity.value = withRepeat(
        withTiming(0.85, { duration: 1500 }),
        -1,
        true
      );
    } else {
      pulseOpacity.value = withTiming(1, { duration: 300 });
    }
  }, [isAgentRunning, pulseOpacity]);

  React.useEffect(() => {
    if (isSendingMessage || isTranscribing) {
      rotation.value = withRepeat(
        withTiming(360, { duration: 1000 }),
        -1,
        false
      );
    } else {
      rotation.value = 0;
    }
  }, [isSendingMessage, isTranscribing, rotation]);

  // Animated styles - these are worklet functions, stable references
  const attachAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: attachScale.value }],
  }));

  const cancelAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: cancelScale.value }],
  }));

  const stopAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: stopScale.value }],
  }));

  const sendAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: sendScale.value }],
    opacity: pulseOpacity.value,
  }));

  const rotationAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  // Memoized press handlers using useCallback
  const handleAttachPressIn = React.useCallback(() => {
    attachScale.value = withSpring(0.9, SPRING_CONFIG);
  }, [attachScale]);

  const handleAttachPressOut = React.useCallback(() => {
    attachScale.value = withSpring(1, SPRING_CONFIG);
  }, [attachScale]);

  const handleCancelPressIn = React.useCallback(() => {
    cancelScale.value = withSpring(0.9, SPRING_CONFIG);
  }, [cancelScale]);

  const handleCancelPressOut = React.useCallback(() => {
    cancelScale.value = withSpring(1, SPRING_CONFIG);
  }, [cancelScale]);

  const handleStopPressIn = React.useCallback(() => {
    stopScale.value = withSpring(0.9, SPRING_CONFIG);
  }, [stopScale]);

  const handleStopPressOut = React.useCallback(() => {
    stopScale.value = withSpring(1, SPRING_CONFIG);
  }, [stopScale]);

  const handleSendPressIn = React.useCallback(() => {
    sendScale.value = withSpring(0.9, SPRING_CONFIG);
  }, [sendScale]);

  const handleSendPressOut = React.useCallback(() => {
    sendScale.value = withSpring(1, SPRING_CONFIG);
  }, [sendScale]);

  // Handle sending text message
  const handleSendMessage = React.useCallback(() => {
    if (!value?.trim()) return;

    if (!isAuthenticated) {
      console.warn('⚠️ User not authenticated - cannot send message');
      return;
    }

    if (!agent?.agent_id) {
      console.warn('⚠️ No agent selected - cannot send message');
      return;
    }

    // Don't clear input here - let useChat handle it after successful send
    // Trim trailing spaces before sending
    onSendMessage?.(value.trim(), agent.agent_id, agent.name || '');
  }, [value, isAuthenticated, onSendMessage, agent]);

  // Handle sending audio
  const handleSendAudioMessage = React.useCallback(async () => {
    if (!isAuthenticated) {
      console.warn('⚠️ User not authenticated - cannot send audio');
      onCancelRecording?.();
      return;
    }

    if (!onSendAudio) {
      console.error('❌ onSendAudio handler is not provided');
      return;
    }

    try {
      console.log('📤 ChatInput: Calling onSendAudio handler');
      await onSendAudio();
      console.log('✅ ChatInput: onSendAudio completed successfully');
    } catch (error) {
      console.error('❌ ChatInput: Error in onSendAudio:', error);
    }
  }, [isAuthenticated, onCancelRecording, onSendAudio]);

  // Main button press handler
  const handleButtonPress = React.useCallback(() => {
    if (isAgentRunning) {
      onStopAgentRun?.();
    } else if (isRecording) {
      handleSendAudioMessage();
    } else if (hasContent) {
      if (!hasAgent) {
        console.warn('⚠️ No agent selected - cannot send message');
        return;
      }
      handleSendMessage();
    } else {
      // Start audio recording
      if (!isAuthenticated) {
        console.warn('⚠️ User not authenticated - cannot record audio');
        return;
      }
      if (!hasAgent) {
        console.warn('⚠️ No agent selected - cannot record audio');
        return;
      }
      onAudioRecord?.();
    }
  }, [isAgentRunning, isRecording, hasContent, hasAgent, isAuthenticated, onStopAgentRun, handleSendAudioMessage, handleSendMessage, onAudioRecord]);

  // Content size change handler - debounced via ref comparison
  const handleContentSizeChange = React.useCallback(
    (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const newHeight = e.nativeEvent.contentSize.height;
      // Only update state if height changed significantly (reduces renders)
      if (Math.abs(newHeight - contentHeightRef.current) >= 5) {
        contentHeightRef.current = newHeight;
        setContentHeight(newHeight);
      }
    },
    []
  );

  // Selection change handler to track cursor position
  const handleSelectionChange = React.useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      setSelection(e.nativeEvent.selection);
    },
    []
  );

  // Focus/blur handlers
  const handleFocus = React.useCallback(() => {
    if (!isAuthenticated) {
      textInputRef.current?.blur();
      return;
    }
    setIsFocused(true);
  }, [isAuthenticated]);

  const handleBlur = React.useCallback(() => {
    // Delay hiding toolbar to allow button press to register
    setTimeout(() => setIsFocused(false), 150);
  }, []);

  // Markdown format handler
  const handleMarkdownFormat = React.useCallback(
    (format: MarkdownFormat, extra?: string) => {
      const currentText = value || '';
      const { newText, newCursorPosition, newSelectionEnd } = insertMarkdownFormat(
        currentText,
        selection.start,
        selection.end,
        format,
        extra
      );
      onChangeText?.(newText);
      // Update selection
      setSelection({ start: newCursorPosition, end: newSelectionEnd });
      // Refocus the input
      textInputRef.current?.focus();
    },
    [value, selection, onChangeText]
  );

  // Memoized container style - no fixed height, grows with content
  const containerStyle = React.useMemo(
    () => ({ ...(style as ViewStyle) }),
    [style]
  );

  // Memoized attach button style
  const attachButtonStyle = React.useMemo(
    () => [attachAnimatedStyle, { opacity: isDisabled ? 0.4 : 1 }],
    [attachAnimatedStyle, isDisabled]
  );

  // Determine button icon
  const ButtonIcon = React.useMemo(() => {
    if (isAgentRunning) return StopIcon;
    if (hasContent) return ArrowUp;
    return AudioLines;
  }, [isAgentRunning, hasContent]);

  const buttonIconSize = isAgentRunning ? 14 : 18;
  const buttonIconClass = isAgentRunning ? "text-neutral-50 dark:text-neutral-900" : "text-neutral-50 dark:text-neutral-900";

  return (
    <View
      className="relative rounded-[28px] overflow-hidden bg-neutral-100 dark:bg-neutral-800"
      style={[
        containerStyle,
        { minHeight: 100 }
      ]}
      collapsable={false}
      {...props}
    >
      <View className="absolute inset-0" />
      <View className="px-2 pb-2 py-0 flex-col" collapsable={false}>
        {isRecording ? (
          <RecordingMode
            audioLevels={audioLevels}
            recordingStatusText={recordingStatusText}
            cancelAnimatedStyle={cancelAnimatedStyle}
            stopAnimatedStyle={stopAnimatedStyle}
            onCancelPressIn={handleCancelPressIn}
            onCancelPressOut={handleCancelPressOut}
            onCancelRecording={onCancelRecording}
            onStopPressIn={handleStopPressIn}
            onStopPressOut={handleStopPressOut}
            onSendAudio={handleSendAudioMessage}
          />
        ) : (
          <NormalMode
            textInputRef={textInputRef}
            value={value}
            onChangeText={onChangeText}
            effectivePlaceholder={effectivePlaceholder}
            placeholderTextColor={placeholderTextColor}
            isDisabled={isDisabled}
            textInputStyle={textInputStyle}
            handleContentSizeChange={handleContentSizeChange}
            attachButtonStyle={attachButtonStyle}
            onAttachPressIn={handleAttachPressIn}
            onAttachPressOut={handleAttachPressOut}
            onAttachPress={onAttachPress}
            onAgentPress={onAgentPress}
            sendAnimatedStyle={sendAnimatedStyle}
            rotationAnimatedStyle={rotationAnimatedStyle}
            onSendPressIn={handleSendPressIn}
            onSendPressOut={handleSendPressOut}
            onButtonPress={handleButtonPress}
            isSendingMessage={isSendingMessage}
            isTranscribing={isTranscribing}
            isAgentRunning={isAgentRunning}
            ButtonIcon={ButtonIcon}
            buttonIconSize={buttonIconSize}
            buttonIconClass={buttonIconClass}
            isAuthenticated={isAuthenticated}
            hasAgent={hasAgent}
            hasContent={hasContent}
          />
        )}
      </View>
    </View>
  );
}));

ChatInput.displayName = 'ChatInput';

// Extracted Recording Mode component for better performance
interface RecordingModeProps {
  audioLevels: number[];
  recordingStatusText: string;
  cancelAnimatedStyle: any;
  stopAnimatedStyle: any;
  onCancelPressIn: () => void;
  onCancelPressOut: () => void;
  onCancelRecording?: () => void;
  onStopPressIn: () => void;
  onStopPressOut: () => void;
  onSendAudio: () => void;
}

const RecordingMode = React.memo(({
  audioLevels,
  recordingStatusText,
  cancelAnimatedStyle,
  stopAnimatedStyle,
  onCancelPressIn,
  onCancelPressOut,
  onCancelRecording,
  onStopPressIn,
  onStopPressOut,
  onSendAudio,
}: RecordingModeProps) => (
  <>
    {/* Waveform Area - Top (matching NormalMode padding) */}
    <View style={{ paddingTop: 16, paddingBottom: 16, paddingLeft: 8, paddingRight: 8, minHeight: 56 }}>
      <View className="items-center justify-center flex-1">
        <AudioWaveform isRecording={true} audioLevels={audioLevels} />
      </View>
      <View className="items-center mt-2">
        <Text className="text-xs font-roobert-medium text-foreground/50">
          {recordingStatusText}
        </Text>
      </View>
    </View>

    {/* Buttons Row - Bottom (matching NormalMode layout) */}
    <View className="flex-row items-center justify-between">
      <AnimatedPressable
        onPressIn={onCancelPressIn}
        onPressOut={onCancelPressOut}
        onPress={onCancelRecording}
        className="bg-neutral-50 dark:bg-neutral-900 rounded-full items-center justify-center"
        style={[{ width: 40, height: 40 }, cancelAnimatedStyle]}
        hitSlop={ANDROID_HIT_SLOP}
      >
        <Icon as={X} size={18} className="text-neutral-700 dark:text-neutral-300" strokeWidth={2} />
      </AnimatedPressable>
      <AnimatedPressable
        onPressIn={onStopPressIn}
        onPressOut={onStopPressOut}
        onPress={onSendAudio}
        className="bg-neutral-900 dark:bg-neutral-50 rounded-full items-center justify-center"
        style={[{ width: 40, height: 40 }, stopAnimatedStyle]}
        hitSlop={ANDROID_HIT_SLOP}
      >
        <Icon as={ArrowUp} size={18} className="text-neutral-50 dark:text-neutral-900" strokeWidth={2} />
      </AnimatedPressable>
    </View>
  </>
));

RecordingMode.displayName = 'RecordingMode';

// Extracted Normal Mode component
interface NormalModeProps {
  textInputRef: React.RefObject<TextInput | null>;
  value?: string;
  onChangeText?: (text: string) => void;
  effectivePlaceholder: string;
  placeholderTextColor: string;
  isDisabled: boolean;
  textInputStyle: any;
  handleContentSizeChange: (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => void;
  attachButtonStyle: any;
  onAttachPressIn: () => void;
  onAttachPressOut: () => void;
  onAttachPress?: () => void;
  onAgentPress?: () => void;
  sendAnimatedStyle: any;
  rotationAnimatedStyle: any;
  onSendPressIn: () => void;
  onSendPressOut: () => void;
  onButtonPress: () => void;
  isSendingMessage: boolean;
  isTranscribing: boolean;
  isAgentRunning: boolean;
  ButtonIcon: React.ComponentType<any>;
  buttonIconSize: number;
  buttonIconClass: string;
  isAuthenticated: boolean;
  hasAgent: boolean;
  hasContent: boolean;
}

const NormalMode = React.memo(({
  textInputRef,
  value,
  onChangeText,
  effectivePlaceholder,
  placeholderTextColor,
  isDisabled,
  textInputStyle,
  handleContentSizeChange,
  attachButtonStyle,
  onAttachPressIn,
  onAttachPressOut,
  onAttachPress,
  onAgentPress,
  sendAnimatedStyle,
  rotationAnimatedStyle,
  onSendPressIn,
  onSendPressOut,
  onButtonPress,
  isSendingMessage,
  isTranscribing,
  isAgentRunning,
  ButtonIcon,
  buttonIconSize,
  buttonIconClass,
  isAuthenticated,
  hasAgent,
  hasContent,
}: NormalModeProps) => (
  <>
    {/* Text Input - Top (full width) */}
    <View style={{ paddingTop: 16, paddingBottom: 16, paddingLeft: 8, paddingRight: 8 }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled={true}
        style={{ maxHeight: 200 }}
      >
          <TextInput
          ref={textInputRef}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => {
            if (!isAuthenticated) {
              textInputRef.current?.blur();
            }
          }}
          placeholder={effectivePlaceholder}
          placeholderTextColor={placeholderTextColor}
          multiline
          scrollEnabled={false}
          editable={!isDisabled}
          onContentSizeChange={handleContentSizeChange}
          className="text-base font-medium text-neutral-900 dark:text-neutral-50"
          style={textInputStyle}
          textAlignVertical="top"
          underlineColorAndroid="transparent"
        />
      </ScrollView>
    </View>

    {/* Buttons Row - Bottom */}
    <View className="flex-row items-center justify-between">
      <View className="flex-row items-center gap-2">
        {/* Attach Button */}
        <TouchableOpacity
          onPress={() => {
            if (!isAuthenticated) {
              console.warn('⚠️ User not authenticated - cannot attach');
              return;
            }
            onAttachPress?.();
          }}
          disabled={isDisabled}
          className="h-10 w-10 rounded-full bg-neutral-50 dark:bg-neutral-900 items-center justify-center"
          style={{ opacity: isDisabled ? 0.4 : 1 }}
          hitSlop={ANDROID_HIT_SLOP}
          activeOpacity={0.7}
        >
          <Icon as={Paperclip} size={18} className="text-neutral-700 dark:text-neutral-300" />
        </TouchableOpacity>

        {/* Advanced Button (AgentSelector) */}
        <AgentSelector
          onPress={onAgentPress}
          compact={false}
        />
      </View>

      {/* Send/Audio Button - Right */}
      <TouchableOpacity
        onPress={() => {
          onButtonPress();
        }}
        disabled={isSendingMessage || isTranscribing || !hasAgent}
        className={`h-10 w-10 rounded-full items-center justify-center ${
          isAgentRunning ? 'bg-neutral-900 dark:bg-neutral-50' : hasContent ? 'bg-neutral-900 dark:bg-neutral-50' : 'bg-neutral-50 dark:bg-neutral-900'
        }`}
        style={{ opacity: (!hasAgent && !isAgentRunning) ? 0.4 : 1 }}
        hitSlop={ANDROID_HIT_SLOP}
        activeOpacity={0.7}
      >
        {isSendingMessage || isTranscribing ? (
          <AnimatedView style={rotationAnimatedStyle}>
            <Icon as={Loader2} size={18} className={hasContent ? "text-neutral-50 dark:text-neutral-900" : "text-neutral-700 dark:text-neutral-300"} strokeWidth={2} />
          </AnimatedView>
        ) : (
          ButtonIcon === StopIcon ? (
            <StopIcon size={buttonIconSize} className={buttonIconClass} />
          ) : (
            <Icon as={ButtonIcon as any} size={18} className={hasContent ? "text-neutral-50 dark:text-neutral-900" : "text-neutral-700 dark:text-neutral-300"} strokeWidth={2} />
          )
        )}
      </TouchableOpacity>
    </View>
  </>
));

NormalMode.displayName = 'NormalMode';
