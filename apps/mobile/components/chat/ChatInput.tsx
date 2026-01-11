import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { AudioLines, CornerDownLeft, Paperclip, X } from 'lucide-react-native';
import { StopIcon } from '@/components/ui/StopIcon';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Keyboard, Pressable, ScrollView, TextInput, View, ViewStyle, Platform, TouchableOpacity, LayoutAnimation, UIManager, type ViewProps, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData, type TextInputSelectionChangeEventData } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  withRepeat,
  runOnJS,
  interpolate,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { Attachment } from '@/hooks/useChat';
import { AgentSelector } from '../agents/AgentSelector';
import { AudioWaveform } from '../attachments/AudioWaveform';
import type { Agent } from '@/api/types';
import { MarkdownToolbar, insertMarkdownFormat, type MarkdownFormat } from './MarkdownToolbar';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

// Enable LayoutAnimation for Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Threshold for swipe down to dismiss keyboard (in pixels)
const SWIPE_DOWN_THRESHOLD = 30;

// Spring config - defined once outside component
const SPRING_CONFIG = { damping: 15, stiffness: 400 };

// Native spring animation config for smooth transitions
const NATIVE_SPRING_CONFIG = {
  duration: 200,
  create: { type: LayoutAnimation.Types.spring, property: LayoutAnimation.Properties.opacity, springDamping: 0.8 },
  update: { type: LayoutAnimation.Types.spring, springDamping: 0.8 },
  delete: { type: LayoutAnimation.Types.spring, property: LayoutAnimation.Properties.opacity, springDamping: 0.8 },
};

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
  // Track text value in ref for instant access (no render cycle)
  const textValueRef = React.useRef(value || '');

  // State - minimal state only
  const [isFocused, setIsFocused] = React.useState(false);
  const [selection, setSelection] = React.useState({ start: 0, end: 0 });
  const [isStopping, setIsStopping] = React.useState(false);
  const [contentHeight, setContentHeight] = React.useState(0);
  // NO localHasText state in parent - NormalMode handles button state locally

  // Android: Clear input imperatively when value prop becomes empty
  React.useEffect(() => {
    if (Platform.OS === 'android' && value === '' && textValueRef.current !== '') {
      textInputRef.current?.clear();
      textValueRef.current = '';
    }
  }, [value]);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();

  // Helper to dismiss keyboard - needs to be called from worklet via runOnJS
  const dismissKeyboard = React.useCallback(() => {
    Keyboard.dismiss();
  }, []);

  // Swipe down gesture to dismiss keyboard
  // Only triggers on downward swipe with enough velocity/distance
  const swipeDownGesture = React.useMemo(() =>
    Gesture.Pan()
      .onEnd((event) => {
        // Only dismiss if:
        // 1. Swipe is primarily downward (translationY > threshold)
        // 2. Swipe is more vertical than horizontal
        // 3. Velocity is downward
        const isDownwardSwipe = event.translationY > SWIPE_DOWN_THRESHOLD;
        const isVertical = Math.abs(event.translationY) > Math.abs(event.translationX);
        const hasDownwardVelocity = event.velocityY > 0;

        if (isDownwardSwipe && isVertical && hasDownwardVelocity) {
          runOnJS(dismissKeyboard)();
        }
      })
      .minDistance(SWIPE_DOWN_THRESHOLD)
      .activeOffsetY(SWIPE_DOWN_THRESHOLD) // Only activate on downward movement
    , [dismissKeyboard]);

  // Derived values - use ref for hasText to avoid re-renders
  const hasAttachments = attachments.length > 0;
  // hasContent computed from ref - no state dependency
  const getHasContent = React.useCallback(() => {
    return !!(textValueRef.current && textValueRef.current.trim()) || attachments.length > 0;
  }, [attachments.length]);
  const hasAgent = !!agent?.agent_id;
  // Allow input to be editable during streaming - only disable when sending or transcribing
  const isDisabled = isSendingMessage || isTranscribing;

  // Reset stopping state when activity stops
  React.useEffect(() => {
    if (!isAgentRunning && !isSendingMessage && !isTranscribing) {
      setIsStopping(false);
    }
  }, [isAgentRunning, isSendingMessage, isTranscribing]);

  // Sync ref when value prop changes from outside (e.g., after send clears input)
  React.useEffect(() => {
    textValueRef.current = value || '';
  }, [value]);


  // Memoized placeholder
  const effectivePlaceholder = React.useMemo(
    () => placeholder || t('chat.placeholder'),
    [placeholder, t]
  );

  // Simple dynamic height calculation - works on both platforms
  const dynamicHeight = React.useMemo(() => {
    const baseHeight = 120;
    const maxHeight = 160;
    const calculatedHeight = contentHeight + 80;
    return Math.max(baseHeight, Math.min(calculatedHeight, maxHeight));
  }, [contentHeight]);

  // Recording status text
  const recordingStatusText = isTranscribing ? 'Transcribing...' : formatDuration(recordingDuration);

  // Placeholder color based on color scheme
  const placeholderTextColor = React.useMemo(
    () => colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)',
    [colorScheme]
  );

  // Text input style - memoized
  const textInputStyle = React.useMemo(() => ({
    fontFamily: 'Roobert-Regular',
    minHeight: 52,
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
      log.warn('⚠️ User not authenticated - cannot send message');
      return;
    }

    if (!agent?.agent_id) {
      log.warn('⚠️ No agent selected - cannot send message');
      return;
    }

    // Don't clear input here - let useChat handle it after successful send
    // Trim trailing spaces before sending
    onSendMessage?.(value.trim(), agent.agent_id, agent.name || '');
  }, [value, isAuthenticated, onSendMessage, agent]);

  // Handle sending audio
  const handleSendAudioMessage = React.useCallback(async () => {
    if (!isAuthenticated) {
      log.warn('⚠️ User not authenticated - cannot send audio');
      onCancelRecording?.();
      return;
    }

    if (!onSendAudio) {
      log.error('❌ onSendAudio handler is not provided');
      return;
    }

    try {
      log.log('📤 ChatInput: Calling onSendAudio handler');
      await onSendAudio();
      log.log('✅ ChatInput: onSendAudio completed successfully');
    } catch (error) {
      log.error('❌ ChatInput: Error in onSendAudio:', error);
    }
  }, [isAuthenticated, onCancelRecording, onSendAudio]);

  // Main button press handler
  const handleButtonPress = React.useCallback(() => {
    const hasContent = getHasContent(); // Compute from ref at press time
    log.log('[ChatInput] 🔘 Button pressed!', { isAgentRunning, isRecording, hasContent, hasAgent, isSendingMessage, isTranscribing, isStopping });

    // Priority 1: Stop if agent is running OR if we're in sending/transcribing state
    if (isAgentRunning || isSendingMessage || isTranscribing) {
      log.log('[ChatInput] 🛑 Calling onStopAgentRun (isAgentRunning:', isAgentRunning, ', isSendingMessage:', isSendingMessage, ')');
      setIsStopping(true);
      onStopAgentRun?.();
      return;
    }

    // Priority 2: Handle recording
    if (isRecording) {
      handleSendAudioMessage();
      return;
    }

    // Priority 3: Send message if has content
    if (hasContent) {
      if (!hasAgent) {
        log.warn('⚠️ No agent selected - cannot send message');
        return;
      }
      handleSendMessage();
      return;
    }

    // Priority 4: Start audio recording
    if (!isAuthenticated) {
      log.warn('⚠️ User not authenticated - cannot record audio');
      return;
    }
    if (!hasAgent) {
      log.warn('⚠️ No agent selected - cannot record audio');
      return;
    }
    onAudioRecord?.();
  }, [isAgentRunning, isRecording, getHasContent, hasAgent, isSendingMessage, isTranscribing, isStopping, isAuthenticated, onStopAgentRun, handleSendAudioMessage, handleSendMessage, onAudioRecord]);

  // Content size change handler - iOS smooth, Android instant
  const handleContentSizeChange = React.useCallback(
    (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const newHeight = e.nativeEvent.contentSize.height;
      // iOS: smooth spring animation, Android: instant (no animation delay)
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext(NATIVE_SPRING_CONFIG);
      }
      setContentHeight(newHeight);
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

  // Parent's onChangeText - NO STATE UPDATE, just ref + forward to parent prop
  // NormalMode handles button icon locally - parent doesn't need to re-render
  const handleChangeText = React.useCallback((text: string) => {
    textValueRef.current = text;
    onChangeText?.(text);
  }, [onChangeText]);

  // Container style with dynamic height
  const containerStyle = React.useMemo(
    () => ({
      ...(style as ViewStyle),
      height: dynamicHeight,
    }),
    [style, dynamicHeight]
  );

  // Memoized attach button style
  const attachButtonStyle = React.useMemo(
    () => [attachAnimatedStyle, { opacity: isDisabled ? 0.4 : 1 }],
    [attachAnimatedStyle, isDisabled]
  );

  return (
    <GestureDetector gesture={swipeDownGesture}>
      <View
        className="relative rounded-[30px] overflow-hidden bg-card border border-border"
        style={containerStyle}
        collapsable={false}
        {...props}
      >
        <View className="absolute inset-0" />
        <View className="p-4 flex-1" collapsable={false}>
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
              onChangeText={handleChangeText}
              effectivePlaceholder={effectivePlaceholder}
              placeholderTextColor={placeholderTextColor}
              isDisabled={isDisabled}
              textInputStyle={textInputStyle}
              handleContentSizeChange={handleContentSizeChange}
              onAttachPress={onAttachPress}
              onAgentPress={onAgentPress}
              onButtonPress={handleButtonPress}
              isSendingMessage={isSendingMessage}
              isTranscribing={isTranscribing}
              isAgentRunning={isAgentRunning}
              isStopping={isStopping}
              isAuthenticated={isAuthenticated}
              hasAgent={hasAgent}
              hasAttachments={hasAttachments}
            />
          )}
        </View>
      </View>
    </GestureDetector>
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
    <View className="flex-1 items-center bottom-5 justify-center">
      <AudioWaveform isRecording={true} audioLevels={audioLevels} />
    </View>
    <View className="absolute bottom-6 right-16 items-center">
      <Text className="text-xs font-roobert-medium text-foreground/50">
        {recordingStatusText}
      </Text>
    </View>
    <View className="absolute bottom-4 left-4 right-4 flex-row items-center justify-between">
      <AnimatedPressable
        onPressIn={onCancelPressIn}
        onPressOut={onCancelPressOut}
        onPress={onCancelRecording}
        className="bg-primary/5 rounded-full items-center justify-center"
        style={[{ width: 40, height: 40 }, cancelAnimatedStyle]}
        hitSlop={ANDROID_HIT_SLOP}
      >
        <Icon as={X} size={16} className="text-foreground" strokeWidth={2} />
      </AnimatedPressable>
      <AnimatedPressable
        onPressIn={onStopPressIn}
        onPressOut={onStopPressOut}
        onPress={onSendAudio}
        className="bg-primary rounded-full items-center justify-center"
        style={[{ width: 40, height: 40 }, stopAnimatedStyle]}
        hitSlop={ANDROID_HIT_SLOP}
      >
        <Icon as={CornerDownLeft} size={16} className="text-primary-foreground" strokeWidth={2} />
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
  onAttachPress?: () => void;
  onAgentPress?: () => void;
  onButtonPress: () => void;
  isSendingMessage: boolean;
  isTranscribing: boolean;
  isAgentRunning: boolean;
  isStopping: boolean;
  isAuthenticated: boolean;
  hasAgent: boolean;
  hasAttachments: boolean;
}

