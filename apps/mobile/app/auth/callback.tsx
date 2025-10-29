import { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/api/supabase';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/ui';

/**
 * OAuth Callback Handler
 * 
 * Handles the OAuth redirect after authentication with Google/Apple
 * Exchanges the auth code for a session and redirects to the app
 */
export default function AuthCallback() {
  const router = useRouter();
  const params = useLocalSearchParams();

  useEffect(() => {
    const handleCallback = async () => {
      try {
        console.log('🔐 OAuth callback received');
        console.log('📊 Params:', params);

        // Extract code from URL params
        const code = params.code as string;

        if (code) {
          console.log('✅ Auth code found, exchanging for session');
          
          // Exchange code for session
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);

          if (error) {
            console.error('❌ Session exchange error:', error);
            router.replace('/');
            return;
          }

          console.log('✅ Session established:', data.session?.user?.email);
          
          // Redirect to home
          router.replace('/');
        } else {
          console.error('❌ No auth code found in callback');
          router.replace('/');
        }
      } catch (error) {
        console.error('❌ Callback error:', error);
        router.replace('/');
      }
    };

    handleCallback();
  }, [params]);

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <KortixLoader size="large" />
      <Text className="text-foreground font-roobert-medium mt-4">
        Completing sign in...
      </Text>
    </View>
  );
}

