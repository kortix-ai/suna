import * as React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { 
  ArrowLeft, 
  MessageCircle, 
  Play, 
  Pause, 
  ChevronLeft, 
  ChevronRight,
} from 'lucide-react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withTiming,
  withSpring,
  Easing,
} from 'react-native-reanimated';

import { API_URL } from '@/api/config';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { ThreadContent, type ToolMessagePair } from '@/components/chat/ThreadContent';
import { KortixComputer } from '@/components/kortix-computer';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

// Fetch public thread without requiring auth
async function fetchPublicThread(threadId: string) {
  const res = await fetch(`${API_URL}/threads/${threadId}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('This thread is private');
    }
    if (res.status === 404) {
      throw new Error('Thread not found');
    }
    throw new Error(`Failed to fetch thread: ${res.status}`);
  }
  
  return res.json();
}

// Fetch messages for public thread without requiring auth
async function fetchPublicMessages(threadId: string) {
  const res = await fetch(`${API_URL}/threads/${threadId}/messages`, {
    headers: { 'Content-Type': 'application/json' },
  });
  
  if (!res.ok) {
    throw new Error(`Failed to fetch messages: ${res.status}`);
  }
  
  const data = await res.json();
  const messages = Array.isArray(data) ? data : data.messages || [];
  
  // Sort by created_at ascending
  return messages.sort((a: any, b: any) => {
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

// Playback hook for timeline - simplified to avoid duplicate keys
function usePlaybackController(messages: any[], enabled: boolean) {
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentIndex, setCurrentIndex] = React.useState(1); // How many messages to show
  const [streamingText, setStreamingText] = React.useState('');
  const [isStreaming, setIsStreaming] = React.useState(false);
  
  const playbackRef = React.useRef<NodeJS.Timeout | null>(null);
  const streamRef = React.useRef<NodeJS.Timeout | null>(null);
  const isPlayingRef = React.useRef(false);

  // Keep ref in sync
  React.useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Initialize with first message when messages load
  React.useEffect(() => {
    if (enabled && messages.length > 0) {
      setCurrentIndex(1);
    }
  }, [enabled, messages.length]);

  // Cleanup
  React.useEffect(() => {
    return () => {
      if (playbackRef.current) clearTimeout(playbackRef.current);
      if (streamRef.current) clearTimeout(streamRef.current);
    };
  }, []);

  // Visible messages derived from currentIndex - always slice to avoid duplicates
  const visibleMessages = React.useMemo(() => {
    return messages.slice(0, currentIndex);
  }, [messages, currentIndex]);

  const streamAndAdvance = React.useCallback((index: number) => {
    if (index >= messages.length) {
      setIsPlaying(false);
      return;
    }

    const message = messages[index];
    
    if (message.type === 'assistant' && message.content) {
      // Stream assistant messages
      const text = message.content;
      let charIndex = 0;
      setIsStreaming(true);
      setStreamingText('');

      const streamChar = () => {
        if (charIndex < text.length && isPlayingRef.current) {
          const chunkSize = Math.min(5, text.length - charIndex);
          setStreamingText(text.slice(0, charIndex + chunkSize));
          charIndex += chunkSize;
          streamRef.current = setTimeout(streamChar, 10);
        } else {
          setIsStreaming(false);
          setStreamingText('');
          // Show the message and advance
          setCurrentIndex(index + 1);
          
          if (isPlayingRef.current && index + 1 < messages.length) {
            playbackRef.current = setTimeout(() => streamAndAdvance(index + 1), 300);
          } else if (index + 1 >= messages.length) {
            setIsPlaying(false);
          }
        }
      };

      streamChar();
    } else {
      // Show other messages immediately and advance
      setCurrentIndex(index + 1);
      
      if (isPlayingRef.current && index + 1 < messages.length) {
        playbackRef.current = setTimeout(() => streamAndAdvance(index + 1), 400);
      } else if (index + 1 >= messages.length) {
        setIsPlaying(false);
      }
    }
  }, [messages]);

  // Start playback when isPlaying becomes true
  React.useEffect(() => {
    if (isPlaying && currentIndex < messages.length) {
      streamAndAdvance(currentIndex);
    }
    
    return () => {
      if (playbackRef.current) clearTimeout(playbackRef.current);
      if (streamRef.current) clearTimeout(streamRef.current);
    };
  }, [isPlaying]);

  const togglePlayback = React.useCallback(() => {
    if (currentIndex >= messages.length) {
      // Reset if at end
      setCurrentIndex(1);
      setIsPlaying(true);
    } else {
      setIsPlaying(prev => !prev);
    }
  }, [currentIndex, messages.length]);

  const forwardOne = React.useCallback(() => {
    setIsPlaying(false);
    if (streamRef.current) clearTimeout(streamRef.current);
    if (playbackRef.current) clearTimeout(playbackRef.current);
    setIsStreaming(false);
    setStreamingText('');
    
    if (currentIndex < messages.length) {
      setCurrentIndex(prev => prev + 1);
    }
  }, [currentIndex, messages.length]);

  const backwardOne = React.useCallback(() => {
    setIsPlaying(false);
    if (streamRef.current) clearTimeout(streamRef.current);
    if (playbackRef.current) clearTimeout(playbackRef.current);
    setIsStreaming(false);
    setStreamingText('');
    
    if (currentIndex > 1) {
      setCurrentIndex(prev => prev - 1);
    }
  }, [currentIndex]);

  const skipToEnd = React.useCallback(() => {
    setIsPlaying(false);
    if (streamRef.current) clearTimeout(streamRef.current);
    if (playbackRef.current) clearTimeout(playbackRef.current);
    setIsStreaming(false);
    setStreamingText('');
    
    setCurrentIndex(messages.length);
  }, [messages.length]);

  return {
    isPlaying,
    currentIndex,
    visibleMessages,
    streamingText,
    isStreaming,
    togglePlayback,
    forwardOne,
    backwardOne,
    skipToEnd,
    messageCount: messages.length,
  };
}

// Floating Playback Controls Component
function PlaybackControls({
  messageCount,
  currentIndex,
  isPlaying,
  onTogglePlayback,
  onForwardOne,
  onBackwardOne,
  onSkipToEnd,
  bottomInset,
}: {
  messageCount: number;
  currentIndex: number;
  isPlaying: boolean;
  onTogglePlayback: () => void;
  onForwardOne: () => void;
  onBackwardOne: () => void;
  onSkipToEnd: () => void;
  bottomInset: number;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = (callback: () => void) => {
    scale.value = withSpring(0.95, { damping: 15 });
    setTimeout(() => {
      scale.value = withSpring(1, { damping: 15 });
    }, 100);
    callback();
  };

  const isAtEnd = currentIndex >= messageCount;
  const isAtStart = currentIndex <= 1;
  const displayIndex = Math.max(1, Math.min(currentIndex, messageCount));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          bottom: bottomInset + 16,
          left: 0,
          right: 0,
          alignItems: 'center',
        },
        animatedStyle,
      ]}
    >
      <View
        className="flex-row items-center bg-background/95 border border-border rounded-full px-2 py-1.5"
        style={{
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: isDark ? 0.3 : 0.1,
          shadowRadius: 8,
          elevation: 5,
        }}
      >
        {/* Play/Pause */}
        <Pressable
          onPress={() => handlePress(onTogglePlayback)}
          disabled={isAtEnd && !isPlaying}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-muted"
          style={{ opacity: isAtEnd && !isPlaying ? 0.4 : 1 }}
        >
          <Icon 
            as={isPlaying ? Pause : Play} 
            size={18} 
            className="text-foreground" 
          />
        </Pressable>

        {/* Progress */}
        <View className="mx-2 min-w-[50px] items-center">
          <Text className="text-xs text-muted-foreground font-roobert-medium">
            {displayIndex}/{messageCount}
          </Text>
        </View>

        {/* Backward */}
        <Pressable
          onPress={() => handlePress(onBackwardOne)}
          disabled={isAtStart}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-muted"
          style={{ opacity: isAtStart ? 0.4 : 1 }}
        >
          <Icon as={ChevronLeft} size={20} className="text-foreground" />
        </Pressable>

        {/* Forward */}
        <Pressable
          onPress={() => handlePress(onForwardOne)}
          disabled={isAtEnd}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-muted"
          style={{ opacity: isAtEnd ? 0.4 : 1 }}
        >
          <Icon as={ChevronRight} size={20} className="text-foreground" />
        </Pressable>

        {/* Skip to End */}
        <Pressable
          onPress={() => handlePress(onSkipToEnd)}
          disabled={isAtEnd}
          className="h-9 px-3 flex-row items-center justify-center rounded-full active:bg-muted"
          style={{ opacity: isAtEnd ? 0.4 : 1 }}
        >
          <Text className="text-xs text-foreground font-roobert-medium">Skip to end</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

export default function ShareThreadPage() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const scrollViewRef = React.useRef<ScrollView>(null);
  
  // Kortix Computer for viewing tool calls
  const { isOpen: isKortixComputerOpen, openPanel } = useKortixComputerStore();
  const [selectedToolData, setSelectedToolData] = React.useState<{
    toolMessages: ToolMessagePair[];
    initialIndex: number;
  } | null>(null);

  // Handle tool press - open Kortix Computer
  const handleToolPress = React.useCallback(
    (toolMessages: ToolMessagePair[], initialIndex: number) => {
      setSelectedToolData({ toolMessages, initialIndex });
      openPanel();
    },
    [openPanel]
  );

  // Fetch thread data
  const {
    data: thread,
    isLoading: isThreadLoading,
    error: threadError,
  } = useQuery({
    queryKey: ['shared-thread', threadId],
    queryFn: () => fetchPublicThread(threadId!),
    enabled: !!threadId,
    staleTime: 5 * 60 * 1000,
  });

  // Fetch messages
  const {
    data: messages = [],
    isLoading: isMessagesLoading,
    error: messagesError,
  } = useQuery({
    queryKey: ['shared-messages', threadId],
    queryFn: () => fetchPublicMessages(threadId!),
    enabled: !!threadId && !!thread,
    staleTime: 5 * 60 * 1000,
  });

  const isLoading = isThreadLoading || isMessagesLoading;
  const error = threadError || messagesError;

  // Playback controller
  const playback = usePlaybackController(messages, !isLoading && !error);

  // Auto-scroll when new messages appear
  React.useEffect(() => {
    if (playback.currentIndex > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [playback.currentIndex]);

  // Handle back press
  const handleBack = React.useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, [router]);

  // Error state
  if (error) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 bg-background items-center justify-center px-6">
          <View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
            <MessageCircle size={40} color={isDark ? '#ef4444' : '#dc2626'} />
          </View>
          <Text className="text-center font-roobert-semibold text-xl text-foreground mb-2">
            {error instanceof Error && error.message === 'This thread is private'
              ? 'Private Thread'
              : 'Thread Not Found'}
          </Text>
          <Text className="text-center font-roobert text-base text-muted-foreground mb-6">
            {error instanceof Error && error.message === 'This thread is private'
              ? 'This thread is not publicly shared.'
              : 'The thread you\'re looking for doesn\'t exist or has been deleted.'}
          </Text>
          <Pressable
            onPress={handleBack}
            className="px-6 py-3 rounded-full bg-primary active:opacity-80"
          >
            <Text className="font-roobert-medium text-primary-foreground">Go Back</Text>
          </Pressable>
        </View>
      </>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 bg-background items-center justify-center">
          <KortixLoader size="large" />
        </View>
      </>
    );
  }

  const threadTitle = thread?.project?.name || thread?.title || 'Shared Thread';

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background">
        {/* Header */}
        <View
          className="flex-row items-center px-4 bg-background"
          style={{ paddingTop: insets.top + 8, paddingBottom: 12 }}
        >
          <Pressable
            onPress={handleBack}
            className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
          >
            <Icon as={ArrowLeft} size={22} className="text-foreground" />
          </Pressable>

          <View className="flex-1 mx-3">
            <View className="flex-row items-center gap-2">
              <KortixLogo size={16} variant="symbol" color={isDark ? 'dark' : 'light'} />
              <Text
                className="font-roobert-semibold text-base text-foreground"
                numberOfLines={1}
              >
                {threadTitle}
              </Text>
            </View>
          </View>
        </View>

        {/* Messages */}
        <ScrollView
          ref={scrollViewRef}
          className="flex-1"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: insets.bottom + 80,
          }}
          showsVerticalScrollIndicator={false}
        >
          {playback.visibleMessages.length > 0 ? (
            <ThreadContent
              messages={playback.visibleMessages}
              streamingTextContent={playback.streamingText}
              agentStatus="idle"
              streamHookStatus={playback.isStreaming ? 'streaming' : 'idle'}
              sandboxId={thread?.project?.sandbox?.id}
              sandboxUrl={thread?.project?.sandbox?.sandbox_url}
              onToolPress={handleToolPress}
            />
          ) : (
            <View className="flex-1 items-center justify-center py-20">
              <Text className="text-muted-foreground">No messages in this thread</Text>
            </View>
          )}
        </ScrollView>

        {/* Playback Controls */}
        {messages.length > 0 && (
          <PlaybackControls
            messageCount={playback.messageCount}
            currentIndex={playback.currentIndex}
            isPlaying={playback.isPlaying}
            onTogglePlayback={playback.togglePlayback}
            onForwardOne={playback.forwardOne}
            onBackwardOne={playback.backwardOne}
            onSkipToEnd={playback.skipToEnd}
            bottomInset={insets.bottom}
          />
        )}
      </View>

      {/* Kortix Computer for viewing tool calls */}
      {isKortixComputerOpen && (
        <KortixComputer
          toolMessages={selectedToolData?.toolMessages || []}
          currentIndex={selectedToolData?.initialIndex || 0}
          onNavigate={(newIndex) => {
            if (selectedToolData) {
              setSelectedToolData({ ...selectedToolData, initialIndex: newIndex });
            }
          }}
          messages={playback.visibleMessages}
          agentStatus="idle"
          project={
            thread?.project
              ? {
                  id: thread.project.id,
                  name: thread.project.name,
                  sandbox: thread.project.sandbox,
                }
              : undefined
          }
          isLoading={isLoading}
          sandboxId={thread?.project?.sandbox?.id}
        />
      )}
    </>
  );
}
