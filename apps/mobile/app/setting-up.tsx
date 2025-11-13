import * as React from 'react';
import { View } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { CheckCircle2, AlertCircle } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import { useAuthContext } from '@/contexts';
import { useAccountInitialization } from '@/hooks/useAccountInitialization';
import { useBillingContext } from '@/contexts/BillingContext';
import { useColorScheme } from 'nativewind';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';
import * as Haptics from 'expo-haptics';

export default function SettingUpScreen() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthContext();
  const { colorScheme } = useColorScheme();
  const { refetchAll, hasActiveSubscription, subscriptionData } = useBillingContext();
  const [status, setStatus] = React.useState<'initializing' | 'success' | 'error'>('initializing');
  const [shouldNavigate, setShouldNavigate] = React.useState(false);
  const initializeMutation = useAccountInitialization();

  const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;

  React.useEffect(() => {
    if (!isAuthenticated) {
      console.log('⚠️  User not authenticated in setup screen, redirecting...');
      router.replace('/auth');
    }
  }, [isAuthenticated]);

  React.useEffect(() => {
    if (!user || initializeMutation.isPending || initializeMutation.isSuccess || initializeMutation.isError) {
      return;
    }

    console.log('🔧 Starting account initialization...');
    
    initializeMutation.mutate(undefined, {
      onSuccess: async (data) => {
        console.log('✅ Initialization successful:', data.message);
        setStatus('success');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        console.log('🔄 Refetching billing data...');
        refetchAll();
        setShouldNavigate(true);
      },
      onError: async (error) => {
        console.error('❌ Initialization failed:', error);
        setStatus('error');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      },
    });
  }, [user]);

  React.useEffect(() => {
    if (shouldNavigate && hasActiveSubscription && subscriptionData?.tier?.name === 'free') {
      console.log('✅ Billing data confirmed fresh - subscription exists!');
      console.log('🚀 Navigating to onboarding...');
      
      setTimeout(() => {
        router.replace('/onboarding');
      }, 500);
    }
  }, [shouldNavigate, hasActiveSubscription, subscriptionData]);

  const handleContinue = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.replace('/onboarding');
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-8">
          <View className="items-center w-full max-w-md">
            <View className="mb-12">
              <Logomark width={120} height={24} />
            </View>

            {status === 'initializing' && (
              <>
                <Text className="text-[32px] font-roobert-semibold text-foreground text-center mb-4 leading-tight tracking-tight">
                  Setting Up Your Account
                </Text>

                <Text className="text-[15px] font-roobert text-muted-foreground text-center mb-12 opacity-80">
                  We're creating your workspace and preparing everything you need to get started.
                </Text>

                <View className="w-full rounded-2xl border border-border p-6 bg-card">
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1">
                      <View className="flex-row items-center mb-2">
                        <View className="h-2.5 w-2.5 bg-blue-500 rounded-full mr-2" 
                          style={{ opacity: 1 }} 
                        />
                        <Text className="text-base font-roobert-medium text-blue-400">
                          Initializing
                        </Text>
                      </View>
                      <Text className="text-base font-roobert text-muted-foreground">
                        Setting up your account...
                      </Text>
                    </View>
                    <View className="h-12 w-12 items-center justify-center ml-4">
                      <KortixLoader size="small" customSize={24} />
                    </View>
                  </View>
                </View>
              </>
            )}

            {status === 'success' && (
              <>
                <Text className="text-[32px] font-roobert-semibold text-foreground text-center mb-4 leading-tight tracking-tight">
                  You're All Set!
                </Text>

                <Text className="text-[15px] font-roobert text-muted-foreground text-center mb-12 opacity-80">
                  Your account is ready. Taking you to onboarding...
                </Text>

                <View className="w-full rounded-2xl border border-border p-6 bg-card">
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1">
                      <View className="flex-row items-center mb-2">
                        <View className="h-2.5 w-2.5 bg-green-500 rounded-full mr-2" />
                        <Text className="text-base font-roobert-medium text-green-400">
                          Ready
                        </Text>
                      </View>
                      <Text className="text-base font-roobert text-muted-foreground">
                        Welcome to your workspace!
                      </Text>
                    </View>
                    <View className="h-12 w-12 items-center justify-center ml-4">
                      <Icon as={CheckCircle2} size={24} className="text-green-500" />
                    </View>
                  </View>
                </View>
              </>
            )}

            {status === 'error' && (
              <>
                <Text className="text-[32px] font-roobert-semibold text-foreground text-center mb-4 leading-tight tracking-tight">
                  Setup Issue
                </Text>

                <Text className="text-[15px] font-roobert text-muted-foreground text-center mb-12 opacity-80">
                  An error occurred during setup. You can still continue - we'll try again later.
                </Text>

                <View className="w-full rounded-2xl border border-border p-6 bg-card">
                  <View className="flex-row items-center justify-between mb-4">
                    <View className="flex-1">
                      <View className="flex-row items-center mb-2">
                        <View className="h-2.5 w-2.5 bg-red-500 rounded-full mr-2" />
                        <Text className="text-base font-roobert-medium text-red-400">
                          Setup Error
                        </Text>
                      </View>
                      <Text className="text-base font-roobert text-muted-foreground">
                        Don't worry, you can try again later.
                      </Text>
                    </View>
                    <View className="h-12 w-12 items-center justify-center ml-4">
                      <Icon as={AlertCircle} size={24} className="text-red-500" />
                    </View>
                  </View>
                  
                  <View 
                    onTouchEnd={handleContinue}
                    className="bg-foreground h-12 rounded-xl items-center justify-center active:opacity-80"
                  >
                    <Text className="text-[15px] font-roobert-medium text-background">
                      Continue to Onboarding
                    </Text>
                  </View>
                </View>
              </>
            )}
          </View>
        </View>
      </View>
    </>
  );
}

