import * as React from 'react';
import { Pressable, View, Image, Alert, ScrollView } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  X, 
  User,
  CreditCard,
  Plug,
  Palette,
  Globe,
  LogOut,
  ChevronRight,
  Zap
} from 'lucide-react-native';
import type { UserProfile } from './types';
import { LanguageDrawer } from './LanguageDrawer';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

interface SettingsDrawerProps {
  visible: boolean;
  profile?: UserProfile;
  onClose: () => void;
}

/**
 * SettingsDrawer Component
 * 
 * Clean, elegant settings drawer with minimal design.
 * 
 * Design Specifications:
 * - Full screen with simple backdrop
 * - Clean header with X button and "Settings" title
 * - Profile name display
 * - Upgrade section for non-pro users
 * - Minimal menu items with icons
 * - Simple, no-animation slide in
 * 
 * Menu Items:
 * - Name (profile management)
 * - Billing
 * - Integrations
 * - Theme & App Icon
 * - App Language
 * - Sign Out
 */
export function SettingsDrawer({ visible, profile, onClose }: SettingsDrawerProps) {
  const { colorScheme } = useColorScheme();
  const { user, signOut } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();
  const [isLanguageDrawerVisible, setIsLanguageDrawerVisible] = React.useState(false);
  
  // Get user data
  const userName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || profile?.name || 'Guest';
  const userEmail = user?.email || profile?.email || '';
  const userAvatar = user?.user_metadata?.avatar_url || profile?.avatar;
  const userTier = profile?.tier;
  const isGuest = !user;
  
  const handleClose = () => {
    console.log('🎯 Settings drawer closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };
  
  const handleName = () => {
    console.log('🎯 Name/Profile management pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // TODO: Navigate to profile management
  };
  
  const handleBilling = () => {
    console.log('🎯 Billing pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
    router.push('/billing');
  };
  
  const handleIntegrations = () => {
    console.log('🎯 Integrations pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // TODO: Navigate to integrations
  };
  
  const handleTheme = () => {
    console.log('🎯 Theme & App Icon pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // TODO: Open theme selector
  };
  
  const handleLanguage = () => {
    console.log('🎯 App Language pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsLanguageDrawerVisible(true);
  };
  
  const handleSignOut = async () => {
    console.log('🎯 Sign Out pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    Alert.alert(
      t('settings.signOut'),
      t('auth.signOutConfirm'),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => console.log('❌ Sign out cancelled'),
        },
        {
          text: t('settings.signOut'),
          style: 'destructive',
          onPress: async () => {
            console.log('🔐 Signing out...');
            const result = await signOut();
            if (result.success) {
              console.log('✅ Signed out successfully - Redirecting to auth');
              onClose();
              // Navigate to splash screen which will redirect to auth
              router.replace('/');
            } else {
              console.error('❌ Sign out failed:', result.error);
              Alert.alert(t('common.error'), 'Failed to sign out. Please try again.');
            }
          },
        },
      ],
      { cancelable: true }
    );
  };
  
  if (!visible) return null;
  
  return (
    <View className="absolute inset-0 z-50">
      {/* Simple Backdrop */}
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      {/* Drawer */}
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          {/* Header */}
          <View className="px-6 pt-16 pb-6 flex-row items-center justify-between">
            <Pressable
              onPress={handleClose}
              className="w-10 h-10 items-center justify-center"
              hitSlop={8}
            >
              <Icon as={X} size={24} className="text-foreground" strokeWidth={2} />
            </Pressable>
            
            <Text className="text-xl font-roobert-semibold text-foreground">
              {t('settings.title')}
            </Text>
            
            <View className="w-10" />
          </View>
          
          {/* Profile Name Display */}
          <View className="px-6 pb-6">
            <Text className="text-2xl font-roobert-semibold text-foreground">
              {userName}
            </Text>
            {userEmail && (
              <Text className="text-sm font-roobert text-muted-foreground mt-1">
                {userEmail}
              </Text>
            )}
          </View>
          
          {/* Settings List */}
          <View className="px-6">
            <SettingsItem
              icon={User}
              label={t('settings.name')}
              onPress={handleName}
            />
            
            <SettingsItem
              icon={CreditCard}
              label={t('settings.billing')}
              onPress={handleBilling}
            />
            
            <SettingsItem
              icon={Plug}
              label={t('settings.integrations')}
              onPress={handleIntegrations}
            />
            
            <SettingsItem
              icon={Palette}
              label={t('settings.theme')}
              onPress={handleTheme}
            />
            
            <SettingsItem
              icon={Globe}
              label={t('settings.language')}
              onPress={handleLanguage}
            />
            
            {/* Divider before sign out */}
            {!isGuest && (
              <View className="h-px bg-border my-4" />
            )}
            
            {/* Sign Out */}
            {!isGuest && (
              <SettingsItem
                icon={LogOut}
                label={t('settings.signOut')}
                onPress={handleSignOut}
                destructive
              />
            )}
          </View>
          
          <View className="h-20" />
        </ScrollView>
      </View>
      
      {/* Language Drawer */}
      <LanguageDrawer 
        visible={isLanguageDrawerVisible} 
        onClose={() => setIsLanguageDrawerVisible(false)} 
      />
    </View>
  );
}

/**
 * SettingsItem Component
 * 
 * Clean settings list item with icon, label, and chevron.
 */
interface SettingsItemProps {
  icon: typeof User;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

function SettingsItem({ icon, label, onPress, destructive = false }: SettingsItemProps) {
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };
  
  const iconColor = destructive ? 'text-destructive' : 'text-foreground/60';
  const textColor = destructive ? 'text-destructive' : 'text-foreground';
  
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="flex-row items-center justify-between py-4"
    >
      <View className="flex-row items-center gap-3">
        <Icon as={icon} size={20} className={iconColor} strokeWidth={2} />
        <Text className={`text-base font-roobert ${textColor}`}>
          {label}
        </Text>
      </View>
      
      {!destructive && (
        <Icon as={ChevronRight} size={16} className="text-foreground/40" strokeWidth={2} />
      )}
    </AnimatedPressable>
  );
}

