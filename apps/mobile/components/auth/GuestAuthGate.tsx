import * as React from 'react';
import { View, TouchableOpacity, Modal, Platform } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, Lock, UserPlus, LogIn } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { BlurView } from 'expo-blur';
import Animated, { FadeIn, SlideInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useGuestMode } from '@/contexts';

const AnimatedView = Animated.createAnimatedComponent(View);

interface GuestAuthGateProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
  feature?: string;
}

export function GuestAuthGate({ 
  visible, 
  onClose, 
  title = "Sign up to continue",
  message = "Create a free account to use this feature",
  feature = "this feature"
}: GuestAuthGateProps) {
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const { exitGuestMode } = useGuestMode();
  const isDark = colorScheme === 'dark';

  const handleSignUp = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await exitGuestMode();
    onClose();
    router.push('/auth');
  };

  const handleClose = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View className="flex-1">
        {Platform.OS === 'ios' ? (
          <BlurView
            intensity={30}
            tint={isDark ? 'dark' : 'light'}
            className="flex-1"
          >
            <TouchableOpacity 
              activeOpacity={1} 
              onPress={handleClose}
              className="flex-1 justify-center items-center p-6"
            >
              <AnimatedView 
                entering={SlideInDown.springify().damping(20)}
                className="w-full max-w-md"
              >
                <TouchableOpacity activeOpacity={1} className="bg-background rounded-3xl p-6 border border-border">
                  <View className="flex-row justify-between items-center mb-4">
                    <View className="w-12 h-12 rounded-full bg-primary/10 items-center justify-center">
                      <Icon as={Lock} size={24} className="text-primary" />
                    </View>
                    <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Icon as={X} size={24} className="text-muted-foreground" />
                    </TouchableOpacity>
                  </View>

                  <Text className="text-2xl font-roobert-semibold text-foreground mb-2">
                    {title}
                  </Text>
                  <Text className="text-base font-roobert text-muted-foreground mb-6">
                    {message}. Chat with Kortix, save conversations, and unlock all features.
                  </Text>

                  <View className="gap-3">
                    <TouchableOpacity
                      onPress={handleSignUp}
                      style={{
                        backgroundColor: isDark ? '#FFFFFF' : '#000000',
                        height: 52,
                        borderRadius: 26,
                        justifyContent: 'center',
                        alignItems: 'center',
                        flexDirection: 'row',
                        gap: 8,
                      }}
                    >
                      <Icon as={UserPlus} size={20} color={isDark ? '#000000' : '#FFFFFF'} />
                      <Text style={{
                        color: isDark ? '#000000' : '#FFFFFF',
                        fontSize: 16,
                        fontFamily: 'Roobert-Medium',
                      }}>
                        Create Free Account
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={handleSignUp}
                      style={{
                        backgroundColor: 'transparent',
                        height: 52,
                        borderRadius: 26,
                        borderWidth: 1,
                        borderColor: isDark ? '#454444' : '#c2c2c2',
                        justifyContent: 'center',
                        alignItems: 'center',
                        flexDirection: 'row',
                        gap: 8,
                      }}
                    >
                      <Icon as={LogIn} size={20} className="text-foreground" />
                      <Text className="text-foreground text-base font-roobert-medium">
                        Sign In
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity onPress={handleClose} className="mt-4 py-2">
                    <Text className="text-center text-sm font-roobert text-muted-foreground">
                      Continue browsing
                    </Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              </AnimatedView>
            </TouchableOpacity>
          </BlurView>
        ) : (
          <View className="flex-1 bg-background/80">
            <TouchableOpacity 
              activeOpacity={1} 
              onPress={handleClose}
              className="flex-1 justify-center items-center p-6"
            >
              <AnimatedView 
                entering={SlideInDown.springify().damping(20)}
                className="w-full max-w-md bg-background rounded-3xl p-6 border border-border"
              >
                <View className="flex-row justify-between items-center mb-4">
                  <View className="w-12 h-12 rounded-full bg-primary/10 items-center justify-center">
                    <Icon as={Lock} size={24} className="text-primary" />
                  </View>
                  <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Icon as={X} size={24} className="text-muted-foreground" />
                  </TouchableOpacity>
                </View>

                <Text className="text-2xl font-roobert-semibold text-foreground mb-2">
                  {title}
                </Text>
                <Text className="text-base font-roobert text-muted-foreground mb-6">
                  {message}. Chat with Kortix, save conversations, and unlock all features.
                </Text>

                <View className="gap-3">
                  <TouchableOpacity
                    onPress={handleSignUp}
                    style={{
                      backgroundColor: isDark ? '#FFFFFF' : '#000000',
                      height: 52,
                      borderRadius: 26,
                      justifyContent: 'center',
                      alignItems: 'center',
                      flexDirection: 'row',
                      gap: 8,
                    }}
                  >
                    <Icon as={UserPlus} size={20} color={isDark ? '#000000' : '#FFFFFF'} />
                    <Text style={{
                      color: isDark ? '#000000' : '#FFFFFF',
                      fontSize: 16,
                      fontFamily: 'Roobert-Medium',
                    }}>
                      Create Free Account
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={handleSignUp}
                    style={{
                      backgroundColor: 'transparent',
                      height: 52,
                      borderRadius: 26,
                      borderWidth: 1,
                      borderColor: isDark ? '#454444' : '#c2c2c2',
                      justifyContent: 'center',
                      alignItems: 'center',
                      flexDirection: 'row',
                      gap: 8,
                    }}
                  >
                    <Icon as={LogIn} size={20} className="text-foreground" />
                    <Text className="text-foreground text-base font-roobert-medium">
                      Sign In
                    </Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity onPress={handleClose} className="mt-4 py-2">
                  <Text className="text-center text-sm font-roobert text-muted-foreground">
                    Continue browsing
                  </Text>
                </TouchableOpacity>
              </AnimatedView>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

