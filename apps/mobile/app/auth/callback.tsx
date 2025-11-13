import { useEffect } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/ui';

export default function AuthCallback() {
  useEffect(() => {
    console.log('🔐 Auth callback screen loaded - deep link handled by root layout');
  }, []);

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <KortixLoader size="large" />
      <Text className="text-foreground font-roobert-medium mt-4">
        Completing sign in...
      </Text>
    </View>
  );
}
