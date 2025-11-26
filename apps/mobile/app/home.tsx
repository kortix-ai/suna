import { MenuPage, HomePage, ThreadPage } from '@/components/pages';
import type { HomePageRef } from '@/components/pages/HomePage';
import { useSideMenu, usePageNavigation, useChat, useAgentManager } from '@/hooks';
import { useAuthContext } from '@/contexts';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { StatusBar as RNStatusBar, View } from 'react-native';
import { Drawer } from 'react-native-drawer-layout';
import { useQueryClient } from '@tanstack/react-query';
import type { Agent } from '@/api/types';
import type { Conversation } from '@/components/menu/types';
import { FeedbackDrawer } from '@/components/chat/tool-views/complete-tool/FeedbackDrawer';

export default function AppScreen() {
  const { colorScheme } = useColorScheme();
  const { isAuthenticated } = useAuthContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { threadId } = useLocalSearchParams<{ threadId?: string }>();
  const chat = useChat();
  const pageNav = usePageNavigation();
  const homePageRef = React.useRef<HomePageRef>(null);
  
  const canSendMessages = isAuthenticated;
  
  React.useEffect(() => {
    if (threadId && threadId !== chat.activeThread?.id) {
      console.log('🎯 Loading thread from URL parameter:', threadId);
      chat.loadThread(threadId);
    }
  }, [threadId, chat]);
  
  const handleNewChat = React.useCallback(() => {
    console.log('🆕 New Chat clicked - Starting new chat');
    chat.startNewChat();
    pageNav.closeDrawer();
    
    setTimeout(() => {
      console.log('🎯 Focusing chat input after new chat');
      homePageRef.current?.focusChatInput();
    }, 300);
  }, [chat, pageNav]);
  
  const handleAgentPress = React.useCallback((agent: Agent) => {
    console.log('🤖 Agent selected:', agent.name);
    console.log('📊 Starting chat with:', agent);
    chat.startNewChat();
    pageNav.closeDrawer();
  }, [chat, pageNav]);
  
  const menu = useSideMenu({ onNewChat: handleNewChat });
  const agentManager = useAgentManager();

  const handleConversationPress = React.useCallback((conversation: Conversation) => {
    console.log('📖 Loading thread:', conversation.id);
    chat.loadThread(conversation.id);
    pageNav.closeDrawer();
  }, [chat, pageNav]);

  const handleProfilePress = React.useCallback(() => {
    console.log('🎯 Profile pressed');
    if (!isAuthenticated) {
      console.log('🔐 User not authenticated, redirecting to auth');
      router.push('/auth');
    } else {
      menu.handleProfilePress();
    }
  }, [isAuthenticated, menu, router]);

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
            backgroundColor: colorScheme === 'dark' ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.2)'
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
                console.log('🤖 New Worker clicked');
                pageNav.closeDrawer();
              }}
              onNewTrigger={() => {
                console.log('⚡ New Trigger clicked');
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
            />
          )}
        >
          {chat.hasActiveThread ? (
            <ThreadPage
              onMenuPress={pageNav.openDrawer}
              chat={chat}
              isAuthenticated={canSendMessages}
            />
          ) : (
            <HomePage
              ref={homePageRef}
              onMenuPress={pageNav.openDrawer}
              chat={chat}
              isAuthenticated={canSendMessages}
            />
          )}
      </Drawer>
      <FeedbackDrawer />
    </>
  );
}
