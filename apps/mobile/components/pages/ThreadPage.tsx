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
import { ThreadContent, ToolCallPanel, ChatInputSection, ChatDrawers, type ToolMessagePair } from '@/components/chat';
import { ThreadHeader, ThreadActionsDrawer } from '@/components/threads';
import { FileManagerScreen } from '@/components/files';
import { useChatCommons, type UseChatReturn, useDeleteThread, useShareThread } from '@/hooks';
import { useThread } from '@/lib/chat';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MessageCircle, ArrowDown, AlertCircle, X } from 'lucide-react-native';
import { useRouter } from 'expo-router';

interface ThreadPageProps {
  onMenuPress?: () => void;
  chat: UseChatReturn;
  isAuthenticated: boolean;
}

const DynamicIslandRefresh = React.memo(function DynamicIslandRefresh({
  isRefreshing,
  insets
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
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94)
      });

      height.value = withTiming(90, {
        duration: 450,
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94)
      });

      borderTopRadius.value = withTiming(30, {
        duration: 450,
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94)
      });

      borderBottomRadius.value = withTiming(24, {
        duration: 450,
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94)
      });

      contentTranslateY.value = withDelay(100, withTiming(20, {
        duration: 350,
        easing: Easing.bezier(0.25, 0.46, 0.45, 0.94)
      }));

      contentOpacity.value = withDelay(200, withTiming(1, { duration: 200 }));

    } else if (opacity.value === 1) {
      // Stop Lottie animation
      lottieRef.current?.pause();

      contentOpacity.value = withTiming(0, { duration: 150 });
      contentTranslateY.value = withTiming(-20, {
        duration: 250,
        easing: Easing.bezier(0.5, 0, 0.75, 0)
      });

      setTimeout(() => {
        width.value = withTiming(126, {
          duration: 400,
          easing: Easing.bezier(0.33, 0, 0.67, 1)
        });

        borderTopRadius.value = withTiming(20, {
          duration: 400,
          easing: Easing.bezier(0.33, 0, 0.67, 1)
        });

        borderBottomRadius.value = withTiming(20, {
          duration: 400,
          easing: Easing.bezier(0.33, 0, 0.67, 1)
        });

        height.value = withTiming(37, {
          duration: 400,
          easing: Easing.bezier(0.33, 0, 0.67, 1)
        });

        setTimeout(() => {
          opacity.value = withTiming(0, {
            duration: 300,
            easing: Easing.bezier(0.25, 0.1, 0.25, 1)
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
          pointerEvents="none"
        >
          <Animated.View
            style={[
              animatedContainerStyle,
              {
                backgroundColor: 'black',
                overflow: 'hidden',
                justifyContent: 'center',
                alignItems: 'center',
              }
            ]}
          >
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

      {Platform.OS === 'android' && (
        <View
          className="absolute w-full items-center"
          style={{
            top: insets.top + 10,
            zIndex: 9999,
            elevation: 999,
          }}
          pointerEvents="none"
        >
          <Animated.View
            style={[
              animatedContainerStyle,
              {
                width: 150,
                backgroundColor: '#000000',
                justifyContent: 'center',
                alignItems: 'center',
              }
            ]}
          >
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
}: ThreadPageProps) {
  const { agentManager, audioRecorder, audioHandlers, isTranscribing } = useChatCommons(chat);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [isThreadActionsVisible, setIsThreadActionsVisible] = React.useState(false);
  const [isFileManagerVisible, setIsFileManagerVisible] = React.useState(false);
  const [selectedFilePath, setSelectedFilePath] = React.useState<string | undefined>();

  const deleteThreadMutation = useDeleteThread();
  const shareThreadMutation = useShareThread();

  const { data: fullThreadData, refetch: refetchThreadData } = useThread(chat.activeThread?.id);

  React.useEffect(() => {
    if (isFileManagerVisible) {
      refetchThreadData();
    }
  }, [isFileManagerVisible, refetchThreadData]);

  const messages = chat.messages || [];
  const streamingContent = chat.streamingContent || '';
  const streamingToolCall = chat.streamingToolCall || null;
  const isLoading = chat.isLoading;
  const hasMessages = messages.length > 0 || streamingContent.length > 0;
  const scrollViewRef = React.useRef<ScrollView>(null);
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
  const handleToolClick = React.useCallback((assistantMessageId: string | null, toolName: string) => {
    // Tool click handler - can be extended for analytics
  }, []);

  const handleToolPress = React.useCallback((toolMessages: ToolMessagePair[], initialIndex: number) => {
    chat.setSelectedToolData({ toolMessages, initialIndex });
  }, [chat]);

  const handleFilePress = React.useCallback((filePath: string) => {
    const normalizedPath = filePath.startsWith('/') ? filePath : `/workspace/${filePath}`;
    setSelectedFilePath(normalizedPath);
    setIsFileManagerVisible(true);
  }, []);

  // Memoized handlers for ToolCallPanel
  const handleCloseToolPanel = React.useCallback(() => {
    chat.setSelectedToolData(null);
  }, [chat]);

  // Memoized handlers for FileManagerScreen
  const handleCloseFileManager = React.useCallback(() => {
    setIsFileManagerVisible(false);
    setSelectedFilePath(undefined);
  }, []);

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
        chat.refreshMessages().catch(error => {
          console.error('Failed to load thread messages:', error);
          Alert.alert('Error', 'Failed to load thread messages. Please try again.');
        });
      }
    }
  }, [chat.activeThread?.id, messages.length, isLoading, chat.isStreaming, chat.refreshMessages]);

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <View className="w-20 h-20 rounded-full items-center justify-center">
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
              flex: 1,
              justifyContent: 'center',
              alignItems: 'center',
              paddingHorizontal: 32,
              paddingTop: Math.max(insets.top, 16) + 80,
            }}
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
            }
          >
            <View className="w-20 h-20 rounded-full bg-muted/20 items-center justify-center mb-6">
              <MessageCircle size={40} color={colorScheme === 'dark' ? '#666' : '#999'} />
            </View>
            <Text className="text-foreground text-xl font-roobert-semibold text-center mb-2">
              {chat.activeThread?.title || 'New Thread'}
            </Text>
            <Text className="text-muted-foreground text-base font-roobert text-center">
              Start the conversation with a message or voice note
            </Text>
          </ScrollView>
        ) : (
          <ScrollView
            ref={scrollViewRef}
            className="flex-1"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              flexGrow: 1,
              paddingTop: Math.max(insets.top, 16) + 80,
              paddingBottom: 200,
              paddingHorizontal: 16,
            }}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            bounces={true}
            alwaysBounceVertical={true}
            onScroll={handleScroll}
            maintainVisibleContentPosition={{
              minIndexForVisible: 0,
              autoscrollToTopThreshold: 100,
            }}
            removeClippedSubviews={false}
            scrollsToTop={false}
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
            }
          >
            <ThreadContent
              messages={messages}
              streamingTextContent={streamingContent}
              streamingToolCall={streamingToolCall}
              agentStatus={chat.isAgentRunning ? 'running' : 'idle'}
              streamHookStatus={chat.isStreaming ? 'streaming' : 'idle'}
              sandboxId={chat.activeSandboxId || fullThreadData?.project?.sandbox?.id}
              handleToolClick={handleToolClick}
              onToolPress={handleToolPress}
              onFilePress={handleFilePress}
            />
          </ScrollView>
        )}
      </View>
      {showScrollToBottom && hasMessages && (
        <Pressable
          onPress={scrollToBottom}
          className="absolute right-6 bg-card border border-border rounded-full w-12 h-12 items-center justify-center active:opacity-80"
          style={{
            bottom: 200,
          }}
        >
          <Icon as={ArrowDown} size={20} className="text-foreground" strokeWidth={2} />
        </Pressable>
      )}

      <ThreadHeader
        threadTitle={fullThreadData?.project?.name || fullThreadData?.title || chat.activeThread?.title}
        onTitleChange={async (newTitle) => {
          try {
            await chat.updateThreadTitle(newTitle);
          } catch (error) {
            console.error('Failed to update thread title:', error);
          }
        }}
        onMenuPress={onMenuPress}
        onActionsPress={() => setIsThreadActionsVisible(true)}
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
        isAuthenticated={isAuthenticated}
        isAgentRunning={chat.isAgentRunning}
        isSendingMessage={chat.isSendingMessage}
        isTranscribing={isTranscribing}
      />

      <ChatDrawers
        isAgentDrawerVisible={agentManager.isDrawerVisible}
        onCloseAgentDrawer={agentManager.closeDrawer}
        isAttachmentDrawerVisible={chat.isAttachmentDrawerVisible}
        onCloseAttachmentDrawer={chat.closeAttachmentDrawer}
        onTakePicture={chat.handleTakePicture}
        onChooseImages={chat.handleChooseImages}
        onChooseFiles={chat.handleChooseFiles}
      />

      <ThreadActionsDrawer
        visible={isThreadActionsVisible}
        onClose={() => setIsThreadActionsVisible(false)}
        onShare={async () => {
          if (!chat.activeThread?.id) return;

          try {
            await shareThreadMutation.mutateAsync(chat.activeThread.id);
            setIsThreadActionsVisible(false);
          } catch (error) {
            console.error('Failed to share thread:', error);
          }
        }}
        onFiles={() => {
          setIsThreadActionsVisible(false);
          setIsFileManagerVisible(true);
        }}
        onDelete={() => {
          if (!chat.activeThread?.id) return;

          const threadTitle = chat.activeThread?.title || 'this thread';

          Alert.alert(
            'Delete Thread',
            `Are you sure you want to delete "${threadTitle}"? This action cannot be undone.`,
            [
              {
                text: 'Cancel',
                style: 'cancel',
              },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  setIsThreadActionsVisible(false);

                  if (!chat.activeThread?.id) return;

                  try {
                    await deleteThreadMutation.mutateAsync(chat.activeThread.id);
                    chat.startNewChat();
                    if (router.canGoBack()) {
                      router.back();
                    }
                  } catch (error) {
                    console.error('Failed to delete thread:', error);
                    Alert.alert('Error', 'Failed to delete thread. Please try again.');
                  }
                },
              },
            ]
          );
        }}
      />

      <ToolCallPanel
        visible={!!chat.selectedToolData}
        onClose={handleCloseToolPanel}
        toolMessages={chat.selectedToolData?.toolMessages || []}
        initialIndex={chat.selectedToolData?.initialIndex || 0}
        project={fullThreadData?.project ? {
          id: fullThreadData.project.id,
          name: fullThreadData.project.name,
          sandbox_id: fullThreadData.project.sandbox?.id
        } : undefined}
      />

      <Modal
        visible={isFileManagerVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setIsFileManagerVisible(false)}
      >
        {(chat.activeSandboxId || fullThreadData?.project?.sandbox?.id) ? (
          <FileManagerScreen
            key={`${chat.activeSandboxId}-${chat.isStreaming}`}
            sandboxId={chat.activeSandboxId || fullThreadData?.project?.sandbox?.id || ''}
            sandboxUrl={fullThreadData?.project?.sandbox?.sandbox_url}
            initialFilePath={selectedFilePath}
            isStreaming={chat.isStreaming}
            onClose={handleCloseFileManager}
          />
        ) : (
          <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#f8f8f8' }}>
            <View style={{ paddingTop: insets.top, paddingHorizontal: 16 }}>
              <View className="flex-row items-center justify-between py-4">
                <Text className="text-2xl font-roobert-semibold">Files</Text>
                <Pressable onPress={() => setIsFileManagerVisible(false)} className="p-2">
                  <Icon
                    as={X}
                    size={24}
                    color={isDark ? '#f8f8f8' : '#121215'}
                    strokeWidth={2}
                  />
                </Pressable>
              </View>
            </View>
            <View className="flex-1 items-center justify-center p-8">
              <Icon
                as={AlertCircle}
                size={48}
                color={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)'}
                strokeWidth={1.5}
                className="mb-4"
              />
              <Text className="text-base font-roobert-medium text-center mb-2">
                No Sandbox Available
              </Text>
              <Text className="text-sm text-muted-foreground text-center">
                This thread doesn't have a sandbox environment. Files are only available for threads with sandboxes.
              </Text>
            </View>
          </View>
        )}
      </Modal>
      <DynamicIslandRefresh isRefreshing={isRefreshing} insets={insets} />
    </View>
  );
}
