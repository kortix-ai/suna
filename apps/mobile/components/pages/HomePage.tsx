import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View, Keyboard } from 'react-native';
import { useColorScheme } from 'nativewind';
import { ChatInputSection, ChatDrawers, type ChatInputSectionRef } from '@/components/chat';
import { QuickActionBar } from '@/components/quick-actions';
import { BackgroundLogo, TopNav } from '@/components/home';
import { useChatCommons } from '@/hooks';
import type { UseChatReturn } from '@/hooks';

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
  // Use shared chat commons hook
  const { agentManager, audioRecorder, audioHandlers, isTranscribing } = useChatCommons(chat);
  const { colorScheme } = useColorScheme();
  
  // ChatInput ref for programmatic focus
  const chatInputRef = React.useRef<ChatInputSectionRef>(null);
  
  // Expose focus method via ref
  React.useImperativeHandle(ref, () => ({
    focusChatInput: () => {
      console.log('🎯 Focusing chat input from HomePage');
      chatInputRef.current?.focusInput();
    },
  }), []);


  return (
    <View className="flex-1 bg-background">
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

            {/* Quick Action Bar - positioned above chat input */}
            <View className="absolute bottom-0 left-0 right-0 pb-24" pointerEvents="box-none">
              <QuickActionBar 
                onActionPress={chat.handleQuickAction}
                selectedActionId={chat.selectedQuickAction}
                selectedOptionId={null}
                onSelectOption={() => {}}
              />
            </View>

            {/* Chat Input Section with Gradient */}
            <ChatInputSection
              ref={chatInputRef}
              value={chat.inputValue}
              onChangeText={chat.setInputValue}
              onSendMessage={(content, agentId, agentName) => {
                // Both ChatInputSection and sendMessage expect non-null strings
                // This should never receive empty strings from ChatInput
                chat.sendMessage(content, agentId, agentName);
              }}
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
              audioLevel={audioRecorder.audioLevel}
              audioLevels={audioRecorder.audioLevels}
              attachments={chat.attachments}
              onRemoveAttachment={chat.removeAttachment}
              selectedQuickAction={chat.selectedQuickAction}
              onClearQuickAction={chat.clearQuickAction}
              isAuthenticated={isAuthenticated}
              onOpenAuthDrawer={onOpenAuthDrawer}
              isAgentRunning={chat.isAgentRunning}
              isSendingMessage={chat.isSendingMessage}
              isTranscribing={isTranscribing}
            />
          </View>
        </Pressable>

        {/* Shared Drawers */}
        <ChatDrawers
          isAgentDrawerVisible={agentManager.isDrawerVisible}
          onCloseAgentDrawer={agentManager.closeDrawer}
          isAttachmentDrawerVisible={chat.isAttachmentDrawerVisible}
          onCloseAttachmentDrawer={chat.closeAttachmentDrawer}
          onTakePicture={chat.handleTakePicture}
          onChooseImages={chat.handleChooseImages}
          onChooseFiles={chat.handleChooseFiles}
        />
      </KeyboardAvoidingView>
    </View>
  );
});

HomePage.displayName = 'HomePage';
