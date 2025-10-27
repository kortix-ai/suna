import { MenuPage, HomePage, ThreadPage } from '@/components/pages';
import type { HomePageRef } from '@/components/pages/HomePage';
import { useSideMenu, usePageNavigation, useChat, useAgentManager } from '@/hooks';
import { useAuthContext } from '@/contexts';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { StatusBar as RNStatusBar } from 'react-native';
import { Drawer } from 'react-native-drawer-layout';
import type { Agent } from '@/api/types';
import type { Conversation } from '@/components/menu/types';

/**
 * Main App Screen with Drawer Navigation
 * 
 * Protected by root layout AuthProtection - requires authentication
 * 
 * Architecture:
 * - Drawer (left side): MenuPage (conversations, profile, navigation)
 * - Main Content: HomePage (default - chat interface)
 * 
 * Swipe Gestures:
 * - Swipe right from edge → Opens drawer (Menu)
 * - Swipe left on drawer → Closes drawer (returns to Home)
 * - Tap outside drawer → Closes drawer
 * 
 * The drawer is full-page and supports native swipe gestures
 */
export default function AppScreen() {
  const { colorScheme } = useColorScheme();
  const { isAuthenticated } = useAuthContext();
  const router = useRouter();
  const chat = useChat(); // SINGLE UNIFIED HOOK
  const pageNav = usePageNavigation();
  const homePageRef = React.useRef<HomePageRef>(null);
  
  // Handle new chat - starts new chat and closes drawer
  const handleNewChat = React.useCallback(() => {
    console.log('🆕 New Chat clicked - Starting new chat');
    chat.startNewChat();
    pageNav.closeDrawer();
    
    // Focus chat input after drawer closes
    setTimeout(() => {
      console.log('🎯 Focusing chat input after new chat');
      homePageRef.current?.focusChatInput();
    }, 300); // Small delay to ensure drawer is closed
  }, [chat, pageNav]);
  
  // Handle agent selection - starts chat with specific agent
  const handleAgentPress = React.useCallback((agent: Agent) => {
    console.log('🤖 Agent selected:', agent.name);
    console.log('📊 Starting chat with:', agent);
    // TODO: Set the selected agent in chat thread
    chat.startNewChat();
    pageNav.closeDrawer();
  }, [chat, pageNav]);
  
  const menu = useSideMenu({ onNewChat: handleNewChat });
  const agentManager = useAgentManager();

  // Handle conversation click - load thread
  const handleConversationPress = React.useCallback((conversation: Conversation) => {
    console.log('📖 Loading thread:', conversation.id);
    
    // Load the thread
    chat.loadThread(conversation.id);
    
    // Close drawer
    pageNav.closeDrawer();
  }, [chat, pageNav]);

  const handleProfilePress = React.useCallback(() => {
    console.log('🎯 Profile pressed');
    if (!isAuthenticated) {
      console.log('🔐 User not authenticated, navigating to auth');
      router.push('/auth');
    } else {
      menu.handleProfilePress();
    }
  }, [isAuthenticated, menu, router]);

  // Handle auth screen open - used when user tries protected actions
  const handleOpenAuthScreen = React.useCallback(() => {
    console.log('🔐 Opening auth screen');
    router.push('/auth');
  }, [router]);

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
        {/* Main Content: Conditionally render HomePage or ThreadPage */}
        {chat.hasActiveThread ? (
          <ThreadPage
            onMenuPress={pageNav.openDrawer}
            chat={chat}
            isAuthenticated={isAuthenticated}
            onOpenAuthDrawer={handleOpenAuthScreen}
          />
        ) : (
          <HomePage
            ref={homePageRef}
            onMenuPress={pageNav.openDrawer}
            chat={chat}
            isAuthenticated={isAuthenticated}
            onOpenAuthDrawer={handleOpenAuthScreen}
          />
        )}
      </Drawer>
    </>
  );
}
