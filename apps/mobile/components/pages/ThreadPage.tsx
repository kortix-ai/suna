import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View, Keyboard, ScrollView, ActivityIndicator, Alert, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import Animated, { 
  useAnimatedStyle, 
  withSpring,
  useAnimatedKeyboard,
} from 'react-native-reanimated';
import { MessageRenderer, ToolCallPanel, ChatInput, type ToolMessagePair } from '@/components/chat';
import { ThreadHeader, ThreadActionsDrawer } from '@/components/threads';
import { AgentDrawer } from '@/components/agents';
import { AttachmentDrawer, AttachmentBar } from '@/components/attachments';
import { FileManagerScreen } from '@/components/files';
import { useAgentManager, useAudioRecorder, useAudioRecordingHandlers, type UseChatReturn, useDeleteThread, useShareThread } from '@/hooks';
import { useThread } from '@/lib/chat';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MessageCircle, ArrowDown, AlertCircle, X } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';

interface ThreadPageProps {
  onMenuPress?: () => void;
  chat: UseChatReturn;
  isAuthenticated: boolean;
  onOpenAuthDrawer: () => void;
}

/**
 * ThreadPage Component
 * 
 * Dedicated page for displaying and interacting with an active chat thread.
 * Handles all thread-related UI including header, messages, and input.
 * 
 * Features:
 * - Thread header with title editing and actions
 * - Scrollable message view with streaming support
 * - Thread-specific actions (share, files, delete)
 * - Chat input with agent selection
 * - Tool call drawer with navigation
 * - Keyboard-aware layout
 */
