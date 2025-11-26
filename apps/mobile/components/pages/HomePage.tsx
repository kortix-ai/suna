import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View, Keyboard } from 'react-native';
import { useColorScheme } from 'nativewind';
import { ChatInputSection, ChatDrawers, type ChatInputSectionRef } from '@/components/chat';
import { QuickActionBar } from '@/components/quick-actions';
import { BackgroundLogo, TopNav } from '@/components/home';
import { PlanSelectionModal } from '@/components/billing/PlanSelectionModal';
import { UsageDrawer } from '@/components/settings/UsageDrawer';
import { CreditsPurchasePage } from '@/components/settings/CreditsPurchasePage';
import { useChatCommons } from '@/hooks';
import type { UseChatReturn } from '@/hooks';
import { usePricingModalStore } from '@/stores/billing-modal-store';

interface HomePageProps {
  onMenuPress?: () => void;
  chat: UseChatReturn;
  isAuthenticated: boolean;
}

export interface HomePageRef {
  focusChatInput: () => void;
}

export const HomePage = React.forwardRef<HomePageRef, HomePageProps>(({
  onMenuPress,
  chat,
  isAuthenticated,
}, ref) => {
  const { agentManager, audioRecorder, audioHandlers, isTranscribing } = useChatCommons(chat);

  const { isOpen: isPricingModalOpen, alertTitle, creditsExhausted, closePricingModal } = usePricingModalStore();
  const [isUsageDrawerOpen, setIsUsageDrawerOpen] = React.useState(false);
  const [isCreditsPurchaseOpen, setIsCreditsPurchaseOpen] = React.useState(false);

  const chatInputRef = React.useRef<ChatInputSectionRef>(null);

  React.useImperativeHandle(ref, () => ({
    focusChatInput: () => {
      chatInputRef.current?.focusInput();
    },
  }), []);

  const handleUpgradePress = React.useCallback(() => {
    usePricingModalStore.getState().openPricingModal();
  }, []);

  const handleClosePricingModal = React.useCallback(() => {
    closePricingModal();
  }, [closePricingModal]);

  const handleCreditsPress = React.useCallback(() => {
    setIsUsageDrawerOpen(true);
  }, []);

  const handleCloseUsageDrawer = React.useCallback(() => {
    setIsUsageDrawerOpen(false);
  }, []);

  const handleTopUpPress = React.useCallback(() => {
    setIsUsageDrawerOpen(false);
    setIsCreditsPurchaseOpen(true);
  }, []);

  const handleCloseCreditsPurchase = React.useCallback(() => {
    setIsCreditsPurchaseOpen(false);
  }, []);

  const handleUpgradeFromUsage = React.useCallback(() => {
    setIsUsageDrawerOpen(false);
    usePricingModalStore.getState().openPricingModal();
  }, []);

  // Memoized handlers for ChatInputSection to prevent re-renders
  const handleSendMessage = React.useCallback((content: string, agentId: string, agentName: string) => {
    chat.sendMessage(content, agentId, agentName);
  }, [chat]);

  const handleQuickActionSelectOption = React.useCallback((optionId: string) => {
    chat.setSelectedQuickActionOption(optionId);
  }, [chat]);

  const handleQuickActionSelectPrompt = React.useCallback((prompt: string) => {
    chat.setInputValue(prompt);
    chatInputRef.current?.focusInput();
  }, [chat]);

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
              onCreditsPress={handleCreditsPress}
            />
            <View className="absolute inset-0" pointerEvents="none">
              <BackgroundLogo />
            </View>
            <ChatInputSection
              ref={chatInputRef}
              value={chat.inputValue}
              onChangeText={chat.setInputValue}
              onSendMessage={handleSendMessage}
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
              onQuickActionPress={chat.handleQuickAction}
              onQuickActionSelectOption={handleQuickActionSelectOption}
              onQuickActionSelectPrompt={handleQuickActionSelectPrompt}
              isAuthenticated={isAuthenticated}
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
        <PlanSelectionModal
          open={isPricingModalOpen}
          onOpenChange={handleClosePricingModal}
          creditsExhausted={creditsExhausted}
        />
        <UsageDrawer
          visible={isUsageDrawerOpen}
          onClose={handleCloseUsageDrawer}
          onUpgradePress={handleUpgradeFromUsage}
          onTopUpPress={handleTopUpPress}
        />
        <CreditsPurchasePage
          visible={isCreditsPurchaseOpen}
          onClose={handleCloseCreditsPurchase}
        />
      </KeyboardAvoidingView>
    </View>
  );
});

HomePage.displayName = 'HomePage';
