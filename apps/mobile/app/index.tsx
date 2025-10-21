import { MenuPage, HomePage, ThreadPage } from '@/components/pages';
import type { HomePageRef } from '@/components/pages/HomePage';
import { useSideMenu, usePageNavigation, useChat, useAgentManager } from '@/hooks';
import { useAuthContext } from '@/contexts';
import { AuthDrawer } from '@/components/auth';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { StatusBar as RNStatusBar } from 'react-native';
import { Drawer } from 'react-native-drawer-layout';
import type { Agent } from '@/api/types';
import type { Conversation } from '@/components/menu/types';

/**
 * Main App Screen with Drawer Navigation
 * 
 * No auth protection - users can access app directly
 * Auth drawer shows when needed for user-specific features
 * 
 * Architecture:
 * - Drawer (left side): MenuPage (conversations, profile, navigation)
 * - Main Content: HomePage (default - chat interface)
 * - Auth Drawer (bottom): Shows when user tries to access protected features
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
  const chat = useChat(); // SINGLE UNIFIED HOOK
  const pageNav = usePageNavigation();
  const authDrawerRef = React.useRef<BottomSheetModal>(null);
  const homePageRef = React.useRef<HomePageRef>(null);
  const [isAuthDrawerOpen, setIsAuthDrawerOpen] = React.useState(false);
  
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

  // Handle profile press - show auth drawer if not authenticated
  const handleProfilePress = React.useCallback(() => {
    console.log('🎯 Profile pressed');
    if (!isAuthenticated) {
      console.log('🔐 User not authenticated, showing auth drawer');
      // Use present() to open at the defined snap point (85%)
      authDrawerRef.current?.present();
      setIsAuthDrawerOpen(true);
    } else {
      menu.handleProfilePress();
    }
  }, [isAuthenticated, menu]);

  // Handle auth drawer close
  const handleAuthDrawerClose = React.useCallback(() => {
    console.log('🔐 Auth drawer closed');
    authDrawerRef.current?.dismiss();
    setIsAuthDrawerOpen(false);
  }, []);

  // Handle auth drawer open - used when user tries protected actions
  const handleAuthDrawerOpen = React.useCallback(() => {
    console.log('🔐 Opening auth drawer');
    authDrawerRef.current?.present();
    setIsAuthDrawerOpen(true);
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
            onOpenAuthDrawer={handleAuthDrawerOpen}
          />
        ) : (
          <HomePage
            ref={homePageRef}
            onMenuPress={pageNav.openDrawer}
            chat={chat}
            isAuthenticated={isAuthenticated}
            onOpenAuthDrawer={handleAuthDrawerOpen}
          />
        )}
      </Drawer>

      {/* Auth Drawer - Shows when user needs to sign in */}
      <AuthDrawer
        ref={authDrawerRef}
        isOpen={isAuthDrawerOpen}
        onClose={handleAuthDrawerClose}
      />
    </>
  );
}
