import * as React from 'react';
import { Pressable, View, Image, Alert, ScrollView, Switch } from 'react-native';
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
  Moon,
  Sun,
  Globe,
  LogOut,
  ChevronRight,
  Zap,
  Layers
} from 'lucide-react-native';
import type { UserProfile } from './types';
import { LanguageDrawer } from './LanguageDrawer';
import { NameEditDrawer } from './NameEditDrawer';
import { ThemeDrawer } from './ThemeDrawer';
import { useAdvancedFeatures } from '@/hooks';
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
  const [isNameEditDrawerVisible, setIsNameEditDrawerVisible] = React.useState(false);
  const [isThemeDrawerVisible, setIsThemeDrawerVisible] = React.useState(false);
  const { isEnabled: advancedFeaturesEnabled, toggle: toggleAdvancedFeatures } = useAdvancedFeatures();
  
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
    setIsNameEditDrawerVisible(true);
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
    
    Alert.alert(
      t('settings.integrations') || 'Integrations',
      'Integration management is coming soon! Connect your favorite apps to automate workflows.',
      [{ text: t('common.ok') || 'OK' }]
    );
  };
  
  const handleTheme = () => {
    console.log('🎯 Theme pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsThemeDrawerVisible(true);
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
  
  const handleAdvancedFeaturesToggle = React.useCallback(async () => {
    console.log('🎯 Advanced features toggle pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await toggleAdvancedFeatures();
  }, [toggleAdvancedFeatures]);
  
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
              icon={colorScheme === 'dark' ? Sun : Moon}
              label={t('settings.themeTitle') || 'Theme'}
              onPress={handleTheme}
            />
            
            <SettingsItem
              icon={Globe}
              label={t('settings.language')}
              onPress={handleLanguage}
            />
            
            {/* Divider before advanced features */}
            <View className="h-px bg-border my-4" />
            
            {/* Advanced Features Toggle */}
            <SettingsToggleItem
              icon={Layers}
              label={t('settings.advancedFeatures') || 'Advanced Features'}
              value={advancedFeaturesEnabled}
              onToggle={handleAdvancedFeaturesToggle}
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
      
      {/* Name Edit Drawer */}
      <NameEditDrawer
        visible={isNameEditDrawerVisible}
        currentName={userName}
        onClose={() => setIsNameEditDrawerVisible(false)}
        onNameUpdated={(newName) => {
          console.log('✅ Name updated to:', newName);
          // User data will be refreshed by the drawer
        }}
      />
      
      {/* Theme Drawer */}
      <ThemeDrawer
        visible={isThemeDrawerVisible}
        onClose={() => setIsThemeDrawerVisible(false)}
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

/**
 * SettingsToggleItem Component
 * 
 * Settings item with a toggle switch instead of navigation.
 */
interface SettingsToggleItemProps {
  icon: typeof User;
  label: string;
  value: boolean;
  onToggle: () => void;
}

function SettingsToggleItem({ icon, label, value, onToggle }: SettingsToggleItemProps) {
  const { colorScheme } = useColorScheme();
  
  return (
    <View className="flex-row items-center justify-between py-4">
      <View className="flex-row items-center gap-3">
        <Icon as={icon} size={20} className="text-foreground/60" strokeWidth={2} />
        <Text className="text-base font-roobert text-foreground">
          {label}
        </Text>
      </View>
      
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ 
          false: colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7',
          true: colorScheme === 'dark' ? '#34C759' : '#34C759' 
        }}
        thumbColor={colorScheme === 'dark' ? '#FFFFFF' : '#FFFFFF'}
        ios_backgroundColor={colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7'}
      />
    </View>
  );
}

