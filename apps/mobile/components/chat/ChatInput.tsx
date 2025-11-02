import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { AudioLines, CornerDownLeft, Paperclip, X, Image, Presentation, Table2, FileText, Users, Search, Square, Loader2 } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Keyboard, Pressable, ScrollView, TextInput, View, type ViewProps } from 'react-native';
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

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
  audioLevels?: number[]; // Time-series buffer for waveform
  attachments?: Attachment[];
  onRemoveAttachment?: (index: number) => void;
  selectedQuickAction?: string | null;
  selectedQuickActionOption?: string | null;
  onClearQuickAction?: () => void;
  isAuthenticated?: boolean;
  onOpenAuthDrawer?: () => void;
  isAgentRunning?: boolean;
  isSendingMessage?: boolean;
  isTranscribing?: boolean;
}

/**
 * ChatInput Component
 * Clean implementation with attachment support and built-in authentication handling
 * 
 * Features:
 * - Multi-line text input
 * - Attachment preview with remove capability
 * - Dynamic height based on content
 * - Audio recording mode
 * - Agent selector
 * - Send button
 * - Authentication checks before sending
 * - Auto-clear input after successful send
 * - Programmatic focus support
 */
export const ChatInput = React.forwardRef<ChatInputRef, ChatInputProps>(({ 
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
  onOpenAuthDrawer,
  isAgentRunning = false,
  isSendingMessage = false,
  isTranscribing = false,
  style,
  ...props 
}, ref) => {
  // Animation values for buttons
  const attachScale = useSharedValue(1);
  const cancelScale = useSharedValue(1);
  const stopScale = useSharedValue(1);
  const sendScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(1);
  const rotation = useSharedValue(0);
  
  // TextInput ref for programmatic focus
  const textInputRef = React.useRef<TextInput>(null);
  
  // Expose focus method via ref
  React.useImperativeHandle(ref, () => ({
    focus: () => {
      console.log('🎯 Focusing chat input');
      textInputRef.current?.focus();
    },
  }), []);
  
  // Subtle fade animation for agent running state
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
  }, [isAgentRunning]);
  
  // Rotating animation for sending state
  React.useEffect(() => {
    if (isSendingMessage) {
      rotation.value = withRepeat(
        withTiming(360, { duration: 1000 }),
        -1,
        false
      );
    } else {
      rotation.value = withTiming(0, { duration: 0 });
    }
  }, [isSendingMessage]);

  // Rotating animation for transcription state
  React.useEffect(() => {
    if (isTranscribing) {
      rotation.value = withRepeat(
        withTiming(360, { duration: 1000 }),
        -1,
        false
      );
    }
  }, [isTranscribing]);
  
  // States
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const hasText = value && value.trim();
  const hasAttachments = attachments.length > 0;
  const hasContent = hasText || hasAttachments;
  const [contentHeight, setContentHeight] = React.useState(0);
  const lastLoggedHeightRef = React.useRef(0);
  
  // Use translated placeholder if not provided
  const effectivePlaceholder = placeholder || t('chat.placeholder');
  
  // Get icon for selected quick action
  const getQuickActionIcon = () => {
    switch (selectedQuickAction) {
      case 'image': return Image;
      case 'slides': return Presentation;
      case 'data': return Table2;
      case 'docs': return FileText;
      case 'people': return Users;
      case 'research': return Search;
      default: return null;
    }
  };
  
  const getQuickActionLabel = () => {
    switch (selectedQuickAction) {
      case 'image': return t('quickActions.image');
      case 'slides': return t('quickActions.slides');
      case 'data': return t('quickActions.data');
      case 'docs': return t('quickActions.docs');
      case 'people': return t('quickActions.people');
      case 'research': return t('quickActions.research');
      default: return null;
    }
  };
  
  const QuickActionIcon = getQuickActionIcon();
  
  // Calculate dynamic height based on content
  const dynamicHeight = React.useMemo(() => {
    const baseHeight = 150;
    const maxHeight = 280;
    // No longer need attachment height as they're external
    const calculatedHeight = contentHeight + 80; // Add padding for controls
    return Math.max(baseHeight, Math.min(calculatedHeight, maxHeight));
  }, [contentHeight]);

  // Animated styles
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

  // Handle sending text message - checks auth first
  const handleSendMessage = () => {
    if (!value?.trim()) return;
    
    // Check authentication before sending
    if (!isAuthenticated) {
      console.log('🔐 User not authenticated, showing auth drawer');
      console.log('⏰ Timestamp:', new Date().toISOString());
      console.log('📝 Input value:', value);
      console.log('📊 Input length:', value.length);
      
      // Dismiss keyboard first for better UX
      Keyboard.dismiss();
      
      // Wait for keyboard to dismiss, then open auth screen
      setTimeout(() => {
        console.log('🔐 Opening auth screen after keyboard dismissal');
        onOpenAuthDrawer?.();
      }, 200); // Small delay for smooth transition
      
      return;
    }
    
    console.log('✅ User authenticated, sending message');
    // Don't clear input here - let useChat handle it after successful send
    // Trim trailing spaces before sending
    onSendMessage?.(value.trim(), agent?.agent_id || '', agent?.name || '');
  };

  // Handle sending audio - also checks auth
  const handleSendAudioMessage = () => {
    // Check authentication before sending audio
    if (!isAuthenticated) {
      console.log('🔐 User not authenticated, showing auth drawer (audio)');
      console.log('⏰ Timestamp:', new Date().toISOString());
      console.log('🎤 Recording duration:', recordingDuration);
      
      // Cancel recording first
      onCancelRecording?.();
      
      // Wait a bit, then open auth screen
      setTimeout(() => {
        console.log('🔐 Opening auth screen after canceling recording');
        onOpenAuthDrawer?.();
      }, 200);
      
      return;
    }
    
    // User is authenticated, send audio normally
    console.log('✅ User authenticated, sending audio');
    onSendAudio?.();
  };

  const handleButtonPress = () => {
    if (isAgentRunning) {
      // Stop agent run immediately
      console.log('🛑 Stop agent run pressed');
      onStopAgentRun?.();
      return; // Early return to prevent any other actions
    } else if (isRecording) {
      // Send audio recording
      handleSendAudioMessage();
    } else if (hasContent) {
      // Send text message
      console.log('📤 Send button pressed');
      console.log('📝 Has text:', !!hasText);
      console.log('📎 Has attachments:', hasAttachments, `(${attachments.length})`);
      handleSendMessage();
    } else {
      // Start audio recording
      console.log('🎤 Audio record button pressed');
      onAudioRecord?.();
    }
  };

  // Format duration as M:SS
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  // Show transcription status in recording mode
  const recordingStatusText = isTranscribing 
    ? 'Transcribing...' 
    : formatDuration(recordingDuration);

  return (
    <View 
      className="relative rounded-3xl border border-border overflow-hidden"
      style={[
        { height: dynamicHeight }, 
        style
      ]}
      {...props}
    >
      {/* Solid background */}
      <View 
        className="absolute inset-0"
        style={{ 
          backgroundColor: colorScheme === 'dark' 
            ? '#161618' 
            : '#FFFFFF' 
        }}
      />

      {/* Main Container */}
      <View className="p-4 flex-1">
        {isRecording ? (
          /* Recording Mode UI */
          <>
            {/* Waveform */}
            <View className="flex-1 items-center bottom-5 justify-center">
              <AudioWaveform isRecording={true} audioLevels={audioLevels} />
            </View>
            
            {/* Timer / Transcription Status */}
            <View className="absolute bottom-6 right-16 items-center">
              <Text className="text-xs font-roobert-medium text-foreground/50">
                {recordingStatusText}
              </Text>
            </View>
            
            {/* Bottom Controls */}
            <View className="absolute bottom-4 left-4 right-4 flex-row items-center justify-between">
              {/* Cancel Button */}
              <AnimatedPressable 
                onPressIn={() => {
                  cancelScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                }}
                onPressOut={() => {
                  cancelScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                }}
                onPress={onCancelRecording}
                className="bg-secondary rounded-full items-center justify-center"
                style={[{ width: 40, height: 40 }, cancelAnimatedStyle]}
              >
                <Icon 
                  as={X} 
                  size={16} 
                  className="text-foreground"
                  strokeWidth={2}
                />
              </AnimatedPressable>

              {/* Stop/Send Button */}
              <AnimatedPressable 
                onPressIn={() => {
                  stopScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                }}
                onPressOut={() => {
                  stopScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                }}
                onPress={handleSendAudioMessage}
                className="bg-primary rounded-full items-center justify-center"
                style={[{ width: 40, height: 40 }, stopAnimatedStyle]}
              >
                <Icon 
                  as={CornerDownLeft} 
                  size={16} 
                  className="text-primary-foreground"
                  strokeWidth={2}
                />
              </AnimatedPressable>
            </View>
          </>
        ) : (
          /* Normal Text Input Mode */
          <>
            {/* Content Area - Text Only */}
            <View className="flex-1 mb-12">
              <ScrollView 
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {/* Text Input */}
                <TextInput
                  ref={textInputRef}
                  value={value}
                  onChangeText={onChangeText}
                  placeholder={effectivePlaceholder}
                  placeholderTextColor={
                    colorScheme === 'dark' 
                      ? 'rgba(248, 248, 248, 0.4)' 
                      : 'rgba(18, 18, 21, 0.4)'
                  }
                  multiline
                  scrollEnabled={false}
                  editable={!isSendingMessage && !isAgentRunning && !isTranscribing}
                  onContentSizeChange={(e) => {
                    const newHeight = e.nativeEvent.contentSize.height;
                    // Only log significant changes (every 50px)
                    if (Math.abs(newHeight - lastLoggedHeightRef.current) >= 50) {
                      console.log('📏 ChatInput height:', Math.round(newHeight), 'px');
                      lastLoggedHeightRef.current = newHeight;
                    }
                    setContentHeight(newHeight);
                  }}
                  className="text-foreground text-base"
                  style={{ 
                    fontFamily: 'Roobert-Regular',
                    minHeight: 52,
                    opacity: isSendingMessage || isAgentRunning || isTranscribing ? 0.5 : 1,
                  }}
                />
              </ScrollView>
            </View>
            
            {/* Bottom Action Bar */}
            <View className="absolute bottom-4 left-4 right-4 flex-row items-center justify-between">
              {/* Left Side - Attach Button & Quick Action Badge */}
              <View className="flex-row items-center gap-2">
                {/* Attach Button */}
                <AnimatedPressable 
                  onPressIn={() => {
                    attachScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    attachScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  onPress={onAttachPress}
                  disabled={isSendingMessage || isAgentRunning || isTranscribing}
                  className="bg-primary/5 rounded-full w-10 h-10 items-center justify-center border border-border/30"
                  style={[
                    attachAnimatedStyle,
                    { opacity: isSendingMessage || isAgentRunning || isTranscribing ? 0.4 : 1 }
                  ]}
                >
                  <Icon 
                    as={Paperclip} 
                    size={16} 
                    className="text-foreground"
                  />
                </AnimatedPressable>

                {/* Quick Action Context Badge - Entire badge is clickable */}
                {selectedQuickAction && QuickActionIcon && (
                  <Pressable 
                    onPress={() => {
                      console.log('❌ Clearing quick action context');
                      onClearQuickAction?.();
                    }}
                    className="bg-primary/10 rounded-full flex-row items-center h-10 px-3 border border-primary/20 active:opacity-70"
                  >
                    <Icon 
                      as={QuickActionIcon} 
                      size={16} 
                      className="text-primary mr-1.5"
                      strokeWidth={2}
                    />
                    <Icon 
                      as={X} 
                      size={14} 
                      className="text-primary"
                      strokeWidth={2}
                    />
                  </Pressable>
                )}
              </View>

              {/* Right Actions */}
              <View className="flex-row items-center gap-2">
                {/* Agent Selector with Full Name */}
                <AgentSelector onPress={onAgentPress} compact={false} />

                {/* Send/Stop/Audio Button */}
                <AnimatedPressable 
                  onPressIn={() => {
                    sendScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    sendScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  onPress={handleButtonPress}
                  disabled={isSendingMessage || isTranscribing}
                  className={`rounded-full items-center justify-center ${
                    isAgentRunning 
                      ? 'bg-foreground' 
                      : 'bg-primary'
                  }`}
                  style={[{ width: 40, height: 40 }, sendAnimatedStyle]}
                >
                  {isSendingMessage || isTranscribing ? (
                    <AnimatedView style={rotationAnimatedStyle}>
                      <Icon 
                        as={Loader2}
                        size={16} 
                        className="text-primary-foreground"
                        strokeWidth={2}
                      />
                    </AnimatedView>
                  ) : (
                    <Icon 
                      as={
                        isAgentRunning 
                          ? Square 
                          : hasContent 
                            ? CornerDownLeft 
                            : AudioLines
                      } 
                      size={isAgentRunning ? 14 : 16} 
                      className={isAgentRunning ? "text-background" : "text-primary-foreground"}
                      strokeWidth={2}
                    />
                  )}
                </AnimatedPressable>
              </View>
            </View>
          </>
        )}
      </View>
    </View>
  );
});

ChatInput.displayName = 'ChatInput';
