import * as React from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { MenuPage } from '@/components/pages';
import { useSideMenu, useChat, useAgentManager } from '@/hooks';
import { useAuthContext } from '@/contexts';
import type { Agent } from '@/api/types';
import type { Conversation } from '@/components/menu/types';
import { log } from '@/lib/logger';

export default function MenuScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuthContext();
  const chat = useChat();
  const agentManager = useAgentManager();
  
  const [menuWorkerConfigWorkerId, setMenuWorkerConfigWorkerId] = React.useState<string | null>(null);
  const [menuWorkerConfigInitialView, setMenuWorkerConfigInitialView] = React.useState<
    'instructions' | 'tools' | 'integrations' | 'triggers' | undefined
  >(undefined);

  const handleNewChat = React.useCallback(() => {
    log.log('🆕 New Chat clicked - Starting new chat');
    chat.startNewChat();
    router.back();
  }, [chat, router]);

  const handleAgentPress = React.useCallback(
    (agent: Agent) => {
      log.log('🤖 Agent selected:', agent.name);
      chat.startNewChat();
      router.back();
    },
    [chat, router]
  );

  const handleConversationPress = React.useCallback(
    (conversation: Conversation) => {
      log.log('📖 Navigating to thread:', conversation.id);
      router.push(`/thread/${conversation.id}`);
    },
    [router]
  );

  const handleProfilePress = React.useCallback(() => {
    log.log('🎯 Profile pressed');
    if (!isAuthenticated) {
      router.push('/auth');
    }
  }, [isAuthenticated, router]);

  const handleCloseMenuWorkerConfig = React.useCallback(() => {
    setMenuWorkerConfigWorkerId(null);
    setMenuWorkerConfigInitialView(undefined);
  }, []);

  const menu = useSideMenu({ onNewChat: handleNewChat });

  return (
    <>
      <Stack.Screen options={{ headerShown: false, animation: 'slide_from_left' }} />
      <View className="flex-1 bg-background">
        <MenuPage
          sections={menu.sections}
          profile={menu.profile}
          activeTab={menu.activeTab}
          onNewChat={handleNewChat}
          onNewWorker={() => {
            log.log('🤖 New Worker clicked');
            router.back();
          }}
          onNewTrigger={() => {
            log.log('⚡ New Trigger clicked');
            router.back();
          }}
          selectedAgentId={agentManager.selectedAgent?.agent_id}
          onConversationPress={handleConversationPress}
          onAgentPress={handleAgentPress}
          onProfilePress={handleProfilePress}
          onChatsPress={menu.handleChatsTabPress}
          onWorkersPress={menu.handleWorkersTabPress}
          onTriggersPress={menu.handleTriggersTabPress}
          onClose={() => router.back()}
          workerConfigWorkerId={menuWorkerConfigWorkerId}
          workerConfigInitialView={menuWorkerConfigInitialView}
          onCloseWorkerConfigDrawer={handleCloseMenuWorkerConfig}
        />
      </View>
    </>
  );
}
