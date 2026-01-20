import { MenuPage, HomePage, ThreadPage } from '@/components/pages';
import type { HomePageRef } from '@/components/pages/HomePage';
import { useSideMenu, usePageNavigation, useChat, useAgentManager } from '@/hooks';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useAdminRole } from '@/hooks/useAdminRole';
import { useAuthContext } from '@/contexts';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { StatusBar as RNStatusBar, View, Dimensions, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import type { Agent } from '@/api/types';
import type { Conversation } from '@/components/menu/types';
import { FeedbackDrawer } from '@/components/chat/tool-views/complete-tool/FeedbackDrawer';
import { useFeedbackDrawerStore } from '@/stores/feedback-drawer-store';
import { MaintenanceBanner, TechnicalIssueBanner, MaintenancePage } from '@/components/status';
import { log } from '@/lib/logger';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function AppScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const { isAuthenticated } = useAuthContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { threadId } = useLocalSearchParams<{ threadId?: string }>();
  const chat = useChat();
  const pageNav = usePageNavigation();
  const { isOpen: isFeedbackDrawerOpen } = useFeedbackDrawerStore();
  const homePageRef = React.useRef<HomePageRef>(null);
  const { data: systemStatus, refetch: refetchSystemStatus, isLoading: isSystemStatusLoading } = useSystemStatus();
  const { data: adminRole } = useAdminRole();
  const isAdmin = adminRole?.isAdmin ?? false;

  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);

  const handleOpenDrawer = React.useCallback(() => {
    // Start animation immediately
    translateX.value = withTiming(SCREEN_WIDTH, {
      duration: 200,
      easing: Easing.out(Easing.exp),
    });
    setTimeout(() => pageNav.openDrawer(), 0);
  }, [pageNav]);

  const handleCloseDrawer = React.useCallback(() => {
    translateX.value = withTiming(0, {
      duration: 200,
      easing: Easing.out(Easing.exp),
    });
    setTimeout(() => pageNav.closeDrawer(), 0);
  }, [pageNav]);

  React.useEffect(() => {
    const targetValue = pageNav.isDrawerOpen ? SCREEN_WIDTH : 0;
    if (Math.abs(translateX.value - targetValue) > 10) {
      translateX.value = withTiming(targetValue, {
        duration: 200,
        easing: Easing.out(Easing.exp),
      });
    }
  }, [pageNav.isDrawerOpen]);

  const handleGestureEnd = React.useCallback((shouldOpen: boolean) => {
    if (shouldOpen && !pageNav.isDrawerOpen) {
      pageNav.openDrawer();
    } else if (!shouldOpen && pageNav.isDrawerOpen) {
      pageNav.closeDrawer();
    }
  }, [pageNav]);

  const panGesture = React.useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-10, 10])
        .failOffsetY([-10, 10])
        .onStart(() => {
          'worklet';
          startX.value = translateX.value;
        })
        .onUpdate((event) => {
          'worklet';
          const newValue = startX.value + event.translationX;
          translateX.value = Math.max(0, Math.min(SCREEN_WIDTH, newValue));
        })
        .onEnd((event) => {
          'worklet';
          const shouldOpen = translateX.value > SCREEN_WIDTH * 0.5 || event.velocityX > 500;

          if (shouldOpen) {
            translateX.value = withTiming(SCREEN_WIDTH, { 
              duration: 150,
              easing: Easing.out(Easing.exp),
            });
            runOnJS(handleGestureEnd)(true);
          } else {
            translateX.value = withTiming(0, { 
              duration: 150,
              easing: Easing.out(Easing.exp),
            });
            runOnJS(handleGestureEnd)(false);
          }
        }),
    [handleGestureEnd]
  );

  const edgeGesture = React.useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([0, 20])
        .onStart(() => {
          'worklet';
          startX.value = 0;
        })
        .onUpdate((event) => {
          'worklet';
          if (event.translationX > 0) {
            translateX.value = Math.min(SCREEN_WIDTH, event.translationX);
          }
        })
        .onEnd((event) => {
          'worklet';
          const shouldOpen = translateX.value > SCREEN_WIDTH * 0.3 || event.velocityX > 500;

          if (shouldOpen) {
            translateX.value = withTiming(SCREEN_WIDTH, { 
              duration: 150,
              easing: Easing.out(Easing.exp),
            });
            runOnJS(handleGestureEnd)(true);
          } else {
            translateX.value = withTiming(0, { 
              duration: 150,
              easing: Easing.out(Easing.exp),
            });
            runOnJS(handleGestureEnd)(false);
          }
        }),
    [handleGestureEnd]
  );

  const combinedGesture = React.useMemo(
    () => Gesture.Race(edgeGesture, panGesture),
    [edgeGesture, panGesture]
  );

  const menuPageStyle = useAnimatedStyle(() => {
    const progress = translateX.value / SCREEN_WIDTH;
    const opacity = 0.3 + (progress * 0.7); // 0.3 when closed, 1 when open
    
    return {
      transform: [
        {
          translateX: translateX.value - SCREEN_WIDTH,
        },
      ],
      opacity,
    };
  });

  const homePageStyle = useAnimatedStyle(() => {
    const progress = translateX.value / SCREEN_WIDTH;
    const opacity = 1 - (progress * 0.3); // 1 when closed, 0.7 when open
    
    return {
      transform: [
        {
          translateX: translateX.value,
        },
      ],
      opacity,
    };
  });

  const isMaintenanceActive = React.useMemo(() => {
    const notice = systemStatus?.maintenanceNotice;
    if (!notice?.enabled || !notice.startTime || !notice.endTime) {
      return false;
    }
    const now = new Date();
    const start = new Date(notice.startTime);
    const end = new Date(notice.endTime);
    return now >= start && now <= end;
  }, [systemStatus?.maintenanceNotice]);

  const isMaintenanceScheduled = React.useMemo(() => {
    const notice = systemStatus?.maintenanceNotice;
    if (!notice?.enabled || !notice.startTime || !notice.endTime) {
      return false;
    }
    const now = new Date();
    const start = new Date(notice.startTime);
    return now < start;
  }, [systemStatus?.maintenanceNotice]);

  const [menuWorkerConfigWorkerId, setMenuWorkerConfigWorkerId] = React.useState<string | null>(
    null
  );
  const [menuWorkerConfigInitialView, setMenuWorkerConfigInitialView] = React.useState<
    'instructions' | 'tools' | 'integrations' | 'triggers' | undefined
  >(undefined);

  const canSendMessages = isAuthenticated;

  React.useEffect(() => {
    if (threadId && threadId !== chat.activeThread?.id) {
      log.log('🎯 Loading thread from URL parameter:', threadId);
      chat.loadThread(threadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const handleNewChat = React.useCallback(() => {
    log.log('🆕 New Chat clicked - Starting new chat');
    chat.startNewChat();
    pageNav.closeDrawer();

    setTimeout(() => {
      log.log('🎯 Focusing chat input after new chat');
      homePageRef.current?.focusChatInput();
    }, 300);
  }, [chat, pageNav]);

  const handleAgentPress = React.useCallback(
    (agent: Agent) => {
      log.log('🤖 Agent selected:', agent.name);
      log.log('📊 Starting chat with:', agent);
      chat.startNewChat();
      pageNav.closeDrawer();
    },
    [chat, pageNav]
  );

  const menu = useSideMenu({ onNewChat: handleNewChat });
  const agentManager = useAgentManager();

  const handleConversationPress = React.useCallback(
    (conversation: Conversation) => {
      log.log('📖 Loading thread:', conversation.id);
      chat.loadThread(conversation.id);
      pageNav.closeDrawer();
    },
    [chat, pageNav]
  );

  const handleProfilePress = React.useCallback(() => {
    log.log('🎯 Profile pressed');
    if (!isAuthenticated) {
      log.log('🔐 User not authenticated, redirecting to auth');
      router.push('/auth');
    } else {
      menu.handleProfilePress();
    }
  }, [isAuthenticated, menu, router]);

  const handleOpenWorkerConfigFromAgentDrawer = React.useCallback(
    (workerId: string, view?: 'instructions' | 'tools' | 'integrations' | 'triggers') => {
      log.log('🔧 [home] Opening worker config from AgentDrawer:', workerId, view);
      agentManager.closeDrawer();
      pageNav.closeDrawer();
      setTimeout(() => {
        router.push({
          pathname: '/worker-config',
          params: { workerId, ...(view && { view }) },
        });
      }, 300);
    },
    [agentManager, pageNav, router]
  );

  const handleCloseMenuWorkerConfig = React.useCallback(() => {
    log.log('🔧 [home] Closing worker config in MenuPage');
    setMenuWorkerConfigWorkerId(null);
    setMenuWorkerConfigInitialView(undefined);
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <RNStatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />

      <View className="flex-1 bg-background">
        {!pageNav.isDrawerOpen && (
          <GestureDetector gesture={edgeGesture}>
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: 30,
                height: '100%',
                zIndex: 100,
              }}
            />
          </GestureDetector>
        )}
        
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: 0,
              left: 0,
              width: SCREEN_WIDTH,
              height: '100%',
            },
            menuPageStyle,
          ]}
          className="bg-background">
          <MenuPage
            sections={menu.sections}
            profile={menu.profile}
            activeTab={menu.activeTab}
            onNewChat={handleNewChat}
            onNewWorker={() => {
              log.log('🤖 New Worker clicked');
              handleCloseDrawer();
            }}
            onNewTrigger={() => {
              log.log('⚡ New Trigger clicked');
              handleCloseDrawer();
            }}
            selectedAgentId={agentManager.selectedAgent?.agent_id}
            onConversationPress={handleConversationPress}
            onAgentPress={handleAgentPress}
            onProfilePress={handleProfilePress}
            onChatsPress={menu.handleChatsTabPress}
            onWorkersPress={menu.handleWorkersTabPress}
            onTriggersPress={menu.handleTriggersTabPress}
            onClose={handleCloseDrawer}
            workerConfigWorkerId={menuWorkerConfigWorkerId}
            workerConfigInitialView={menuWorkerConfigInitialView}
            onCloseWorkerConfigDrawer={handleCloseMenuWorkerConfig}
          />
        </Animated.View>
        <GestureDetector gesture={combinedGesture}>
          <Animated.View style={[{ flex: 1 }, homePageStyle]}>
            <Pressable 
              style={{ flex: 1 }} 
              onPress={() => {
                if (pageNav.isDrawerOpen) {
                  handleCloseDrawer();
                }
              }}
              disabled={!pageNav.isDrawerOpen}>
              <View className="flex-1">
              {isMaintenanceActive ? (
                <MaintenancePage 
                  onRefresh={() => refetchSystemStatus()}
                  isRefreshing={isSystemStatusLoading}
                />
              ) : (
                <>
                  {chat.hasActiveThread ? (
                    <ThreadPage
                      onMenuPress={handleOpenDrawer}
                      chat={chat}
                      isAuthenticated={canSendMessages}
                      onOpenWorkerConfig={handleOpenWorkerConfigFromAgentDrawer}
                    />
                  ) : (
                    <View className="flex-1">
                      <HomePage
                        ref={homePageRef}
                        onMenuPress={handleOpenDrawer}
                        chat={chat}
                        isAuthenticated={canSendMessages}
                        onOpenWorkerConfig={handleOpenWorkerConfigFromAgentDrawer}
                        showThreadListView={false}
                      />
                      {(isMaintenanceScheduled || (systemStatus?.technicalIssue?.enabled && systemStatus.technicalIssue.message)) && (
                        <View style={{ position: 'absolute', top: insets.top + 60, left: 0, right: 0 }}>
                          {isMaintenanceScheduled && systemStatus?.maintenanceNotice?.startTime && systemStatus.maintenanceNotice.endTime && (
                            <MaintenanceBanner
                              startTime={systemStatus.maintenanceNotice.startTime}
                              endTime={systemStatus.maintenanceNotice.endTime}
                              updatedAt={systemStatus.updatedAt}
                            />
                          )}
                          {systemStatus?.technicalIssue?.enabled && systemStatus.technicalIssue.message && (
                            <TechnicalIssueBanner
                              message={systemStatus.technicalIssue.message}
                              statusUrl={systemStatus.technicalIssue.statusUrl}
                              description={systemStatus.technicalIssue.description}
                              estimatedResolution={systemStatus.technicalIssue.estimatedResolution}
                              severity={systemStatus.technicalIssue.severity}
                              affectedServices={systemStatus.technicalIssue.affectedServices}
                              updatedAt={systemStatus.updatedAt}
                            />
                          )}
                        </View>
                      )}
                    </View>
                  )}
                </>
              )}
              </View>
            </Pressable>
          </Animated.View>
        </GestureDetector>
      </View>
      {isFeedbackDrawerOpen && <FeedbackDrawer />}
    </>
  );
}
