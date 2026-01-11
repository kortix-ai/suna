import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { KortixLoader } from '@/components/ui';
import { log } from '@/lib/logger';

export default function NotFoundScreen() {
  const router = useRouter();

  useEffect(() => {
    // Redirect to splash screen - it will handle routing decisions
    const redirectTimer = setTimeout(() => {
      log.log('📍 Not found screen - redirecting to splash');
      router.replace('/');
    }, 500);

    return () => clearTimeout(redirectTimer);
  }, [router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 items-center justify-center bg-background">
        <KortixLoader size="xlarge" />
      </View>
    </>
  );
}
