import * as React from 'react';
import { View, Pressable, Keyboard } from 'react-native';
import { runOnJS } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { ChatInputSection, ChatDrawers, type ChatInputSectionRef } from '@/components/chat';
import { QUICK_ACTIONS, ModeThreadListView } from '@/components/quick-actions';
import { TopNav, BackgroundLogo } from '@/components/home';
import { useRouter } from 'expo-router';
import { UsageDrawer } from '@/components/settings/UsageDrawer';
import { useChatCommons } from '@/hooks';
import type { UseChatReturn } from '@/hooks';
import { usePricingModalStore } from '@/stores/billing-modal-store';
import { log } from '@/lib/logger';

const SWIPE_THRESHOLD = 50;

interface HomePageProps {
  onMenuPress?: () => void;
  chat: UseChatReturn;
  isAuthenticated: boolean;
  onOpenWorkerConfig?: (
    workerId: string,
    view?: 'instructions' | 'tools' | 'integrations' | 'triggers'
  ) => void;
  showThreadListView?: boolean; // Flag to show ModeThreadListView instead of BackgroundLogo
}

export interface HomePageRef {
  focusChatInput: () => void;
}

export const HomePage = React.forwardRef<HomePageRef, HomePageProps>(
  ({ onMenuPress, chat, isAuthenticated, onOpenWorkerConfig: externalOpenWorkerConfig, showThreadListView = false }, ref) => {
    const router = useRouter();
    const { agentManager, audioRecorder, audioHandlers, isTranscribing } = useChatCommons(chat);

    const { creditsExhausted } = usePricingModalStore();
    const [isUsageDrawerOpen, setIsUsageDrawerOpen] = React.useState(false);
    const [isWorkerConfigDrawerVisible, setIsWorkerConfigDrawerVisible] = React.useState(false);
    const [workerConfigWorkerId, setWorkerConfigWorkerId] = React.useState<string | null>(null);
    const [workerConfigInitialView, setWorkerConfigInitialView] = React.useState<
      'instructions' | 'tools' | 'integrations' | 'triggers' | undefined
    >(undefined);

    const chatInputRef = React.useRef<ChatInputSectionRef>(null);
    const lastSwipeIndex = React.useRef(-1);

    // Find current selected index for swipe gestures
    const selectedIndex = React.useMemo(() => {
      const index = QUICK_ACTIONS.findIndex((a) => a.id === chat.selectedQuickAction);
      return index >= 0 ? index : 0;
    }, [chat.selectedQuickAction]);

    // Switch to a specific mode index
    const switchToMode = React.useCallback(
      (newIndex: number) => {
        const clampedIndex = Math.max(0, Math.min(newIndex, QUICK_ACTIONS.length - 1));
        if (clampedIndex !== lastSwipeIndex.current) {
          lastSwipeIndex.current = clampedIndex;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          chat.handleQuickAction(QUICK_ACTIONS[clampedIndex].id);
        }
      },
      [chat]
    );

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

    React.useImperativeHandle(
      ref,
      () => ({
        focusChatInput: () => {
          chatInputRef.current?.focusInput();
        },
      }),
      []
    );

    const handleUpgradePress = React.useCallback(() => {
      router.push({
        pathname: '/plans',
        params: { creditsExhausted: creditsExhausted ? 'true' : 'false' },
      });
    }, [router, creditsExhausted]);

    const handleCreditsPress = React.useCallback(() => {
      router.push('/usage');
    }, [router]);

    const handleCloseUsageDrawer = React.useCallback(() => {
      setIsUsageDrawerOpen(false);
    }, []);

    const handleUpgradeFromUsage = React.useCallback(() => {
      setIsUsageDrawerOpen(false);
      router.push({
        pathname: '/plans',
        params: { creditsExhausted: creditsExhausted ? 'true' : 'false' },
      });
    }, [router, creditsExhausted]);

    const handleThreadPressFromUsage = React.useCallback(
      (threadId: string, _projectId: string | null) => {
        log.log('🎯 Loading thread from UsageDrawer:', threadId);
        chat.loadThread(threadId);
      },
      [chat]
    );

    // Memoized handlers for ChatInputSection to prevent re-renders
    const handleSendMessage = React.useCallback(
      (content: string, agentId: string, agentName: string) => {
        chat.sendMessage(content, agentId, agentName);
      },
      [chat]
    );

    const handleQuickActionSelectOption = React.useCallback(
      (optionId: string) => {
        chat.setSelectedQuickActionOption(optionId);
      },
      [chat]
    );

    const handleQuickActionSelectPrompt = React.useCallback(
      (prompt: string) => {
        chat.setInputValue(prompt);
        chatInputRef.current?.focusInput();
      },
      [chat]
    );

    const handleQuickActionThreadPress = React.useCallback(
      (threadId: string) => {
        log.log('🎯 Loading thread from mode history:', threadId);
        chat.showModeThread(threadId);
      },
      [chat]
    );

    // Ref to store pending worker config (to handle race condition)
    const pendingWorkerConfigRef = React.useRef<{
      workerId: string;
      view?: 'instructions' | 'tools' | 'integrations' | 'triggers';
    } | null>(null);

    const handleCloseWorkerConfigDrawer = React.useCallback(() => {
      setIsWorkerConfigDrawerVisible(false);
      setWorkerConfigWorkerId(null);
      setWorkerConfigInitialView(undefined);
    }, []);

    const handleOpenWorkerConfig = React.useCallback(
      (workerId: string, view?: 'instructions' | 'tools' | 'integrations' | 'triggers') => {
        log.log('🔧 [HomePage] Opening worker config:', workerId, view);
        // If external handler is provided, use it to redirect to MenuPage
        if (externalOpenWorkerConfig) {
          externalOpenWorkerConfig(workerId, view);
          return;
        }
        // Fallback: Store the pending config and open locally
        pendingWorkerConfigRef.current = { workerId, view };
        // Close the agent drawer - we'll open worker config in the dismiss callback
        agentManager.closeDrawer();
      },
      [agentManager, externalOpenWorkerConfig]
    );

    const handleAgentDrawerDismiss = React.useCallback(() => {
      log.log('🎭 [HomePage] AgentDrawer dismissed');
      // Check if there's a pending worker config to open
      if (pendingWorkerConfigRef.current) {
        const { workerId, view } = pendingWorkerConfigRef.current;
        pendingWorkerConfigRef.current = null;
        log.log('🔧 [HomePage] Opening pending worker config:', workerId, view);
        setWorkerConfigWorkerId(workerId);
        setWorkerConfigInitialView(view);
        setIsWorkerConfigDrawerVisible(true);
      }
    }, []);

    return (
      <View className="flex-1 bg-background">
        {/* Main content container - keyboard handling is done in ChatInputSection */}
        <View className="relative flex-1">
          <TopNav
            onMenuPress={onMenuPress}
            onUpgradePress={handleUpgradePress}
            onCreditsPress={handleCreditsPress}
          />

          {/* Content Area - Show either thread list or background logo */}
          {/* Tapping outside chat input dismisses keyboard */}
          <Pressable className="flex-1" onPress={Keyboard.dismiss}>
            <GestureDetector gesture={panGesture}>
              <View className="flex-1">
                {showThreadListView ? (
                  <ModeThreadListView
                    modeId={chat.selectedQuickAction || 'slides'}
                    onThreadPress={handleQuickActionThreadPress}
                  />
                ) : (
                  <BackgroundLogo />
                )}
              </View>
            </GestureDetector>
          </Pressable>

          {/* Chat Input Section - handles its own keyboard avoidance */}
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
            onQuickActionThreadPress={handleQuickActionThreadPress}
            isAuthenticated={isAuthenticated}
            isAgentRunning={chat.isAgentRunning}
            isSendingMessage={chat.isSendingMessage}
            isTranscribing={isTranscribing}
            showQuickActions={true}
          />
        </View>

        {/* Drawers - rendered outside the main content flow */}
        <ChatDrawers
          isAgentDrawerVisible={agentManager.isDrawerVisible}
          onCloseAgentDrawer={agentManager.closeDrawer}
          onOpenWorkerConfig={handleOpenWorkerConfig}
          onAgentDrawerDismiss={handleAgentDrawerDismiss}
          isWorkerConfigDrawerVisible={isWorkerConfigDrawerVisible}
          workerConfigWorkerId={workerConfigWorkerId}
          workerConfigInitialView={workerConfigInitialView}
          onCloseWorkerConfigDrawer={handleCloseWorkerConfigDrawer}
          isAttachmentDrawerVisible={chat.isAttachmentDrawerVisible}
          onCloseAttachmentDrawer={chat.closeAttachmentDrawer}
          onTakePicture={chat.handleTakePicture}
          onChooseImages={chat.handleChooseImages}
          onChooseFiles={chat.handleChooseFiles}
        />
        {isUsageDrawerOpen && (
          <UsageDrawer
            visible={isUsageDrawerOpen}
            onClose={handleCloseUsageDrawer}
            onUpgradePress={handleUpgradeFromUsage}
            onThreadPress={handleThreadPressFromUsage}
          />
        )}
      </View>
    );
  }
);

HomePage.displayName = 'HomePage';