export function ThreadPage({
  onMenuPress,
  chat,
  isAuthenticated,
  onOpenAuthDrawer,
}: ThreadPageProps) {
  // Custom hooks - Clean separation of concerns
  const agentManager = useAgentManager();
  const audioRecorder = useAudioRecorder();
  const audioHandlers = useAudioRecordingHandlers(
    audioRecorder, 
    agentManager, 
    chat.transcribeAndAddToInput
  );
  
  // Combined transcription state (from either chat or audio handlers)
  const isTranscribing = chat.isTranscribing || audioHandlers.isTranscribing;
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [isThreadActionsVisible, setIsThreadActionsVisible] = React.useState(false);
  const [isFileManagerVisible, setIsFileManagerVisible] = React.useState(false);
  
  // Thread actions hooks
  const deleteThreadMutation = useDeleteThread();
  const shareThreadMutation = useShareThread();
  
  // Get full thread data with sandbox info
  const { data: fullThreadData } = useThread(chat.activeThread?.id);
  
  const keyboard = useAnimatedKeyboard();
  
  const animatedBottomStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateY: withSpring(-keyboard.height.value, {
            damping: 25,
            stiffness: 300,
            mass: 0.8,
            overshootClamping: false,
          }),
        },
      ],
    };
  });

  const messages = chat.messages || [];
  const streamingContent = chat.streamingContent || '';
  const streamingToolCall = chat.streamingToolCall || null;
  const isLoading = chat.isLoading;
  const hasMessages = messages.length > 0 || streamingContent.length > 0;
  const scrollViewRef = React.useRef<ScrollView>(null);
  const [isUserScrolling, setIsUserScrolling] = React.useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = React.useState(false);
  const lastMessageCountRef = React.useRef(messages.length);
  
  React.useEffect(() => {
    const hasNewMessages = messages.length > lastMessageCountRef.current;
    const hasStreamingContent = streamingContent.length > 0;
    
    if ((hasNewMessages || hasStreamingContent) && scrollViewRef.current && !isUserScrolling) {
      // Use requestAnimationFrame for smoother scrolling
      requestAnimationFrame(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      });
    }
    
    lastMessageCountRef.current = messages.length;
  }, [messages.length, streamingContent, isUserScrolling]);
  
  // Handle scroll events to detect user interaction
  const handleScroll = React.useCallback((event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const isAtBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 50;
    
    // If user scrolls away from bottom, mark as user scrolling
    if (!isAtBottom) {
      setIsUserScrolling(true);
      setShowScrollToBottom(true);
    } else {
      // If user scrolls back to bottom, allow auto-scroll again
      setIsUserScrolling(false);
      setShowScrollToBottom(false);
    }
  }, []);
  
  // Scroll to bottom function
  const scrollToBottom = React.useCallback(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
    setIsUserScrolling(false);
    setShowScrollToBottom(false);
  }, []);

  // Log when loading state changes
  React.useEffect(() => {
    console.log('🔄 [ThreadPage] Loading state changed:', {
      isLoading,
      hasMessages,
      messageCount: messages.length,
      threadId: chat.activeThread?.id,
      isUserScrolling,
      showScrollToBottom,
      topInset: insets.top,
      scrollViewPaddingTop: insets.top + 60,
    });
  }, [isLoading, hasMessages, messages.length, chat.activeThread?.id, isUserScrolling, showScrollToBottom, insets.top]);

  return (
    <View className="flex-1" style={{ backgroundColor: colorScheme === 'dark' ? '#121215' : '#f8f8f8' }}>


      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator 
              size="large" 
              color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} 
            />
          </View>
        ) : !hasMessages ? (
          <View className="flex-1 items-center justify-center px-8">
            <View className="w-20 h-20 rounded-full bg-secondary items-center justify-center mb-4">
              <MessageCircle size={40} color={colorScheme === 'dark' ? '#666' : '#999'} />
            </View>
            <Text className="text-foreground text-lg font-roobert-semibold text-center">
              {chat.activeThread?.title || 'Thread'}
            </Text>
            <Text className="text-muted-foreground text-sm font-roobert mt-2 text-center">
              No messages yet. Start the conversation!
            </Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollViewRef}
            className="flex-1"
            showsVerticalScrollIndicator={true}
            contentContainerStyle={{ 
              flexGrow: 1,
              paddingTop: insets.top + 60, 
              paddingBottom: 200,
              paddingHorizontal: 16, // Comfortable side margins
            }}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            bounces={true}
            alwaysBounceVertical={false}
            onScroll={handleScroll}
          >
            <MessageRenderer
              messages={messages}
              streamingContent={streamingContent}
              streamingToolCall={streamingToolCall}
              isStreaming={chat.isStreaming}
              onToolPress={(toolMessages, initialIndex) => {
                chat.setSelectedToolData({ toolMessages, initialIndex });
              }}
            />
          </ScrollView>
        )}
      </View>

      {/* Scroll to Bottom Button */}
      {showScrollToBottom && hasMessages && (
        <Pressable
          onPress={scrollToBottom}
          className="absolute bottom-24 right-4 w-12 h-12 bg-primary rounded-full items-center justify-center shadow-lg active:bg-primary/80"
          style={{ elevation: 8 }}
        >
          <ArrowDown size={20} color="white" />
        </Pressable>
      )}


    <View className="absolute top-0 left-0 right-0">
      {/* Thread Header */}
      <ThreadHeader
          threadTitle={chat.activeThread?.title}
          onTitleChange={async (newTitle) => {
            console.log('📝 Thread title changed to:', newTitle);
            try {
              await chat.updateThreadTitle(newTitle);
            } catch (error) {
              console.error('❌ Failed to update thread title:', error);
            }
          }}
          onMenuPress={onMenuPress}
          onActionsPress={() => setIsThreadActionsVisible(true)}
        />
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
        
        {/* Attachment Bar - Above Input */}
        <AttachmentBar 
          attachments={chat.attachments}
          onRemove={chat.removeAttachment}
        />
        
        
        {/* Chat Input */}
        <Pressable 
          onPress={Keyboard.dismiss}
          accessible={false}
          className="mx-3 mb-8"
        >
          <ChatInput
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
            isTranscribing={isTranscribing}
          />
        </Pressable>
      </Animated.View>

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

      {/* Thread Actions Drawer */}
      <ThreadActionsDrawer
        visible={isThreadActionsVisible}
        onClose={() => setIsThreadActionsVisible(false)}
        onShare={async () => {
          if (!chat.activeThread?.id) return;
          
          console.log('📤 Share thread:', chat.activeThread?.title);
          
          try {
            await shareThreadMutation.mutateAsync(chat.activeThread.id);
            setIsThreadActionsVisible(false);
          } catch (error) {
            console.error('Failed to share thread:', error);
            // Error is already shown by the native share dialog or caught silently if user cancels
          }
        }}
        onFiles={() => {
          console.log('📁 Manage files:', chat.activeThread?.title);
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
                    console.log('🗑️ Deleting thread:', threadTitle);
                    await deleteThreadMutation.mutateAsync(chat.activeThread.id);
                    
                    // Navigate to home after successful deletion
                    chat.startNewChat();
                    if (router.canGoBack()) {
                      router.back();
                    }
                    
                    console.log('✅ Thread deleted successfully');
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
      
      {/* Tool Call Panel - Native modal with automatic background scaling on iOS */}
      <ToolCallPanel
        visible={!!chat.selectedToolData}
        onClose={() => chat.setSelectedToolData(null)}
        toolMessages={chat.selectedToolData?.toolMessages || []}
        initialIndex={chat.selectedToolData?.initialIndex || 0}
      />

      {/* File Manager Modal */}
      <Modal
        visible={isFileManagerVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setIsFileManagerVisible(false)}
      >
        {fullThreadData?.project?.sandbox?.id ? (
          <FileManagerScreen
            sandboxId={fullThreadData.project.sandbox.id}
            sandboxUrl={fullThreadData.project.sandbox.sandbox_url}
            onClose={() => setIsFileManagerVisible(false)}
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
    </View>
  );
}
