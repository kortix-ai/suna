import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View, Keyboard, ScrollView, ActivityIndicator } from 'react-native';
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
import { MessageCircle } from 'lucide-react-native';

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
  const [isThreadActionsVisible, setIsThreadActionsVisible] = React.useState(false);
  
  // Tool drawer state - now managed by chat hook
  // const [selectedToolData, setSelectedToolData] = React.useState<{
  //   toolMessages: ToolMessagePair[];
  //   initialIndex: number;
  // } | null>(null);

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

  // Get messages and streaming state from chat
  const messages = chat.messages || [];
  const streamingContent = chat.streamingContent || '';
  const streamingToolCall = chat.streamingToolCall || null;
  const isLoading = chat.isLoading;
  const hasMessages = messages.length > 0 || streamingContent.length > 0;

  // Auto-scroll to bottom when new messages arrive
  const scrollViewRef = React.useRef<ScrollView>(null);
  
  React.useEffect(() => {
    if (hasMessages && scrollViewRef.current) {
      // Small delay to ensure content is rendered
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages.length, streamingContent]);

  // Log when loading state changes
  React.useEffect(() => {
    console.log('🔄 [ThreadPage] Loading state changed:', {
      isLoading,
      hasMessages,
      messageCount: messages.length,
      threadId: chat.activeThread?.id,
    });
  }, [isLoading, hasMessages, messages.length, chat.activeThread?.id]);

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
            {/* Thread Header */}
            <ThreadHeader
              threadTitle={chat.activeThread?.title}
              onTitleChange={(newTitle) => {
                console.log('📝 Thread title changed to:', newTitle);
                // TODO: Update thread title in state/backend
              }}
              onMenuPress={onMenuPress}
              onActionsPress={() => setIsThreadActionsVisible(true)}
            />

            {/* Active Chat Thread - MessageRenderer with streaming support */}
            <View className="flex-1" style={{ marginTop: 100 }}>
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
                    paddingTop: 20,
                    paddingBottom: 200,
                    paddingHorizontal: 16,
                  }}
                  keyboardShouldPersistTaps="handled"
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
              <View className="mx-3 mb-8">
                <ChatInput
                  value={chat.inputValue}
                  onChangeText={chat.setInputValue}
                  onSendMessage={chat.sendMessage}
                  onSendAudio={audioHandlers.handleSendAudio}
                  onAttachPress={chat.openAttachmentDrawer}
                  onAgentPress={agentManager.openDrawer}
                  onAudioRecord={audioHandlers.handleStartRecording}
                  onCancelRecording={audioHandlers.handleCancelRecording}
                  onStopAgentRun={chat.stopAgent}
                  placeholder={chat.getPlaceholder()}
                  agent={agentManager.selectedAgent}
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
          agents={agentManager.agents}
          selectedAgentId={agentManager.selectedAgent.id}
          onSelectAgent={agentManager.selectAgent}
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
      </KeyboardAvoidingView>
    </View>
  );
}
