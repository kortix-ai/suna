import * as React from 'react';
import { Platform, Pressable, View, ScrollView, Alert, Modal, RefreshControl, NativeScrollEvent, NativeSyntheticEvent, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withDelay,
  withRepeat,
  Easing,
} from 'react-native-reanimated';
import LottieView from 'lottie-react-native';
import {
  ThreadContent,
  ChatInputSection,
  ChatDrawers,
  type ToolMessagePair,
  CHAT_INPUT_SECTION_HEIGHT,
  extractLastToolFromMessages,
  extractToolFromStreamingMessage,
  type ToolSnackData,
} from '@/components/chat';
import { parseToolMessage } from '@agentpress/shared';
import { ThreadHeader } from '@/components/threads';
import { KortixComputer } from '@/components/kortix-computer';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useChatCommons, type UseChatReturn, useDeleteThread, useShareThread } from '@/hooks';
import { useThread } from '@/lib/chat';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MessageCircle, ArrowDown, AlertCircle, RefreshCw } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { AgentLoader } from '../chat/AgentLoader';
import { log } from '@/lib/logger';

interface ThreadPageProps {
  onMenuPress?: () => void;
  chat: UseChatReturn;
  isAuthenticated: boolean;
  onOpenWorkerConfig?: (
    workerId: string,
    view?: 'instructions' | 'tools' | 'integrations' | 'triggers'
  ) => void;
}

