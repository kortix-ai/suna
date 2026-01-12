import { MenuPage, HomePage, ThreadPage } from '@/components/pages';
import type { HomePageRef } from '@/components/pages/HomePage';
import { useSideMenu, usePageNavigation, useChat, useAgentManager } from '@/hooks';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useAdminRole } from '@/hooks/useAdminRole';
import { useAuthContext } from '@/contexts';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { StatusBar as RNStatusBar, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Drawer } from 'react-native-drawer-layout';
import { useQueryClient } from '@tanstack/react-query';
import type { Agent } from '@/api/types';
import type { Conversation } from '@/components/menu/types';
import { FeedbackDrawer } from '@/components/chat/tool-views/complete-tool/FeedbackDrawer';
import { useFeedbackDrawerStore } from '@/stores/feedback-drawer-store';
import { MaintenanceBanner, TechnicalIssueBanner, MaintenancePage } from '@/components/status';
import { log } from '@/lib/logger';

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

  // Worker config drawer state for MenuPage
  const [menuWorkerConfigWorkerId, setMenuWorkerConfigWorkerId] = React.useState<string | null>(
    null
  );
  const [menuWorkerConfigInitialView, setMenuWorkerConfigInitialView] = React.useState<
    'instructions' | 'tools' | 'integrations' | 'triggers' | undefined
  >(undefined);

  const canSendMessages = isAuthenticated;

  // Load thread from URL parameter - only depend on threadId to prevent infinite loops
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

  // Handle opening worker config from AgentDrawer's Worker Settings buttons
  const handleOpenWorkerConfigFromAgentDrawer = React.useCallback(
    (workerId: string, view?: 'instructions' | 'tools' | 'integrations' | 'triggers') => {
      log.log('🔧 [home] Opening worker config from AgentDrawer:', workerId, view);
      // Close agent drawer and side menu drawer
      agentManager.closeDrawer();
      pageNav.closeDrawer();
      // Wait for drawer animation to complete before navigating
      setTimeout(() => {
        // Navigate directly to the worker config page using push so there's a route to go back to
        router.push({
          pathname: '/worker-config',
          params: { workerId, ...(view && { view }) },
        });
      }, 300);
    },
    [agentManager, pageNav, router]
  );

  // Handle closing worker config drawer in MenuPage
  const handleCloseMenuWorkerConfig = React.useCallback(() => {
    log.log('🔧 [home] Closing worker config in MenuPage');
    setMenuWorkerConfigWorkerId(null);
    setMenuWorkerConfigInitialView(undefined);
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <RNStatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />

      <Drawer
        open={pageNav.isDrawerOpen}
        onOpen={pageNav.handleDrawerOpen}
        onClose={pageNav.handleDrawerClose}
        drawerType="front"
        drawerStyle={{
          width: '100%',
          backgroundColor: 'transparent',
        }}
        overlayStyle={{
          backgroundColor: colorScheme === 'dark' ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.2)',
        }}
        swipeEnabled={true}
        swipeEdgeWidth={80}
        swipeMinDistance={30}
        swipeMinVelocity={300}
        renderDrawerContent={() => (
          <MenuPage
            sections={menu.sections}
            profile={menu.profile}
            activeTab={menu.activeTab}
            onNewChat={handleNewChat}
            onNewWorker={() => {
              log.log('🤖 New Worker clicked');
              pageNav.closeDrawer();
            }}
            onNewTrigger={() => {
              log.log('⚡ New Trigger clicked');
              pageNav.closeDrawer();
            }}
            selectedAgentId={agentManager.selectedAgent?.agent_id}
            onConversationPress={handleConversationPress}
            onAgentPress={handleAgentPress}
            onProfilePress={handleProfilePress}
            onChatsPress={menu.handleChatsTabPress}
            onWorkersPress={menu.handleWorkersTabPress}
            onTriggersPress={menu.handleTriggersTabPress}
            onClose={pageNav.closeDrawer}
            workerConfigWorkerId={menuWorkerConfigWorkerId}
            workerConfigInitialView={menuWorkerConfigInitialView}
            onCloseWorkerConfigDrawer={handleCloseMenuWorkerConfig}
          />
        )}>
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
                  onMenuPress={pageNav.openDrawer}
                  chat={chat}
                  isAuthenticated={canSendMessages}
                  onOpenWorkerConfig={handleOpenWorkerConfigFromAgentDrawer}
                />
              ) : (
                <View className="flex-1">
                  <HomePage
                    ref={homePageRef}
                    onMenuPress={pageNav.openDrawer}
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
      </Drawer>
      {isFeedbackDrawerOpen && <FeedbackDrawer />}
    </>
  );
}
