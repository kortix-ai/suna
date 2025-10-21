import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View, Keyboard, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import Animated, { 
  useAnimatedStyle, 
  withSpring,
  useAnimatedKeyboard,
} from 'react-native-reanimated';
import { MessageRenderer, ToolCallPanel, ChatInput, type ToolMessagePair } from '@/components/chat';
import { ThreadHeader, ThreadActionsDrawer } from '@/components/home';
import { AgentDrawer } from '@/components/agents';
import { AttachmentDrawer } from '@/components/attachments';
import { useAgentManager, useAudioRecorder, useAudioRecordingHandlers, type UseChatReturn } from '@/hooks';
import { Text } from '@/components/ui/text';
import { MessageCircle, ArrowDown } from 'lucide-react-native';

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
  const audioHandlers = useAudioRecordingHandlers(audioRecorder, agentManager);
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const [isThreadActionsVisible, setIsThreadActionsVisible] = React.useState(false);
  
  // Tool drawer state - now managed by chat hook
  // const [selectedToolData, setSelectedToolData] = React.useState<{
  //   toolMessages: ToolMessagePair[];
  //   initialIndex: number;
  // } | null>(null);

  // Optimized keyboard animation - smooth and responsive
  const keyboard = useAnimatedKeyboard();
  
  const animatedBottomStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateY: withSpring(-keyboard.height.value, {
            damping: 25,               // Balanced damping for smooth animation
            stiffness: 300,            // Moderate stiffness for natural feel
            mass: 0.8,                 // Slightly heavier for smoother motion
            overshootClamping: false,  // Allow slight overshoot for natural feel
          }),
        },
      ],
    };
  });

  // Get messages and streaming state from chat
  const messages = chat.messages || [];
  const streamingContent = chat.streamingContent || '';
  const streamingToolCall = chat.streamingToolCall || null;
  const isLoading = chat.isLoading;
  const hasMessages = messages.length > 0 || streamingContent.length > 0;

  // Enhanced auto-scroll behavior
  const scrollViewRef = React.useRef<ScrollView>(null);
  const [isUserScrolling, setIsUserScrolling] = React.useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = React.useState(false);
  const lastMessageCountRef = React.useRef(messages.length);
  
  // Auto-scroll to bottom when new messages arrive (only if user isn't manually scrolling)
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
    <View className="flex-1 bg-background">
      {/* Thread Header - Fixed at top */}
      <ThreadHeader
        threadTitle={chat.activeThread?.title}
        onTitleChange={(newTitle) => {
          console.log('📝 Thread title changed to:', newTitle);
          // TODO: Update thread title in state/backend
        }}
        onMenuPress={onMenuPress}
        onActionsPress={() => setIsThreadActionsVisible(true)}
      />

      {/* Main Content Area */}
      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 items-center justify-center px-8">
            <View className="w-20 h-20 rounded-full bg-secondary/30 items-center justify-center mb-6">
              <ActivityIndicator 
                size="large" 
                color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} 
              />
            </View>
            <Text className="text-foreground text-lg font-roobert-semibold text-center">
              Loading thread...
            </Text>
            <Text className="text-muted-foreground text-sm font-roobert mt-2 text-center">
              Fetching messages
            </Text>
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
              paddingTop: insets.top + 60, // Safe area + header height (48px) + extra spacing (12px)
              paddingBottom: 200,
              paddingHorizontal: 16,
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
        onShare={() => {
          console.log('📤 Share thread:', chat.activeThread?.title);
          setIsThreadActionsVisible(false);
        }}
        onFiles={() => {
          console.log('📁 Manage files:', chat.activeThread?.title);
          setIsThreadActionsVisible(false);
        }}
        onDelete={() => {
          console.log('🗑️ Delete thread:', chat.activeThread?.title);
          setIsThreadActionsVisible(false);
          // Start new chat (effectively deletes current thread)
          chat.startNewChat();
        }}
      />
      
      {/* Tool Call Panel */}
      <ToolCallPanel
        visible={!!chat.selectedToolData}
        onClose={() => chat.setSelectedToolData(null)}
        toolMessages={chat.selectedToolData?.toolMessages || []}
        initialIndex={chat.selectedToolData?.initialIndex || 0}
      />
    </View>
  );
}