// Error banner shown when stream fails
const StreamErrorBanner = React.memo(function StreamErrorBanner({
  error,
  onRetry,
  hasActiveRun,
  isRetrying,
}: {
  error: string | null;
  onRetry: () => void;
  hasActiveRun?: boolean;
  isRetrying?: boolean;
}) {
  // Spinning animation for retry button (using Reanimated)
  const spinValue = useSharedValue(0);
  
  React.useEffect(() => {
    if (isRetrying) {
      // Continuous rotation using withRepeat
      spinValue.value = withRepeat(
        withTiming(360, { duration: 1000, easing: Easing.linear }),
        -1, // -1 = infinite repeat
        false // don't reverse
      );
    } else {
      spinValue.value = withTiming(0, { duration: 200 });
    }
  }, [isRetrying, spinValue]);
  
  const spinStyle = useAnimatedStyle(() => {
    return {
      transform: [{ rotate: `${spinValue.value}deg` }],
    };
  });

  // Clean up verbose error messages for display
  const displayError = React.useMemo(() => {
    if (!error) return '';
    // Extract just the key error info, not full HTML dumps
    if (error.includes('500') || error.includes('Internal server error')) {
      return 'Server error - please try again';
    }
    if (error.includes('timeout')) {
      return 'Connection timeout - please check your internet';
    }
    if (error.includes('network') || error.includes('connection')) {
      return 'Connection lost - please retry';
    }
    if (error.length > 100) {
      return 'Something went wrong';
    }
    return error;
  }, [error]);

  if (!error) return null;

  // Button text: if agent was running, we reconnect/refresh; otherwise resend
  const buttonText = isRetrying ? 'Retrying...' : (hasActiveRun ? 'Refresh' : 'Retry');

  return (
    <View className="mx-4 mb-3">
      <View className="flex-row items-center justify-between bg-destructive/10 border border-destructive/30 rounded-2xl px-4 py-3">
        <View className="flex-row items-center flex-1 gap-3">
          <View className="w-8 h-8 rounded-full bg-destructive/20 items-center justify-center">
            <Icon as={AlertCircle} size={18} className="text-destructive" />
          </View>
          <Text className="text-sm text-destructive flex-1" numberOfLines={2}>
            {displayError}
          </Text>
        </View>
        <Pressable
          onPress={onRetry}
          disabled={isRetrying}
          className={`flex-row items-center gap-1.5 bg-card border border-border rounded-full px-3 py-2 ml-2 ${isRetrying ? 'opacity-50' : 'active:opacity-70'}`}
        >
          <Animated.View style={spinStyle}>
            <Icon as={RefreshCw} size={14} className="text-foreground" />
          </Animated.View>
          <Text className="text-sm font-roobert-medium text-foreground">{buttonText}</Text>
        </Pressable>
      </View>
    </View>
  );
});

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

  // Track the active tool data for the snack bar
  // This persists after the tool completes so we can show "Success" state
  const [activeToolData, setActiveToolData] = React.useState<ToolSnackData | null>(null);
  const lastToolCallIdRef = React.useRef<string | null>(null);

  // Track if user dismissed the snack (so we don't show it again for the same tool)
  const [dismissedToolCallId, setDismissedToolCallId] = React.useState<string | null>(null);

  // Handle snack dismiss - user swiped to close
  const handleToolSnackDismiss = React.useCallback(() => {
    log.log('[ToolSnack] 👋 User dismissed snack for:', activeToolData?.toolCallId);
    if (activeToolData?.toolCallId) {
      setDismissedToolCallId(activeToolData.toolCallId);
    }
    setActiveToolData(null);
  }, [activeToolData?.toolCallId]);

  // Update activeToolData when streamingToolCall changes
  React.useEffect(() => {
    log.log('[ToolSnack] streamingToolCall changed:', streamingToolCall ? 'has data' : 'null');
    const extracted = extractToolFromStreamingMessage(streamingToolCall);
    log.log('[ToolSnack] Extracted from streaming:', extracted?.toolName || 'null');
    if (extracted) {
      // Check if this is a NEW tool (different from dismissed one)
      if (extracted.toolCallId && extracted.toolCallId !== dismissedToolCallId) {
        // New tool - clear dismissed state and show
        if (dismissedToolCallId) {
          log.log('[ToolSnack] New tool started, clearing dismissed state');
          setDismissedToolCallId(null);
        }
        setActiveToolData(extracted);
        lastToolCallIdRef.current = extracted.toolCallId || null;
      } else if (!dismissedToolCallId) {
        // No dismissed state, just update
        setActiveToolData(extracted);
        lastToolCallIdRef.current = extracted.toolCallId || null;
      }
    }
    // Don't clear when streamingToolCall becomes null - we want to persist the last state
  }, [streamingToolCall, dismissedToolCallId]);

  // When messages load/change, check if we should show a tool from existing messages
  // This handles:
  // 1. Opening an existing thread with tools (activeToolData is null)
  // 2. When a streaming tool completes (activeToolData.isStreaming is true, tool message appears)
  React.useEffect(() => {
    log.log('[ToolSnack] Messages effect - count:', messages.length, 'activeToolData:', activeToolData?.toolName || 'null', 'isStreaming:', activeToolData?.isStreaming);

    if (messages.length === 0) return;

    // Case 1: No active tool data - set from messages (unless dismissed)
    if (!activeToolData) {
      const lastTool = extractLastToolFromMessages(messages);
      log.log('[ToolSnack] Setting from messages (no active):', lastTool?.toolName || 'null');
      if (lastTool) {
        // Only show if not the dismissed tool
        if (lastTool.toolCallId !== dismissedToolCallId) {
          setActiveToolData(lastTool);
          lastToolCallIdRef.current = lastTool.toolCallId || null;
        } else {
          log.log('[ToolSnack] Tool was dismissed, not showing');
        }
      }
      return;
    }

    // Case 2: Active tool is streaming - check if it completed in messages
    if (activeToolData.isStreaming && activeToolData.toolCallId) {
      // Look for this tool in messages to see if it completed
      const completedTool = extractLastToolFromMessages(messages);
      if (completedTool && completedTool.toolCallId === activeToolData.toolCallId && !completedTool.isStreaming) {
        log.log('[ToolSnack] Tool completed! Updating from streaming to:', completedTool.success ? 'success' : 'failed');
        setActiveToolData(completedTool);
      }
    }

    // Case 3: Active tool is not streaming but check if there's a newer tool in messages
    // This handles when multiple tools run in sequence
    if (!activeToolData.isStreaming) {
      const lastTool = extractLastToolFromMessages(messages);
      if (lastTool && lastTool.toolCallId !== activeToolData.toolCallId) {
        // New tool found - clear dismissed state and show
        log.log('[ToolSnack] Newer tool found in messages:', lastTool.toolName);
        if (dismissedToolCallId) {
          setDismissedToolCallId(null);
        }
        setActiveToolData(lastTool);
        lastToolCallIdRef.current = lastTool.toolCallId || null;
      }
    }
  }, [messages, activeToolData, dismissedToolCallId]);

  // Clear activeToolData and dismissed state when thread changes
  React.useEffect(() => {
    log.log('[ToolSnack] Thread changed, clearing activeToolData and dismissed state');
    setActiveToolData(null);
    setDismissedToolCallId(null);
    lastToolCallIdRef.current = null;
  }, [chat.activeThread?.id]);

  const windowHeight = Dimensions.get('window').height;
  const baseBottomPadding = CHAT_INPUT_SECTION_HEIGHT.THREAD_PAGE + insets.bottom;
  const [isUserScrolling, setIsUserScrolling] = React.useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [pushToTop, setPushToTop] = React.useState(false);
  const hasScrolledToBottomOnOpenRef = React.useRef(false);
  const lastUserMessageCountRef = React.useRef(0);
  const contentHeightRef = React.useRef(0);
  const viewportHeightRef = React.useRef(0);
  const scrollLockActiveRef = React.useRef(false);
  const agentWasRunningRef = React.useRef(false);
  const pushActivatedContentHeightRef = React.useRef<number | null>(null);

  // Count user messages
  const userMessageCount = React.useMemo(() =>
    messages.filter(m => m.type === 'user').length,
    [messages]
  );

  // Calculate extra padding - ONLY based on pushToTop state to avoid re-renders from streaming changes
  const extraPushPadding = React.useMemo(() => {
    if (pushToTop) {
      const headerHeight = Math.max(insets.top, 16) + 80;
      const availableHeight = windowHeight - headerHeight - baseBottomPadding;
      // Leave room for user message (~100px) + 10% buffer from top
      const userMessageHeight = 100;
      const topBuffer = availableHeight * 0.10;
      return availableHeight - userMessageHeight - topBuffer;
    }
    return 0;
  }, [pushToTop, windowHeight, insets.top, baseBottomPadding]);

  const contentBottomPadding = baseBottomPadding + extraPushPadding;

  // Track viewport size
  const handleLayout = React.useCallback((event: any) => {
    viewportHeightRef.current = event.nativeEvent.layout.height;
  }, []);

  // Track content size changes
  const handleContentSizeChange = React.useCallback((_contentWidth: number, contentHeight: number) => {
    const prevHeight = contentHeightRef.current;
    contentHeightRef.current = contentHeight;

    // Scroll when padding is applied (content grew significantly)
    if (scrollLockActiveRef.current && contentHeight > prevHeight + 100) {
      const maxY = Math.max(0, contentHeight - viewportHeightRef.current);
      scrollViewRef.current?.scrollTo({ y: maxY, animated: false });
      scrollLockActiveRef.current = false;
    }

    // Check if content overflows and we're not at the bottom - show scroll button
    const actualContentHeight = contentHeight - extraPushPadding;
    const hasOverflow = actualContentHeight > viewportHeightRef.current;
    const currentScrollY = lastScrollYRef.current;
    const actualMaxScrollY = Math.max(0, actualContentHeight - viewportHeightRef.current);
    const isAtActualBottom = currentScrollY >= actualMaxScrollY - 50;

    if (hasOverflow && !isAtActualBottom && !isUserScrolling) {
      setShowScrollToBottom(true);
    }

    // Track content height when push is activated
    // NOTE: We NO LONGER remove pushToTop based on content growth during streaming
    // This prevents the jarring shift when agent starts typing after "brewing ideas"
    // pushToTop is now only removed when agent finishes (see effect below)
    if (pushToTop && pushActivatedContentHeightRef.current === null) {
      pushActivatedContentHeightRef.current = contentHeight;
    }
  }, [extraPushPadding, isUserScrolling, pushToTop]);

  // Scroll to bottom when thread first opens
  // Skip for new optimistic threads - content is minimal and at top, no scroll needed
  React.useEffect(() => {
    if (messages.length > 0 && !hasScrolledToBottomOnOpenRef.current && !pushToTop && !chat.isNewThreadOptimistic) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: false });
        hasScrolledToBottomOnOpenRef.current = true;
      }, 150);
    }
  }, [messages.length, pushToTop, chat.isNewThreadOptimistic]);

  // Reset when thread changes
  React.useEffect(() => {
    hasScrolledToBottomOnOpenRef.current = false;
    lastUserMessageCountRef.current = userMessageCount;
    setPushToTop(false);
    scrollLockActiveRef.current = false;
    agentWasRunningRef.current = false;
    pushActivatedContentHeightRef.current = null;
  }, [chat.activeThread?.id]);

  // Activate pushToTop immediately when user starts sending (before message appears)
  // This ensures the layout is ready before the optimistic message renders
  const wasSendingRef = React.useRef(false);
  React.useEffect(() => {
    if (chat.isSendingMessage && !wasSendingRef.current) {
      // User just started sending - activate push immediately
      // Skip for first message in new thread (isNewThreadOptimistic) - content is minimal, no push needed
      // Also check messages.length > 1 to ensure there are previous messages (not just the current optimistic one)
      if (messages.length > 1 && !chat.isNewThreadOptimistic) {
        setPushToTop(true);
        scrollLockActiveRef.current = true;
        setIsUserScrolling(false);
        pushActivatedContentHeightRef.current = contentHeightRef.current;

        // Scroll to end immediately
        scrollViewRef.current?.scrollToEnd({ animated: false });
      }
    }
    wasSendingRef.current = chat.isSendingMessage;
  }, [chat.isSendingMessage, messages.length, chat.isNewThreadOptimistic]);

  // When user sends a NEW message - reinforce push to top and scroll
  // Only trigger for ACTUAL new messages (count increases by 1-2), NOT bulk thread loads
  React.useEffect(() => {
    const prevCount = lastUserMessageCountRef.current;
    const diff = userMessageCount - prevCount;

    // Only trigger if:
    // 1. Count increased by 1-2 (actual new message, not bulk load)
    // 2. Previous count was > 0 (thread was already loaded, not initial load)
    const isActualNewMessage = diff > 0 && diff <= 2 && prevCount > 0;

    if (isActualNewMessage) {
      // Reinforce pushToTop (might already be true from isSendingMessage effect)
      if (!pushToTop) {
        setPushToTop(true);
        pushActivatedContentHeightRef.current = contentHeightRef.current;
      }
      scrollLockActiveRef.current = true;
      setIsUserScrolling(false);

      // Multiple scroll attempts to ensure we're at bottom
      const scrollAttempt = (ms: number) => {
        setTimeout(() => {
          scrollViewRef.current?.scrollToEnd({ animated: false });
        }, ms);
      };

      scrollAttempt(0);
      scrollAttempt(30);
      scrollAttempt(60);
      scrollAttempt(100);
      scrollAttempt(150);
      scrollAttempt(200);
    }

    lastUserMessageCountRef.current = userMessageCount;
  }, [userMessageCount, pushToTop]);

  // Track when agent is running
  // NOTE: We NO LONGER remove pushToTop when agent finishes
  // This prevents the jarring shift when the agent completes
  // The extra padding at the bottom is harmless - user can scroll naturally
  // pushToTop is only reset when:
  // 1. Thread changes (in the reset effect above)
  // 2. User scrolls up significantly (handled below)
  React.useEffect(() => {
    const isRunning = chat.isStreaming || chat.isAgentRunning;
    if (isRunning) {
      agentWasRunningRef.current = true;
    } else {
      agentWasRunningRef.current = false;
    }
  }, [chat.isStreaming, chat.isAgentRunning]);

  const lastScrollYRef = React.useRef(0);

  const scrollButtonOpacity = useSharedValue(0);
  const scrollButtonScale = useSharedValue(0.8);

  const scrollButtonAnimatedStyle = useAnimatedStyle(() => ({
    opacity: scrollButtonOpacity.value,
    transform: [{ scale: scrollButtonScale.value }],
  }));

  // Show/hide scroll button with animation
  // When sending a message, hide instantly (no animation)
  React.useEffect(() => {
    if (showScrollToBottom) {
      scrollButtonOpacity.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.ease) });
      scrollButtonScale.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.back(1.5)) });
    } else {
      // If sending message, hide instantly without animation
      if (chat.isSendingMessage) {
        scrollButtonOpacity.value = 0;
        scrollButtonScale.value = 0.8;
      } else {
        scrollButtonOpacity.value = withTiming(0, { duration: 150, easing: Easing.in(Easing.ease) });
        scrollButtonScale.value = withTiming(0.8, { duration: 150, easing: Easing.in(Easing.ease) });
      }
    }
  }, [showScrollToBottom, scrollButtonOpacity, scrollButtonScale, chat.isSendingMessage]);

  const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const currentScrollY = contentOffset.y;

    // Calculate the ACTUAL content bottom (excluding extra push padding)
    const actualContentHeight = contentSize.height - extraPushPadding;
    const actualMaxScrollY = Math.max(0, actualContentHeight - layoutMeasurement.height);

    // Check if content is larger than viewport
    const hasOverflow = actualContentHeight > layoutMeasurement.height;

    // User is at bottom of ACTUAL content (not counting padding)
    const isAtActualBottom = currentScrollY >= actualMaxScrollY - 50;

    // Track for calculations
    contentHeightRef.current = contentSize.height;
    viewportHeightRef.current = layoutMeasurement.height;
    lastScrollYRef.current = currentScrollY;

    // Show "scroll to bottom" button when:
    // 1. Content overflows the viewport
    // 2. User is NOT at the bottom of actual content
    if (hasOverflow && !isAtActualBottom) {
      setIsUserScrolling(true);
      setShowScrollToBottom(true);
    } else {
      setIsUserScrolling(false);
      setShowScrollToBottom(false);
    }

    // Remove pushToTop padding when user scrolls up significantly
    // This is user-initiated so it won't feel jarring
    // Only do this when agent is NOT running to avoid mid-stream issues
    if (pushToTop && hasOverflow && !chat.isStreaming && !chat.isAgentRunning) {
      // If user has scrolled up more than 100px from bottom, remove the extra padding
      const distanceFromBottom = actualMaxScrollY - currentScrollY;
      if (distanceFromBottom > 100) {
        setPushToTop(false);
        pushActivatedContentHeightRef.current = null;
      }
    }
  }, [extraPushPadding, pushToTop, chat.isStreaming, chat.isAgentRunning]);

  const scrollToBottom = React.useCallback(() => {
    if (pushToTop && extraPushPadding > 0) {
      // In pushToTop mode, scroll to actual content bottom (not the extra padding)
      const actualContentHeight = contentHeightRef.current - extraPushPadding;
      const targetY = Math.max(0, actualContentHeight - viewportHeightRef.current);
      scrollViewRef.current?.scrollTo({ y: targetY, animated: true });
    } else {
      // Normal mode - scroll to very end
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }
    setIsUserScrolling(false);
    setShowScrollToBottom(false);
  }, [pushToTop, extraPushPadding]);

  const handleRefresh = React.useCallback(async () => {
    if (chat.isStreaming || chat.isAgentRunning) {
      return;
    }

    setIsRefreshing(true);

    try {
      await chat.refreshMessages();
    } catch (error) {
      log.error('Failed to refresh:', error);
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
          log.error('Failed to load thread messages:', error);
          Alert.alert('Error', 'Failed to load thread messages. Please try again.');
        });
      }
    }
  }, [chat.activeThread?.id, messages.length, isLoading, chat.isStreaming, chat.refreshMessages]);

  return (
    <View className="flex-1 bg-background">
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
              // NOTE: No flexGrow or justifyContent - content starts at top and grows down
              // This prevents scroll jump issues during streaming
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
            onLayout={handleLayout}
            onContentSizeChange={handleContentSizeChange}
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
              <>
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
                  isSendingMessage={chat.isSendingMessage}
                  isReconnecting={chat.isReconnecting}
                  retryCount={chat.retryCount}
                />
                {/* Stream error banner with retry/refresh */}
                <StreamErrorBanner 
                  error={chat.streamError} 
                  onRetry={chat.retryLastMessage}
                  hasActiveRun={chat.hasActiveRun}
                  isRetrying={chat.isRetrying}
                />
              </>
            )}
          </ScrollView>
        )}
      </View>
      {hasMessages && (
        <Animated.View
          style={[
            {
              position: 'absolute',
              right: 10,
              // When snack is visible, keep position higher; when no snack, move down 40px
              bottom: baseBottomPadding - 0 + (activeToolData ? 0 : -40),
              zIndex: 150,
            },
            scrollButtonAnimatedStyle,
          ]}
          pointerEvents={showScrollToBottom ? 'auto' : 'none'}
        >
          <Pressable
            onPress={scrollToBottom}
            className="h-12 w-12 items-center justify-center rounded-full border border-border bg-card active:opacity-80"
          >
            <Icon as={ArrowDown} size={20} className="text-foreground" strokeWidth={2} />
          </Pressable>
        </Animated.View>
      )}

      <ThreadHeader
        threadTitle={
          fullThreadData?.project?.name || fullThreadData?.title || chat.activeThread?.title
        }
        onTitleChange={async (newTitle) => {
          try {
            await chat.updateThreadTitle(newTitle);
          } catch (error) {
            log.error('Failed to update thread title:', error);
          }
        }}
        onBackPress={chat.showModeThreadList}
        onShare={async () => {
          if (!chat.activeThread?.id) return;
          try {
            await shareThreadMutation.mutateAsync(chat.activeThread.id);
          } catch (error) {
            log.error('Failed to share thread:', error);
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
            log.error('Failed to delete thread:', error);
          }
        }}
      />

      <ChatInputSection
        value={chat.inputValue}
        onChangeText={chat.setInputValue}
        onSendMessage={(content, agentId, agentName) => {
          // Clear the tool snack when sending a new message
          setActiveToolData(null);
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
        activeToolData={activeToolData}
        agentName={agentManager.selectedAgent?.name}
        onToolSnackPress={() => {
          log.log('[ToolSnackPress] Pressed! activeToolData:', activeToolData);
          log.log('[ToolSnackPress] Total messages:', messages.length);

          // Build ALL tool message pairs from the thread (same logic as ThreadContent)
          const assistantMessages = messages.filter((m) => m.type === 'assistant');
          const toolMsgs = messages.filter((m) => m.type === 'tool');

          log.log('[ToolSnackPress] Assistant messages:', assistantMessages.length);
          log.log('[ToolSnackPress] Tool messages:', toolMsgs.length);

          // Map tool messages to their assistant messages
          const toolMap = new Map<string | null, typeof messages>();
          toolMsgs.forEach((toolMsg) => {
            try {
              // Handle metadata as string OR object
              let metadata: Record<string, any> = {};
              if (typeof toolMsg.metadata === 'string') {
                try {
                  metadata = JSON.parse(toolMsg.metadata || '{}');
                } catch {
                  metadata = {};
                }
              } else if (toolMsg.metadata && typeof toolMsg.metadata === 'object') {
                metadata = toolMsg.metadata as Record<string, any>;
              }

              const assistantId = metadata.assistant_message_id || null;

              const parsed = parseToolMessage(toolMsg);
              const toolName = parsed?.toolName || '';

              log.log('[ToolSnackPress] Processing tool:', toolName, 'assistantId:', assistantId);

              // Skip ask/complete tools
              if (toolName === 'ask' || toolName === 'complete') {
                log.log('[ToolSnackPress] Skipping ask/complete tool');
                return;
              }

              if (!toolMap.has(assistantId)) {
                toolMap.set(assistantId, []);
              }
              toolMap.get(assistantId)!.push(toolMsg);
            } catch (e) {
              log.log('[ToolSnackPress] Error processing tool:', e);
            }
          });

          log.log('[ToolSnackPress] ToolMap size:', toolMap.size);

          // Build pairs from assistant messages
          const allPairs: ToolMessagePair[] = [];
          assistantMessages.forEach((assistantMsg) => {
            const linkedTools = toolMap.get(assistantMsg.message_id || null);
            if (linkedTools && linkedTools.length > 0) {
              log.log('[ToolSnackPress] Found', linkedTools.length, 'tools for assistant:', assistantMsg.message_id);
              linkedTools.forEach((toolMsg) => {
                allPairs.push({
                  assistantMessage: assistantMsg,
                  toolMessage: toolMsg,
                });
              });
            }
          });

          // Add orphaned tools (no assistant message)
          const orphanedTools = toolMap.get(null);
          log.log('[ToolSnackPress] Orphaned tools:', orphanedTools?.length || 0);
          if (orphanedTools) {
            orphanedTools.forEach((toolMsg) => {
              allPairs.push({
                assistantMessage: assistantMessages[0] || null,
                toolMessage: toolMsg,
              });
            });
          }

          log.log('[ToolSnackPress] Built', allPairs.length, 'tool pairs from thread');

          if (allPairs.length === 0) {
            log.log('[ToolSnackPress] No tool pairs found, just opening panel');
            openPanel();
            return;
          }

          // Find the index of the clicked tool
          let clickedIndex = allPairs.length - 1; // Default to last tool

          if (activeToolData?.toolCallId) {
            const foundIndex = allPairs.findIndex(pair => {
              const parsed = parseToolMessage(pair.toolMessage);
              return parsed?.toolCallId === activeToolData.toolCallId;
            });
            if (foundIndex >= 0) {
              clickedIndex = foundIndex;
              log.log('[ToolSnackPress] Found tool at index', clickedIndex, 'by toolCallId');
            }
          } else if (activeToolData?.functionName) {
            // Find by function name (last matching one)
            for (let i = allPairs.length - 1; i >= 0; i--) {
              const parsed = parseToolMessage(allPairs[i].toolMessage);
              const msgFnName = (parsed?.functionName || '').replace(/_/g, '-').toLowerCase();
              const targetFnName = activeToolData.functionName.replace(/_/g, '-').toLowerCase();
              if (msgFnName === targetFnName) {
                clickedIndex = i;
                log.log('[ToolSnackPress] Found tool at index', clickedIndex, 'by functionName');
                break;
              }
            }
          }

          log.log('[ToolSnackPress] Setting selectedToolData with', allPairs.length, 'pairs, initialIndex:', clickedIndex);
          setSelectedToolData({ toolMessages: allPairs, initialIndex: clickedIndex });
          openPanel();
        }}
        onToolSnackDismiss={handleToolSnackDismiss}
      />

      <ChatDrawers
        isAgentDrawerVisible={agentManager.isDrawerVisible}
        onCloseAgentDrawer={agentManager.closeDrawer}
        onOpenWorkerConfig={(workerId, view) => {
          log.log('🔧 [ThreadPage] Opening worker config:', {
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
            log.log('🔧 [ThreadPage] AgentDrawer visible, closing first');
            agentManager.closeDrawer();

            // Fallback: if onDismiss doesn't fire within 500ms, open anyway
            pendingWorkerConfigTimeoutRef.current = setTimeout(() => {
              log.log('⏰ [ThreadPage] Fallback timeout - opening WorkerConfigDrawer');
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
            log.log('✅ [ThreadPage] AgentDrawer not visible, opening immediately');
            pendingWorkerConfigRef.current = null;
            setWorkerConfigWorkerId(workerId);
            setWorkerConfigInitialView(view || 'instructions');
            setIsWorkerConfigDrawerVisible(true);
          }
        }}
        onAgentDrawerDismiss={() => {
          log.log('🎭 [ThreadPage] AgentDrawer dismissed');

          // Clear fallback timeout since dismiss fired
          if (pendingWorkerConfigTimeoutRef.current) {
            clearTimeout(pendingWorkerConfigTimeoutRef.current);
            pendingWorkerConfigTimeoutRef.current = null;
          }

          // Check REF (not state) for pending config
          const pending = pendingWorkerConfigRef.current;
          if (pending) {
            log.log('🎭 [ThreadPage] Opening pending WorkerConfigDrawer');
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
