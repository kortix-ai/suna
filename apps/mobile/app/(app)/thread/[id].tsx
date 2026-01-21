import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ThreadPage } from '@/components/pages';
import { useChat, useAgentManager } from '@/hooks';
import { useAuthContext } from '@/contexts';
import { log } from '@/lib/logger';

export default function ThreadScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAuthenticated } = useAuthContext();
  const chat = useChat();
  const agentManager = useAgentManager();

  React.useEffect(() => {
    if (id && id !== chat.activeThread?.id) {
      log.log('🎯 Loading thread from route:', id);
      chat.loadThread(id);
    }
  }, [id]);

  const handleBackPress = React.useCallback(() => {
    log.log('⬅️ Navigating back to home');
    router.back();
  }, [router]);

  const handleNewChat = React.useCallback(() => {
    log.log('🆕 Starting new chat');
    chat.startNewChat();
    router.back();
  }, [router, chat]);

  const handleWorkerConfig = React.useCallback(
    (
      workerId: string,
      view?: 'instructions' | 'tools' | 'integrations' | 'triggers'
    ) => {
      router.push({
        pathname: '/worker-config',
        params: { workerId, initialView: view },
      });
    },
    [router]
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background">
        <ThreadPage
          onMenuPress={handleBackPress}
          onNewChat={handleNewChat}
          chat={chat}
          isAuthenticated={isAuthenticated}
          onOpenWorkerConfig={handleWorkerConfig}
        />
      </View>
    </>
  );
}
