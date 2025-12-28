import * as React from 'react';
import { Platform, Pressable, View, ScrollView, Alert, Modal, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import Animated, {
  useAnimatedStyle,
  withTiming,
  useSharedValue,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import LottieView from 'lottie-react-native';
import {
  ThreadContent,
  ChatInputSection,
  ChatDrawers,
  type ToolMessagePair,
  CHAT_INPUT_SECTION_HEIGHT,
} from '@/components/chat';
import { ThreadHeader } from '@/components/threads';
import { KortixComputer } from '@/components/kortix-computer';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useChatCommons, type UseChatReturn, useDeleteThread, useShareThread } from '@/hooks';
import { useThread } from '@/lib/chat';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MessageCircle, ArrowDown, AlertCircle } from 'lucide-react-native';
import { useRouter } from 'expo-router';

interface ThreadPageProps {
  onMenuPress?: () => void;
  chat: UseChatReturn;
  isAuthenticated: boolean;
  onOpenWorkerConfig?: (
    workerId: string,
    view?: 'instructions' | 'tools' | 'integrations' | 'triggers'
  ) => void;
}

const DynamicIslandRefresh = React.memo(function DynamicIslandRefresh({
  isRefreshing,
  insets,
}: {
  isRefreshing: boolean;
  insets: { top: number };
}) {
  const width = useSharedValue(126);
  const height = useSharedValue(37);
  const borderTopRadius = useSharedValue(20);
  const borderBottomRadius = useSharedValue(20);
  const opacity = useSharedValue(0);
  const contentOpacity = useSharedValue(0);
  const contentTranslateY = useSharedValue(0);
  const lottieRef = React.useRef<LottieView>(null);

  React.useEffect(() => {
    if (isRefreshing) {
      opacity.value = 1;
      contentOpacity.value = 0;
      width.value = 126;
      height.value = 37;
      borderTopRadius.value = 20;
      borderBottomRadius.value = 20;
      contentTranslateY.value = -20;

      // Start Lottie animation
      lottieRef.current?.play();

      width.value = withTiming(160, {
        duration: 450,
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94),
      });

      height.value = withTiming(90, {
        duration: 450,
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94),
      });

      borderTopRadius.value = withTiming(30, {
        duration: 450,
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94),
      });

      borderBottomRadius.value = withTiming(24, {
        duration: 450,
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94),
      });

      contentTranslateY.value = withDelay(
        100,
        withTiming(20, {
          duration: 350,
          easing: Easing.bezier(0.25, 0.46, 0.45, 0.94),
        })
      );

      contentOpacity.value = withDelay(200, withTiming(1, { duration: 200 }));
    } else if (opacity.value === 1) {
      // Stop Lottie animation
      lottieRef.current?.pause();

      contentOpacity.value = withTiming(0, { duration: 150 });
      contentTranslateY.value = withTiming(-20, {
        duration: 250,
        easing: Easing.bezier(0.5, 0, 0.75, 0),
      });

      setTimeout(() => {
        width.value = withTiming(126, {
          duration: 400,
          easing: Easing.bezier(0.33, 0, 0.67, 1),
        });

        borderTopRadius.value = withTiming(20, {
          duration: 400,
          easing: Easing.bezier(0.33, 0, 0.67, 1),
        });

        borderBottomRadius.value = withTiming(20, {
          duration: 400,
          easing: Easing.bezier(0.33, 0, 0.67, 1),
        });

        height.value = withTiming(37, {
          duration: 400,
          easing: Easing.bezier(0.33, 0, 0.67, 1),
        });

        setTimeout(() => {
          opacity.value = withTiming(0, {
            duration: 300,
            easing: Easing.bezier(0.25, 0.1, 0.25, 1),
          });
        }, 350);
      }, 150);
    }
  }, [isRefreshing]);

  const animatedContainerStyle = useAnimatedStyle(() => ({
    width: width.value,
    height: height.value,
    borderTopLeftRadius: borderTopRadius.value,
    borderTopRightRadius: borderTopRadius.value,
    borderBottomLeftRadius: borderBottomRadius.value,
    borderBottomRightRadius: borderBottomRadius.value,
    opacity: opacity.value,
  }));

  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
    transform: [{ translateY: contentTranslateY.value }],
  }));

  return (
    <>
      {Platform.OS === 'ios' && (
        <View
          className="absolute w-full items-center"
          style={{
            top: 11,
            zIndex: 9999,
            elevation: 999,
          }}
          pointerEvents="none">
          <Animated.View
            style={[
              animatedContainerStyle,
              {
                backgroundColor: 'black',
                overflow: 'hidden',
                justifyContent: 'center',
                alignItems: 'center',
              },
            ]}>
            <Animated.View style={contentStyle} className="flex-row items-center gap-2">
              <LottieView
                ref={lottieRef}
                source={require('@/components/animations/loading.json')}
                style={{ width: 20, height: 20 }}
                autoPlay={false}
                loop
                speed={1.5}
              />
              <Text style={{ color: 'white', fontSize: 13, fontFamily: 'Roobert-Medium' }}>
                Refreshing
              </Text>
            </Animated.View>
          </Animated.View>
        </View>
      )}
    </>
  );
});

