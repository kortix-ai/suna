import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { AudioLines, CornerDownLeft, Paperclip, X, Image, Presentation, Table2, FileText, Users, Search, Loader2, Square } from 'lucide-react-native';
import { StopIcon } from '@/components/ui/StopIcon';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Keyboard, Pressable, ScrollView, TextInput, View, ViewStyle, type ViewProps, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData } from 'react-native';
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
import { useAuthDrawerStore } from '@/stores/auth-drawer-store';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

// Spring config - defined once outside component
const SPRING_CONFIG = { damping: 15, stiffness: 400 };

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
  isGuestMode?: boolean;
}

// Format duration as M:SS - pure function outside component
const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// Quick action icon mapping - defined outside component
const QUICK_ACTION_ICONS: Record<string, typeof Image> = {
  image: Image,
  slides: Presentation,
  data: Table2,
  docs: FileText,
  people: Users,
  research: Search,
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
  isGuestMode = false,
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
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();

  // Derived values - computed once per render
  const hasText = !!(value && value.trim());
  const hasAttachments = attachments.length > 0;
  const hasContent = hasText || hasAttachments;
  const isDisabled = isSendingMessage || isAgentRunning || isTranscribing;

  // Get quick action icon
  const QuickActionIcon = selectedQuickAction ? QUICK_ACTION_ICONS[selectedQuickAction] : null;

  // Memoized placeholder
  const effectivePlaceholder = React.useMemo(
    () => placeholder || t('chat.placeholder'),
    [placeholder, t]
  );

  // Memoized dynamic height
  const dynamicHeight = React.useMemo(() => {
    const baseHeight = 120;
    const maxHeight = 200;
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
      Keyboard.dismiss();
      setTimeout(() => {
        useAuthDrawerStore.getState().openAuthDrawer();
      }, 200);
      return;
    }

    // Don't clear input here - let useChat handle it after successful send
    // Trim trailing spaces before sending
    onSendMessage?.(value.trim(), agent?.agent_id || '', agent?.name || '');
  }, [value, isAuthenticated, onSendMessage, agent]);

  // Handle sending audio
  const handleSendAudioMessage = React.useCallback(() => {
    if (!isAuthenticated) {
      onCancelRecording?.();
      setTimeout(() => {
        useAuthDrawerStore.getState().openAuthDrawer();
      }, 200);
      return;
    }
    onSendAudio?.();
  }, [isAuthenticated, onCancelRecording, onSendAudio]);

  // Main button press handler
  const handleButtonPress = React.useCallback(() => {
    if (isAgentRunning) {
      onStopAgentRun?.();
    } else if (isRecording) {
      handleSendAudioMessage();
    } else if (hasContent) {
      handleSendMessage();
    } else {
      // Start audio recording
      if (!isAuthenticated) {
        useAuthDrawerStore.getState().openAuthDrawer({
          title: t('auth.drawer.signInToChat'),
          message: t('auth.drawer.signInToChatMessage')
        });
        return;
      }
      onAudioRecord?.();
    }
  }, [isAgentRunning, isRecording, hasContent, isAuthenticated, t, onStopAgentRun, handleSendAudioMessage, handleSendMessage, onAudioRecord]);

  // Clear quick action handler
  const handleClearQuickAction = React.useCallback(() => {
    onClearQuickAction?.();
  }, [onClearQuickAction]);

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

  // Memoized container style
  const containerStyle = React.useMemo(
    () => ({ height: dynamicHeight, ...(style as ViewStyle) }),
    [dynamicHeight, style]
  );

  // Memoized attach button style
  const attachButtonStyle = React.useMemo(
    () => [attachAnimatedStyle, { opacity: isDisabled ? 0.4 : 1 }],
    [attachAnimatedStyle, isDisabled]
  );

  // Determine button icon
  const ButtonIcon = React.useMemo(() => {
    if (isAgentRunning) return Square;
    if (hasContent) return CornerDownLeft;
    return AudioLines;
  }, [isAgentRunning, hasContent]);

  const buttonIconSize = isAgentRunning ? 14 : 18;
  const buttonIconClass = isAgentRunning ? "text-background" : "text-primary-foreground";

  return (
    <View
      className="relative rounded-[30px] overflow-hidden bg-card border border-border"
      style={containerStyle}
      {...props}
    >
      <View className="absolute inset-0" />
      <View className="p-4 flex-1">
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
            selectedQuickAction={selectedQuickAction}
            QuickActionIcon={QuickActionIcon}
            onClearQuickAction={handleClearQuickAction}
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
            isGuestMode={isGuestMode}
            t={t}
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
      >
        <Icon as={X} size={16} className="text-foreground" strokeWidth={2} />
      </AnimatedPressable>
      <AnimatedPressable
        onPressIn={onStopPressIn}
        onPressOut={onStopPressOut}
        onPress={onSendAudio}
        className="bg-primary rounded-full items-center justify-center"
        style={[{ width: 40, height: 40 }, stopAnimatedStyle]}
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
  attachButtonStyle: any;
  onAttachPressIn: () => void;
  onAttachPressOut: () => void;
  onAttachPress?: () => void;
  selectedQuickAction?: string | null;
  QuickActionIcon: typeof Image | null;
  onClearQuickAction: () => void;
  onAgentPress?: () => void;
  sendAnimatedStyle: any;
  rotationAnimatedStyle: any;
  onSendPressIn: () => void;
  onSendPressOut: () => void;
  onButtonPress: () => void;
  isSendingMessage: boolean;
  isTranscribing: boolean;
  isAgentRunning: boolean;
  ButtonIcon: typeof Square | typeof CornerDownLeft | typeof AudioLines;
  buttonIconSize: number;
  buttonIconClass: string;
  isAuthenticated: boolean;
  isGuestMode: boolean;
  t: (key: string) => string;
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
  selectedQuickAction,
  QuickActionIcon,
  onClearQuickAction,
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
  isGuestMode,
  t,
}: NormalModeProps) => (
  <>
    <View className="flex-1 mb-12">
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          ref={textInputRef}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => {
            if (!isAuthenticated) {
              textInputRef.current?.blur();
              setTimeout(() => {
                useAuthDrawerStore.getState().openAuthDrawer({
                  title: t('auth.drawer.signInToChat'),
                  message: t('auth.drawer.signInToChatMessage')
                });
              }, 100);
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
        />
      </ScrollView>
    </View>

    <View className="absolute bottom-4 left-4 right-4 flex-row items-center justify-between">
      <View className="flex-row items-center gap-2">
        <AnimatedPressable
          onPressIn={onAttachPressIn}
          onPressOut={onAttachPressOut}
          onPress={() => {
            if (!isAuthenticated) {
              useAuthDrawerStore.getState().openAuthDrawer({
                title: t('auth.drawer.signInToChat'),
                message: t('auth.drawer.signInToChatMessage')
              });
            } else {
              onAttachPress?.();
            }
          }}
          disabled={isDisabled}
          className="border border-border rounded-[18px] w-10 h-10 items-center justify-center"
          style={attachButtonStyle}
        >
          <Icon as={Paperclip} size={16} className="text-foreground" />
        </AnimatedPressable>

        {selectedQuickAction && QuickActionIcon && (
          <Pressable
            onPress={onClearQuickAction}
            className="bg-primary/5 rounded-full flex-row items-center h-10 px-3 active:opacity-70"
          >
            <Icon as={QuickActionIcon} size={16} className="text-primary mr-1.5" strokeWidth={2} />
            <Icon as={X} size={14} className="text-primary" strokeWidth={2} />
          </Pressable>
        )}
      </View>

      <View className="flex-row items-center gap-2">
        <AgentSelector 
          isGuestMode={isGuestMode}
          onPress={isGuestMode ? () => useAuthDrawerStore.getState().openAuthDrawer({ 
            title: t('auth.drawer.signUpToContinue'), 
            message: t('auth.drawer.signUpToContinueMessage') 
          }) : onAgentPress} 
          compact={false} 
        />

        <AnimatedPressable
          onPressIn={onSendPressIn}
          onPressOut={onSendPressOut}
          onPress={onButtonPress}
          disabled={isSendingMessage || isTranscribing}
          className={`rounded-[18px] items-center justify-center ${isAgentRunning ? 'bg-foreground' : 'bg-primary'}`}
          style={[{ width: 40, height: 40 }, sendAnimatedStyle]}
        >
          {isSendingMessage || isTranscribing ? (
            <AnimatedView style={rotationAnimatedStyle}>
              <Icon as={Loader2} size={16} className="text-primary-foreground" strokeWidth={2} />
            </AnimatedView>
          ) : (
            <Icon as={ButtonIcon} size={buttonIconSize} className={buttonIconClass} strokeWidth={2} />
          )}
        </AnimatedPressable>
      </View>
    </View>
  </>
));

NormalMode.displayName = 'NormalMode';
