import * as React from 'react';
import { Platform, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ThreadPage } from '@/components/pages';
import { useChat } from '@/hooks';
import { useAuthContext } from '@/contexts';
import { log } from '@/lib/logger';
import { getBackgroundColor } from '@agentpress/shared';
import { useColorScheme } from 'nativewind';

export default function ThreadScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAuthenticated } = useAuthContext();
  const chat = useChat();
  const { colorScheme } = useColorScheme();

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
      <View className="flex-1" style={{ backgroundColor: getBackgroundColor(Platform.OS, colorScheme) }}>
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
