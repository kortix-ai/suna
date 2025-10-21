import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View, Keyboard } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import Animated, { 
  useAnimatedStyle, 
  withSpring,
  useAnimatedKeyboard,
} from 'react-native-reanimated';
import { AgentDrawer } from '@/components/agents';
import { AttachmentDrawer } from '@/components/attachments';
import { ChatInput, type ChatInputRef } from '@/components/chat';
import { QuickActionBar } from '@/components/quick-actions';
import { BackgroundLogo, TopNav } from '@/components/home';
import { useAgentManager, useAudioRecorder, useAudioRecordingHandlers, type UseChatReturn } from '@/hooks';

interface HomePageProps {
  onMenuPress?: () => void;
  chat: UseChatReturn;
  isAuthenticated: boolean;
  onOpenAuthDrawer: () => void;
}

export interface HomePageRef {
  focusChatInput: () => void;
}

/**
 * HomePage Component
 * 
 * Main home/chat page for starting new conversations.
 * This is page 1 (center) in the swipeable pager.
 * 
 * Features:
 * - Top navigation with menu access
 * - Animated background logo
 * - Chat input with audio recording
 * - Agent selection drawer
 * - Quick action bar for contextual prompts
 * - Auth protection for sending messages
 * - Programmatic chat input focus support
 */
export const HomePage = React.forwardRef<HomePageRef, HomePageProps>(({
  onMenuPress,
  chat,
  isAuthenticated,
  onOpenAuthDrawer,
}, ref) => {
  // Custom hooks - Clean separation of concerns
  const agentManager = useAgentManager();
  const audioRecorder = useAudioRecorder();
  const audioHandlers = useAudioRecordingHandlers(audioRecorder, agentManager);
  const { colorScheme } = useColorScheme();
  
  // ChatInput ref for programmatic focus
  const chatInputRef = React.useRef<ChatInputRef>(null);
  
  // Expose focus method via ref
  React.useImperativeHandle(ref, () => ({
    focusChatInput: () => {
      console.log('🎯 Focusing chat input from HomePage');
      chatInputRef.current?.focus();
    },
  }), []);

  // Snappy keyboard animation - instant response
  const keyboard = useAnimatedKeyboard();
  
  const animatedBottomStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateY: withSpring(-keyboard.height.value, {
            damping: 20,               // Low damping = very fast
            stiffness: 500,            // Very high stiffness = instant snap
            mass: 0.5,                 // Very light = instant response
            overshootClamping: true,   // No overshoot = direct movement
          }),
        },
      ],
    };
  });

  return (
    <View className="flex-1 bg-background" style={{ overflow: 'hidden' }}>
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
        keyboardVerticalOffset={0}
        enabled={false}
      >
        <Pressable 
          className="flex-1" 
          onPress={Keyboard.dismiss}
          accessible={false}
        >
          <View className="flex-1 relative">
            {/* Top Navigation */}
            <TopNav onMenuPress={onMenuPress} />

            {/* New Chat View with Background Logo */}
            <View className="absolute inset-0" pointerEvents="none">
              <BackgroundLogo />
            </View>

            {/* Bottom Section with Gradient and Chat Input - Smooth keyboard animation */}
            <Animated.View 
              className="absolute bottom-0 left-0 right-0" 
              pointerEvents="box-none"
              style={animatedBottomStyle}
            >
              {/* Gradient fade from transparent to background */}
              <LinearGradient
                colors={
                  colorScheme === 'dark'
                    ? ['rgba(18, 18, 21, 0)', 'rgba(18, 18, 21, 0.85)', 'rgba(18, 18, 21, 1)']
                    : ['rgba(248, 248, 248, 0)', 'rgba(248, 248, 248, 0.85)', 'rgba(248, 248, 248, 1)']
                }
                locations={[0, 0.4, 1]}
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 250,
                }}
                pointerEvents="none"
              />
              
              {/* Quick Action Bar */}
              <QuickActionBar 
                onActionPress={chat.handleQuickAction}
                selectedActionId={chat.selectedQuickAction}
                selectedOptionId={null}
                onSelectOption={() => {}}
              />
              
              {/* Chat Input */}
              <View className="mx-3 mb-8">
                <ChatInput
                  ref={chatInputRef}
                  value={chat.inputValue}
                  onChangeText={chat.setInputValue}
                  onSendMessage={(content, agentId, agentName) => chat.sendMessage(content, agentId, agentName)}
                  onSendAudio={audioHandlers.handleSendAudio}
                  onAttachPress={chat.openAttachmentDrawer}
                  onAgentPress={agentManager.openDrawer}
                  onAudioRecord={audioHandlers.handleStartRecording}
                  onCancelRecording={audioHandlers.handleCancelRecording}
                  onStopAgentRun={chat.stopAgent}
                  placeholder={chat.getPlaceholder()}
                  agent={agentManager.selectedAgent || undefined}
                  isRecording={audioRecorder.isRecording}
                  recordingDuration={audioRecorder.recordingDuration}
                  attachments={chat.attachments}
                  onRemoveAttachment={chat.removeAttachment}
                  selectedQuickAction={chat.selectedQuickAction}
                  onClearQuickAction={chat.clearQuickAction}
                  isAuthenticated={isAuthenticated}
                  onOpenAuthDrawer={onOpenAuthDrawer}
                  isAgentRunning={chat.isAgentRunning}
                  isSendingMessage={chat.isSendingMessage}
                />
              </View>
            </Animated.View>
          </View>
        </Pressable>

        {/* Agent Drawer */}
        <AgentDrawer
          visible={agentManager.isDrawerVisible}
          onClose={agentManager.closeDrawer}
        />

        {/* Attachment Drawer */}
        <AttachmentDrawer
          visible={chat.isAttachmentDrawerVisible}
          onClose={chat.closeAttachmentDrawer}
          onTakePicture={chat.handleTakePicture}
          onChooseImages={chat.handleChooseImages}
          onChooseFiles={chat.handleChooseFiles}
        />
      </KeyboardAvoidingView>
    </View>
  );
});

HomePage.displayName = 'HomePage';