// NOT memo'd - we want instant re-renders for button state
const NormalMode = ({
  textInputRef,
  value,
  onChangeText,
  effectivePlaceholder,
  placeholderTextColor,
  isDisabled,
  textInputStyle,
  handleContentSizeChange,
  onAttachPress,
  onAgentPress,
  onButtonPress,
  isSendingMessage,
  isTranscribing,
  isAgentRunning,
  isStopping,
  isAuthenticated,
  hasAgent,
  hasAttachments,
}: NormalModeProps) => {
  // REANIMATED shared value for INSTANT button icon switching
  // This bypasses React rendering entirely - updates on UI thread!
  const hasContentShared = useSharedValue(!!(value && value.trim()) || hasAttachments ? 1 : 0);

  // Update shared value when hasAttachments changes
  React.useEffect(() => {
    hasContentShared.value = (!!(value && value.trim()) || hasAttachments) ? 1 : 0;
  }, [hasAttachments, value, hasContentShared]);

  // Handle text change - update shared value SYNCHRONOUSLY (no setState!)
  const handleLocalTextChange = React.useCallback((text: string) => {
    // Update Reanimated value immediately - no React render needed!
    hasContentShared.value = (!!(text && text.trim()) || hasAttachments) ? 1 : 0;
    onChangeText?.(text);
  }, [onChangeText, hasAttachments, hasContentShared]);

  // Animated styles for icon switching - runs on UI thread!
  const voiceIconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(hasContentShared.value, [0, 1], [1, 0]),
    position: 'absolute' as const,
  }));

  const sendIconStyle = useAnimatedStyle(() => ({
    opacity: hasContentShared.value,
    position: 'absolute' as const,
  }));

  return (
    <>
      <View className="flex-1 mb-12">
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled={true}
          style={{ maxHeight: 100 }} // Cap at ~4-5 lines
        >
          <TextInput
            ref={textInputRef}
            // iOS: controlled, Android: uncontrolled for speed
            {...(Platform.OS === 'ios' ? { value } : { defaultValue: value })}
            onChangeText={handleLocalTextChange}
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
            className="text-foreground text-base"
            style={textInputStyle}
            textAlignVertical="top"
            underlineColorAndroid="transparent"
          />
        </ScrollView>
      </View>

      <View className="absolute bottom-4 left-4 right-4 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          {/* Use TouchableOpacity on Android - AnimatedPressable blocks touches */}
          <TouchableOpacity
            onPress={() => {
              if (!isAuthenticated) {
                log.warn('⚠️ User not authenticated - cannot attach');
                return;
              }
              onAttachPress?.();
            }}
            disabled={isDisabled}
            style={{ width: 40, height: 40, borderWidth: 1, borderRadius: 18, alignItems: 'center', justifyContent: 'center', opacity: isDisabled ? 0.4 : 1 }}
            className="border-border"
            hitSlop={ANDROID_HIT_SLOP}
            activeOpacity={0.7}
          >
            <Icon as={Paperclip} size={16} className="text-foreground" />
          </TouchableOpacity>
        </View>

        <View className="flex-row items-center gap-1">
          <AgentSelector
            onPress={onAgentPress}
            compact={false}
          />

          {/* Main action button */}
          <TouchableOpacity
            onPress={onButtonPress}
            disabled={isStopping || (!hasAgent && !isAgentRunning && !isSendingMessage)}
            style={{ width: 40, height: 40, borderRadius: 18, alignItems: 'center', justifyContent: 'center', opacity: isStopping ? 0.5 : ((!hasAgent && !isAgentRunning && !isSendingMessage) ? 0.4 : 1) }}
            className={(isAgentRunning || isSendingMessage || isTranscribing || isStopping) ? 'bg-foreground' : 'bg-primary'}
            hitSlop={ANDROID_HIT_SLOP}
            activeOpacity={0.7}
          >
            {(isSendingMessage || isTranscribing || isAgentRunning || isStopping) ? (
              <StopIcon size={14} className="text-background" />
            ) : (
              // Both icons rendered, Reanimated switches opacity on UI thread (instant!)
              <>
                <Animated.View style={voiceIconStyle}>
                  <Icon
                    as={AudioLines}
                    size={18}
                    className="text-primary-foreground"
                    strokeWidth={2}
                  />
                </Animated.View>
                <Animated.View style={sendIconStyle}>
                  <Icon
                    as={CornerDownLeft}
                    size={18}
                    className="text-primary-foreground"
                    strokeWidth={2}
                  />
                </Animated.View>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </>
  );
};
