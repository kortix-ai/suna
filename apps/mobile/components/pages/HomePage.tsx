import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View, Keyboard } from 'react-native';
import { useColorScheme } from 'nativewind';
import { ChatInputSection, ChatDrawers, type ChatInputSectionRef } from '@/components/chat';
import { QuickActionBar } from '@/components/quick-actions';
import { BackgroundLogo, TopNav } from '@/components/home';
import { BillingPage } from '@/components/settings/BillingPage';
import { CreditsPurchasePage } from '@/components/settings/CreditsPurchasePage';
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

export const HomePage = React.forwardRef<HomePageRef, HomePageProps>(({
  onMenuPress,
  chat,
  isAuthenticated,
  onOpenAuthDrawer,
}, ref) => {
  const { agentManager, audioRecorder, audioHandlers, isTranscribing } = useChatCommons(chat);
  const [isBillingPageVisible, setIsBillingPageVisible] = React.useState(false);
  const [isCreditsPurchasePageVisible, setIsCreditsPurchasePageVisible] = React.useState(false);
  
  const chatInputRef = React.useRef<ChatInputSectionRef>(null);
  
  React.useImperativeHandle(ref, () => ({
    focusChatInput: () => {
      console.log('🎯 Focusing chat input from HomePage');
      chatInputRef.current?.focusInput();
    },
  }), []);

  const handleUpgradePress = React.useCallback(() => {
    console.log('🎯 Upgrade button pressed - opening billing page');
    setIsBillingPageVisible(true);
  }, []);

  const handleCloseBilling = React.useCallback(() => {
    console.log('🎯 Billing page closed');
    setIsBillingPageVisible(false);
  }, []);

  const handleOpenCredits = React.useCallback(() => {
    console.log('🎯 Opening credits purchase page');
    setIsBillingPageVisible(false);
    setIsCreditsPurchasePageVisible(true);
  }, []);

  const handleCloseCredits = React.useCallback(() => {
    console.log('🎯 Credits purchase page closed');
    setIsCreditsPurchasePageVisible(false);
  }, []);


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
            <TopNav 
              onMenuPress={onMenuPress} 
              onUpgradePress={handleUpgradePress} 
            />
            <View className="absolute inset-0" pointerEvents="none">
              <BackgroundLogo />
            </View>
            <View className="absolute bottom-40 left-0 right-0 pb-2 z-10" pointerEvents="box-none">
              <QuickActionBar 
                onActionPress={chat.handleQuickAction}
                selectedActionId={chat.selectedQuickAction}
                selectedOptionId={chat.selectedQuickActionOption}
                onSelectOption={(optionId) => {
                  console.log('🎯 Option selected:', optionId);
                  chat.setSelectedQuickActionOption(optionId);
                }}
                onSelectPrompt={(prompt) => {
                  console.log('📝 Loading prompt into input:', prompt);
                  chat.setInputValue(prompt);
                  // Also focus the input so the user can immediately edit or send
                  chatInputRef.current?.focusInput();
                }}
              />
            </View>
            <ChatInputSection
              ref={chatInputRef}
              value={chat.inputValue}
              onChangeText={chat.setInputValue}
              onSendMessage={(content, agentId, agentName) => {
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
              selectedQuickActionOption={chat.selectedQuickActionOption}
              onClearQuickAction={chat.clearQuickAction}
              isAuthenticated={isAuthenticated}
              onOpenAuthDrawer={onOpenAuthDrawer}
              isAgentRunning={chat.isAgentRunning}
              isSendingMessage={chat.isSendingMessage}
              isTranscribing={isTranscribing}
            />
          </View>
        </Pressable>
        <ChatDrawers
          isAgentDrawerVisible={agentManager.isDrawerVisible}
          onCloseAgentDrawer={agentManager.closeDrawer}
          isAttachmentDrawerVisible={chat.isAttachmentDrawerVisible}
          onCloseAttachmentDrawer={chat.closeAttachmentDrawer}
          onTakePicture={chat.handleTakePicture}
          onChooseImages={chat.handleChooseImages}
          onChooseFiles={chat.handleChooseFiles}
        />
        <BillingPage
          visible={isBillingPageVisible}
          onClose={handleCloseBilling}
          onOpenCredits={handleOpenCredits}
          onOpenUsage={() => {}}
        />
        <CreditsPurchasePage
          visible={isCreditsPurchasePageVisible}
          onClose={handleCloseCredits}
        />
      </KeyboardAvoidingView>
    </View>
  );
});

HomePage.displayName = 'HomePage';
