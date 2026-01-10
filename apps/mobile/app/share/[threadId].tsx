import * as React from 'react';
import { View, ScrollView, Text as RNText, Pressable, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, MessageCircle } from 'lucide-react-native';

import { API_URL } from '@/api/config';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { ThreadContent } from '@/components/chat/ThreadContent';
import { useAuthContext } from '@/contexts';

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

export default function ShareThreadPage() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuthContext();

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

  // Handle "Continue in App" - navigate to home and open thread
  const handleContinueInApp = React.useCallback(() => {
    if (isAuthenticated) {
      // User is logged in - go to home with threadId param
      router.replace({
        pathname: '/home',
        params: { threadId },
      });
    } else {
      // User not logged in - go to auth first
      router.push('/auth');
    }
  }, [isAuthenticated, router, threadId]);

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
          className="flex-row items-center justify-between px-4 border-b border-border bg-background"
          style={{ paddingTop: insets.top + 8, paddingBottom: 12 }}
        >
          <Pressable
            onPress={handleBack}
            className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
          >
            <Icon as={ArrowLeft} size={22} className="text-foreground" />
          </Pressable>

          <View className="flex-1 mx-4 items-center">
            <KortixLogo size={14} variant="logomark" color={isDark ? 'dark' : 'light'} />
            <Text
              className="font-roobert-medium text-sm text-foreground mt-1"
              numberOfLines={1}
            >
              {threadTitle}
            </Text>
          </View>

          <View className="w-10" />
        </View>

        {/* Shared badge */}
        <View className="px-4 py-2 bg-muted/30 border-b border-border">
          <View className="flex-row items-center justify-center gap-2">
            <Icon as={ExternalLink} size={14} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground font-roobert-medium">
              Shared conversation • Read only
            </Text>
          </View>
        </View>

        {/* Messages */}
        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: insets.bottom + 100,
          }}
          showsVerticalScrollIndicator={true}
        >
          {messages.length > 0 ? (
            <ThreadContent
              messages={messages}
              agentStatus="idle"
              streamHookStatus="idle"
              sandboxId={thread?.project?.sandbox?.id}
              sandboxUrl={thread?.project?.sandbox?.sandbox_url}
            />
          ) : (
            <View className="flex-1 items-center justify-center py-20">
              <Text className="text-muted-foreground">No messages in this thread</Text>
            </View>
          )}
        </ScrollView>

        {/* Bottom CTA */}
        <View
          className="absolute bottom-0 left-0 right-0 px-4 py-4 bg-background border-t border-border"
          style={{ paddingBottom: insets.bottom + 16 }}
        >
          <Pressable
            onPress={handleContinueInApp}
            className="w-full py-4 rounded-2xl bg-primary items-center active:opacity-80"
          >
            <Text className="font-roobert-semibold text-base text-primary-foreground">
              {isAuthenticated ? 'Continue in App' : 'Sign in to Continue'}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}