export function ThreadPage({
  onMenuPress,
  chat,
  isAuthenticated,
  onOpenWorkerConfig: externalOpenWorkerConfig,
}: ThreadPageProps) {
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  const { agentManager, audioRecorder, audioHandlers, isTranscribing } = useChatCommons(chat);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [selectedToolData, setSelectedToolData] = React.useState<{
    toolMessages: ToolMessagePair[];
    initialIndex: number;
  } | null>(null);

  // Handle upgrade press - navigate to plans page
  const handleUpgradePress = React.useCallback(() => {
    router.push('/plans');
  }, [router]);
  const [isWorkerConfigDrawerVisible, setIsWorkerConfigDrawerVisible] = React.useState(false);
  const [workerConfigWorkerId, setWorkerConfigWorkerId] = React.useState<string | null>(null);
  const [workerConfigInitialView, setWorkerConfigInitialView] = React.useState<
    'instructions' | 'tools' | 'integrations' | 'triggers'
  >('instructions');

  // Use REF instead of state to avoid stale closure issues in callbacks
  const pendingWorkerConfigRef = React.useRef<{
    workerId: string;
    view?: 'instructions' | 'tools' | 'integrations' | 'triggers';
  } | null>(null);
  const pendingWorkerConfigTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (pendingWorkerConfigTimeoutRef.current) {
        clearTimeout(pendingWorkerConfigTimeoutRef.current);
      }
    };
  }, []);

  const {
    isOpen: isKortixComputerOpen,
    openPanel,
    openFileInComputer,
    openFileBrowser,
  } = useKortixComputerStore();

  const deleteThreadMutation = useDeleteThread();
  const shareThreadMutation = useShareThread();

  const { data: fullThreadData, refetch: refetchThreadData } = useThread(chat.activeThread?.id);

  React.useEffect(() => {
    if (isKortixComputerOpen) {
      refetchThreadData();
    } else {
      // Clear selected tool data when panel closes
      setSelectedToolData(null);
    }
  }, [isKortixComputerOpen, refetchThreadData]);

  const messages = chat.messages || [];
  const streamingContent = chat.streamingContent || '';
  const streamingToolCall = chat.streamingToolCall || null;
  const isLoading = chat.isLoading;
  const hasMessages = messages.length > 0 || streamingContent.length > 0;
  const scrollViewRef = React.useRef<ScrollView>(null);
  
  // Calculate bottom padding for content to account for input section + safe area
  const contentBottomPadding = CHAT_INPUT_SECTION_HEIGHT.THREAD_PAGE + insets.bottom;
  const [isUserScrolling, setIsUserScrolling] = React.useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const lastMessageCountRef = React.useRef(messages.length);
  const lastStreamingLengthRef = React.useRef(0);
  const scrollAnimationRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const hasNewMessages = messages.length > lastMessageCountRef.current;
    const hasStreamingContent = streamingContent !== '';

    if ((hasNewMessages || hasStreamingContent) && scrollViewRef.current && !isUserScrolling) {
      scrollViewRef.current?.scrollToEnd({ animated: false });
    }

    lastMessageCountRef.current = messages.length;
    lastStreamingLengthRef.current = streamingContent.length;
  }, [messages.length, streamingContent, isUserScrolling]);

  React.useEffect(() => {
    return () => {
      if (scrollAnimationRef.current) {
        cancelAnimationFrame(scrollAnimationRef.current);
      }
    };
  }, []);

  const lastScrollYRef = React.useRef(0);

  const handleScroll = React.useCallback((event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const currentScrollY = contentOffset.y;
    const maxScrollY = contentSize.height - layoutMeasurement.height;
    const isAtBottom = currentScrollY >= maxScrollY - 100;
    const isScrollingUp = currentScrollY < lastScrollYRef.current;

    lastScrollYRef.current = currentScrollY;

    if (isScrollingUp && !isAtBottom) {
      setIsUserScrolling(true);
      setShowScrollToBottom(true);
    } else if (isAtBottom) {
      setIsUserScrolling(false);
      setShowScrollToBottom(false);
    }
  }, []);

  const scrollToBottom = React.useCallback(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
    setIsUserScrolling(false);
    setShowScrollToBottom(false);
  }, []);

  const handleRefresh = React.useCallback(async () => {
    if (chat.isStreaming || chat.isAgentRunning) {
      return;
    }

    setIsRefreshing(true);

    try {
      await chat.refreshMessages();
    } catch (error) {
      console.error('Failed to refresh:', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [chat]);

  // Memoized handlers for ThreadContent
  const handleToolClick = React.useCallback(
    (assistantMessageId: string | null, toolName: string, toolCallId?: string) => {
      // Tool click handler - can be extended for analytics
      // toolCallId can be used for precise tool navigation in the future
    },
    []
  );

  const handleToolPress = React.useCallback(
    (toolMessages: ToolMessagePair[], initialIndex: number) => {
      setSelectedToolData({ toolMessages, initialIndex });
      openPanel();
    },
    [openPanel]
  );

  const handleFilePress = React.useCallback(
    (filePath: string) => {
      const normalizedPath = filePath.startsWith('/') ? filePath : `/workspace/${filePath}`;
      openFileInComputer(normalizedPath);
    },
    [openFileInComputer]
  );

  // Ensure thread content is loaded when ThreadPage mounts or thread changes
  const hasInitializedRef = React.useRef(false);
  const lastThreadIdRef = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    const currentThreadId = chat.activeThread?.id;
    if (!currentThreadId) return;

    const isInitialMount = !hasInitializedRef.current;
    const isThreadChanged = lastThreadIdRef.current !== currentThreadId;

    if (isInitialMount || isThreadChanged) {
      hasInitializedRef.current = true;
      lastThreadIdRef.current = currentThreadId;

      if (messages.length === 0 && !isLoading && !chat.isStreaming) {
        chat.refreshMessages().catch((error) => {
          console.error('Failed to load thread messages:', error);
          Alert.alert('Error', 'Failed to load thread messages. Please try again.');
        });
      }
    }
  }, [chat.activeThread?.id, messages.length, isLoading, chat.isStreaming, chat.refreshMessages]);

  return (
    <View className="flex-1 bg-background">
      {/* Main content area - positioned below header but above nothing */}
      <View className="flex-1" style={{ zIndex: 1 }}>
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <View className="h-20 w-20 items-center justify-center rounded-full">
              <LottieView
                source={require('@/components/animations/loading.json')}
                style={{ width: 40, height: 40 }}
                autoPlay
                loop
                speed={1.2}
                colorFilters={[
                  {
                    keypath: '*',
                    color: isDark ? '#ffffff' : '#121215',
                  },
                ]}
              />
            </View>
          </View>
        ) : !hasMessages ? (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{
              flexGrow: 1,
              justifyContent: 'center',
              alignItems: 'center',
              paddingHorizontal: 32,
              paddingTop: Math.max(insets.top, 16) + 80,
              paddingBottom: contentBottomPadding,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            bounces={Platform.OS === 'ios'}
            overScrollMode="never"
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={handleRefresh}
                tintColor="#000000"
                titleColor={colorScheme === 'dark' ? '#666666' : '#999999'}
                title=""
                progressBackgroundColor={colorScheme === 'dark' ? '#1a1a1c' : '#ffffff'}
                colors={['#000000']}
                progressViewOffset={Math.max(insets.top, 16) + 80}
              />
            }>
            <View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-muted/20">
              <MessageCircle size={40} color={colorScheme === 'dark' ? '#666' : '#999'} />
            </View>
            <Text className="mb-2 text-center font-roobert-semibold text-xl text-foreground">
              {chat.activeThread?.title || 'New Thread'}
            </Text>
            <Text className="text-center font-roobert text-base text-muted-foreground">
              Start the conversation with a message or voice note
            </Text>
          </ScrollView>
        ) : (
          <ScrollView
            ref={scrollViewRef}
            className="flex-1"
            showsVerticalScrollIndicator={true}
            contentContainerStyle={{
              flexGrow: 1,
              paddingTop: Math.max(insets.top, 16) + 80,
              paddingBottom: contentBottomPadding,
              paddingHorizontal: 16,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            scrollEventThrottle={16}
            bounces={Platform.OS === 'ios'}
            alwaysBounceVertical={Platform.OS === 'ios'}
            overScrollMode="never"
            onScroll={handleScroll}
            maintainVisibleContentPosition={Platform.OS === 'ios' ? {
              minIndexForVisible: 0,
              autoscrollToTopThreshold: 100,
            } : undefined}
            removeClippedSubviews={false}
            scrollsToTop={true}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={handleRefresh}
                tintColor="#000000"
                titleColor={colorScheme === 'dark' ? '#666666' : '#999999'}
                title=""
                progressBackgroundColor={colorScheme === 'dark' ? '#1a1a1c' : '#ffffff'}
                colors={['#000000']}
                progressViewOffset={Math.max(insets.top, 16) + 80}
              />
            }>
            {isMounted && (
              <ThreadContent
                messages={messages}
                streamingTextContent={streamingContent}
                streamingToolCall={streamingToolCall}
                agentStatus={chat.isAgentRunning ? 'running' : 'idle'}
                streamHookStatus={chat.isStreaming ? 'streaming' : 'idle'}
                sandboxId={chat.activeSandboxId || fullThreadData?.project?.sandbox?.id}
                sandboxUrl={fullThreadData?.project?.sandbox?.sandbox_url}
                handleToolClick={handleToolClick}
                onToolPress={handleToolPress}
                onFilePress={handleFilePress}
                onPromptFill={chat.setInputValue}
              />
            )}
          </ScrollView>
        )}
      </View>
      {showScrollToBottom && hasMessages && (
        <Pressable
          onPress={scrollToBottom}
          className="absolute right-6 h-12 w-12 items-center justify-center rounded-full border border-border bg-card active:opacity-80"
          style={{
            bottom: contentBottomPadding - 44,
            zIndex: 150,
          }}>
          <Icon as={ArrowDown} size={20} className="text-foreground" strokeWidth={2} />
        </Pressable>
      )}

      <ThreadHeader
        threadTitle={
          fullThreadData?.project?.name || fullThreadData?.title || chat.activeThread?.title
        }
        onTitleChange={async (newTitle) => {
          try {
            await chat.updateThreadTitle(newTitle);
          } catch (error) {
            console.error('Failed to update thread title:', error);
          }
        }}
        onBackPress={chat.showModeThreadList}
        onShare={async () => {
          if (!chat.activeThread?.id) return;
          try {
            await shareThreadMutation.mutateAsync(chat.activeThread.id);
          } catch (error) {
            console.error('Failed to share thread:', error);
          }
        }}
        onFiles={() => {
          openFileBrowser();
        }}
        onDelete={async () => {
          if (!chat.activeThread?.id) return;
          try {
            await deleteThreadMutation.mutateAsync(chat.activeThread.id);
            chat.startNewChat();
            if (router.canGoBack()) {
              router.back();
            }
          } catch (error) {
            console.error('Failed to delete thread:', error);
          }
        }}
      />

      <ChatInputSection
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
        onQuickActionPress={chat.handleQuickAction}
        isAuthenticated={isAuthenticated}
        isAgentRunning={chat.isAgentRunning}
        isSendingMessage={chat.isSendingMessage}
        isTranscribing={isTranscribing}
      />

      <ChatDrawers
        isAgentDrawerVisible={agentManager.isDrawerVisible}
        onCloseAgentDrawer={agentManager.closeDrawer}
        onOpenWorkerConfig={(workerId, view) => {
          console.log('🔧 [ThreadPage] Opening worker config:', {
            workerId,
            view,
            isAgentDrawerVisible: agentManager.isDrawerVisible,
          });

          // If external handler is provided, use it to redirect to MenuPage
          if (externalOpenWorkerConfig) {
            externalOpenWorkerConfig(workerId, view);
            return;
          }

          // Clear any existing timeout
          if (pendingWorkerConfigTimeoutRef.current) {
            clearTimeout(pendingWorkerConfigTimeoutRef.current);
            pendingWorkerConfigTimeoutRef.current = null;
          }

          // Store pending config in REF (not state) to avoid stale closure issues
          pendingWorkerConfigRef.current = { workerId, view };

          // If AgentDrawer is visible, close it and wait for dismiss
          if (agentManager.isDrawerVisible) {
            console.log('🔧 [ThreadPage] AgentDrawer visible, closing first');
            agentManager.closeDrawer();

            // Fallback: if onDismiss doesn't fire within 500ms, open anyway
            pendingWorkerConfigTimeoutRef.current = setTimeout(() => {
              console.log('⏰ [ThreadPage] Fallback timeout - opening WorkerConfigDrawer');
              const pending = pendingWorkerConfigRef.current;
              if (pending) {
                pendingWorkerConfigRef.current = null;
                setWorkerConfigWorkerId(pending.workerId);
                setWorkerConfigInitialView(pending.view || 'instructions');
                setIsWorkerConfigDrawerVisible(true);
              }
              pendingWorkerConfigTimeoutRef.current = null;
            }, 500);
          } else {
            // AgentDrawer is not visible, open immediately
            console.log('✅ [ThreadPage] AgentDrawer not visible, opening immediately');
            pendingWorkerConfigRef.current = null;
            setWorkerConfigWorkerId(workerId);
            setWorkerConfigInitialView(view || 'instructions');
            setIsWorkerConfigDrawerVisible(true);
          }
        }}
        onAgentDrawerDismiss={() => {
          console.log('🎭 [ThreadPage] AgentDrawer dismissed');

          // Clear fallback timeout since dismiss fired
          if (pendingWorkerConfigTimeoutRef.current) {
            clearTimeout(pendingWorkerConfigTimeoutRef.current);
            pendingWorkerConfigTimeoutRef.current = null;
          }

          // Check REF (not state) for pending config
          const pending = pendingWorkerConfigRef.current;
          if (pending) {
            console.log('🎭 [ThreadPage] Opening pending WorkerConfigDrawer');
            pendingWorkerConfigRef.current = null;
            setWorkerConfigWorkerId(pending.workerId);
            setWorkerConfigInitialView(pending.view || 'instructions');
            // Small delay to ensure AgentDrawer animation is complete
            setTimeout(() => {
              setIsWorkerConfigDrawerVisible(true);
            }, 100);
          }
        }}
        isWorkerConfigDrawerVisible={isWorkerConfigDrawerVisible}
        workerConfigWorkerId={workerConfigWorkerId}
        workerConfigInitialView={workerConfigInitialView}
        onCloseWorkerConfigDrawer={() => {
          setIsWorkerConfigDrawerVisible(false);
          setWorkerConfigWorkerId(null);
        }}
        onWorkerUpdated={() => {
          // Refresh agent data if needed
        }}
        onUpgradePress={handleUpgradePress}
        isAttachmentDrawerVisible={chat.isAttachmentDrawerVisible}
        onCloseAttachmentDrawer={chat.closeAttachmentDrawer}
        onTakePicture={chat.handleTakePicture}
        onChooseImages={chat.handleChooseImages}
        onChooseFiles={chat.handleChooseFiles}
      />


      {isKortixComputerOpen && (
        <KortixComputer
          toolMessages={selectedToolData?.toolMessages || []}
          currentIndex={selectedToolData?.initialIndex || 0}
          onNavigate={(newIndex) => {
            if (selectedToolData) {
              setSelectedToolData({ ...selectedToolData, initialIndex: newIndex });
            }
          }}
          messages={messages}
          agentStatus={chat.isAgentRunning ? 'running' : 'idle'}
          project={
            fullThreadData?.project
              ? {
                id: fullThreadData.project.id,
                name: fullThreadData.project.name,
                sandbox: fullThreadData.project.sandbox,
              }
              : undefined
          }
          isLoading={isLoading}
          agentName={agentManager.selectedAgent?.name}
          onFileClick={handleFilePress}
          onPromptFill={chat.setInputValue}
          streamingText={streamingContent}
          sandboxId={chat.activeSandboxId || fullThreadData?.project?.sandbox?.id}
        />
      )}
      <DynamicIslandRefresh isRefreshing={isRefreshing} insets={insets} />
    </View>
  );
}
