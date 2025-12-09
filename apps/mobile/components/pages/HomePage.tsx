import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View, Keyboard } from 'react-native';
import Animated, { 
  FadeIn,
  runOnJS,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { ChatInputSection, ChatDrawers, type ChatInputSectionRef } from '@/components/chat';
import { QUICK_ACTIONS } from '@/components/quick-actions';
import { BackgroundLogo, TopNav } from '@/components/home';
import { useRouter } from 'expo-router';
import { UsageDrawer } from '@/components/settings/UsageDrawer';
import { CreditsPurchasePage } from '@/components/settings/CreditsPurchasePage';
import { useChatCommons } from '@/hooks';
import type { UseChatReturn } from '@/hooks';
import { usePricingModalStore } from '@/stores/billing-modal-store';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useLanguage } from '@/contexts';

const SWIPE_THRESHOLD = 50;

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
  const router = useRouter();
  const { t } = useLanguage();
  const { agentManager, audioRecorder, audioHandlers, isTranscribing } = useChatCommons(chat);

  const { creditsExhausted } = usePricingModalStore();
  const [isUsageDrawerOpen, setIsUsageDrawerOpen] = React.useState(false);
  const [isCreditsPurchaseOpen, setIsCreditsPurchaseOpen] = React.useState(false);

  const chatInputRef = React.useRef<ChatInputSectionRef>(null);
  const lastSwipeIndex = React.useRef(-1);

  // Find current selected index
  const selectedIndex = React.useMemo(() => {
    const index = QUICK_ACTIONS.findIndex(a => a.id === chat.selectedQuickAction);
    return index >= 0 ? index : 0;
  }, [chat.selectedQuickAction]);

  // Find selected action for the header
  const selectedAction = React.useMemo(() => {
    if (!chat.selectedQuickAction) return QUICK_ACTIONS[0];
    return QUICK_ACTIONS.find(a => a.id === chat.selectedQuickAction) || QUICK_ACTIONS[0];
  }, [chat.selectedQuickAction]);

  const selectedActionLabel = React.useMemo(() => {
    if (!selectedAction) return '';
    return t(`quickActions.${selectedAction.id}`, { defaultValue: selectedAction.label });
  }, [selectedAction, t]);

  // Switch to a specific mode index
  const switchToMode = React.useCallback((newIndex: number) => {
    const clampedIndex = Math.max(0, Math.min(newIndex, QUICK_ACTIONS.length - 1));
    if (clampedIndex !== lastSwipeIndex.current) {
      lastSwipeIndex.current = clampedIndex;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      chat.handleQuickAction(QUICK_ACTIONS[clampedIndex].id);
    }
  }, [chat]);

  // Update last swipe index when selection changes
  React.useEffect(() => {
    lastSwipeIndex.current = selectedIndex;
  }, [selectedIndex]);

  // Pan gesture for swiping on the main content
  const panGesture = Gesture.Pan()
    .activeOffsetX([-25, 25])
    .failOffsetY([-20, 20])
    .onEnd((event) => {
      const currentIndex = selectedIndex;
      
      if (event.translationX < -SWIPE_THRESHOLD || event.velocityX < -500) {
        // Swipe left - next mode
        runOnJS(switchToMode)(currentIndex + 1);
      } else if (event.translationX > SWIPE_THRESHOLD || event.velocityX > 500) {
        // Swipe right - previous mode
        runOnJS(switchToMode)(currentIndex - 1);
      }
    });

  React.useImperativeHandle(ref, () => ({
    focusChatInput: () => {
      chatInputRef.current?.focusInput();
    },
  }), []);

  const handleUpgradePress = React.useCallback(() => {
    router.push({
      pathname: '/plans',
      params: { creditsExhausted: creditsExhausted ? 'true' : 'false' },
    });
  }, [router, creditsExhausted]);

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
    router.push({
      pathname: '/plans',
      params: { creditsExhausted: creditsExhausted ? 'true' : 'false' },
    });
  }, [router, creditsExhausted]);

  const handleThreadPressFromUsage = React.useCallback((threadId: string, _projectId: string | null) => {
    console.log('🎯 Loading thread from UsageDrawer:', threadId);
    chat.loadThread(threadId);
  }, [chat]);

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
        <View className="flex-1 relative">
          <TopNav
            onMenuPress={onMenuPress}
            onUpgradePress={handleUpgradePress}
            onCreditsPress={handleCreditsPress}
          />
          
          {/* Swipeable content area */}
          <GestureDetector gesture={panGesture}>
            <View className="flex-1">
              <Pressable
                className="flex-1"
                onPress={Keyboard.dismiss}
                accessible={false}
              >
                {/* Mode Header - Shows current mode icon and name */}
                {selectedAction && (
                  <Animated.View 
                    key={selectedAction.id}
                    entering={FadeIn.duration(150)}
                    className="px-4 pb-4"
                    style={{ marginTop: 127 }}
                  >
                    <View className="flex-row items-center gap-3">
                      <Icon 
                        as={selectedAction.icon} 
                        size={28} 
                        className="text-foreground"
                        strokeWidth={2}
                      />
                      <Text className="text-3xl font-roobert-semibold text-foreground">
                        {selectedActionLabel}
                      </Text>
                    </View>
                  </Animated.View>
                )}

                <View className="absolute inset-0 -z-10" pointerEvents="none">
                  <BackgroundLogo />
                </View>
              </Pressable>
            </View>
          </GestureDetector>

          {/* Chat Input Section - Static, not part of swipe */}
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

        <ChatDrawers
          isAgentDrawerVisible={agentManager.isDrawerVisible}
          onCloseAgentDrawer={agentManager.closeDrawer}
          isAttachmentDrawerVisible={chat.isAttachmentDrawerVisible}
          onCloseAttachmentDrawer={chat.closeAttachmentDrawer}
          onTakePicture={chat.handleTakePicture}
          onChooseImages={chat.handleChooseImages}
          onChooseFiles={chat.handleChooseFiles}
        />
        <UsageDrawer
          visible={isUsageDrawerOpen}
          onClose={handleCloseUsageDrawer}
          onUpgradePress={handleUpgradeFromUsage}
          onTopUpPress={handleTopUpPress}
          onThreadPress={handleThreadPressFromUsage}
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
