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
  ArrowLeft,
  User,
  CreditCard,
  Plug,
  Moon,
  Sun,
  Globe,
  LogOut,
  ChevronRight,
  Zap,
  FlaskConical
} from 'lucide-react-native';
import type { UserProfile } from '../menu/types';
import { LanguagePage } from './LanguagePage';
import { NameEditPage } from './NameEditPage';
import { ThemePage } from './ThemePage';
import { BetaPage } from './BetaPage';
import { BillingPage } from './BillingPage';
import { CreditsPurchasePage } from './CreditsPurchasePage';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

interface SettingsPageProps {
  visible: boolean;
  profile?: UserProfile;
  onClose: () => void;
}

/**
 * SettingsPage Component
 * 
 * Clean, elegant settings page with minimal design.
 * 
 * Design Specifications:
 * - Full screen with simple backdrop
 * - Clean header with back button and "Settings" title
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
export function SettingsPage({ visible, profile, onClose }: SettingsPageProps) {
  const { colorScheme } = useColorScheme();
  const { user, signOut } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();
  const [isLanguagePageVisible, setIsLanguagePageVisible] = React.useState(false);
  const [isNameEditPageVisible, setIsNameEditPageVisible] = React.useState(false);
  const [isThemePageVisible, setIsThemePageVisible] = React.useState(false);
  const [isBetaPageVisible, setIsBetaPageVisible] = React.useState(false);
  const [isBillingPageVisible, setIsBillingPageVisible] = React.useState(false);
  const [isCreditsPurchasePageVisible, setIsCreditsPurchasePageVisible] = React.useState(false);
  
  // Get user data
  const userName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || profile?.name || 'Guest';
  const userEmail = user?.email || profile?.email || '';
  const userAvatar = user?.user_metadata?.avatar_url || profile?.avatar;
  const userTier = profile?.tier;
  const isGuest = !user;
  
  const handleClose = () => {
    console.log('🎯 Settings page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };
  
  const handleName = () => {
    console.log('🎯 Name/Profile management pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsNameEditPageVisible(true);
  };
  
  const handleBilling = () => {
    console.log('🎯 Billing pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsBillingPageVisible(true);
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
    setIsThemePageVisible(true);
  };
  
  const handleLanguage = () => {
    console.log('🎯 App Language pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsLanguagePageVisible(true);
  };
  
  const handleBeta = () => {
    console.log('🎯 Beta pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsBetaPageVisible(true);
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
      
      {/* Page */}
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          {/* Header with Back Arrow & Settings Title */}
          <SettingsHeader
            title={t('settings.title')}
            onClose={handleClose}
          />
          
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
            
            <SettingsItem
              icon={FlaskConical}
              label={t('settings.beta') || 'Beta'}
              onPress={handleBeta}
            />
            
            {/* Sign Out - Regular Menu Item */}
            {!isGuest && (
              <SettingsItem
                icon={LogOut}
                label={t('settings.signOut')}
                onPress={handleSignOut}
              />
            )}
          </View>
          
          <View className="h-20" />
        </ScrollView>
      </View>
      
      {/* Language Page */}
      <LanguagePage 
        visible={isLanguagePageVisible} 
        onClose={() => setIsLanguagePageVisible(false)} 
      />
      
      {/* Name Edit Page */}
      <NameEditPage
        visible={isNameEditPageVisible}
        currentName={userName}
        onClose={() => setIsNameEditPageVisible(false)}
        onNameUpdated={(newName) => {
          console.log('✅ Name updated to:', newName);
          // User data will be refreshed by the page
        }}
      />
      
      {/* Theme Page */}
      <ThemePage
        visible={isThemePageVisible}
        onClose={() => setIsThemePageVisible(false)}
      />
      
      {/* Beta Page */}
      <BetaPage
        visible={isBetaPageVisible}
        onClose={() => setIsBetaPageVisible(false)}
      />
      
      {/* Billing Page */}
      <BillingPage
        visible={isBillingPageVisible}
        onClose={() => setIsBillingPageVisible(false)}
        onOpenCredits={() => {
          setIsBillingPageVisible(false);
          setIsCreditsPurchasePageVisible(true);
        }}
      />
      
      {/* Credits Purchase Page */}
      <CreditsPurchasePage
        visible={isCreditsPurchasePageVisible}
        onClose={() => setIsCreditsPurchasePageVisible(false)}
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

