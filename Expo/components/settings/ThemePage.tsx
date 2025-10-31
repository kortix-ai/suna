import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Sun, Moon, Check } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ThemePageProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * ThemePage Component
 * 
 * Simple theme selector page for switching between light and dark modes.
 * 
 * Features:
 * - Full-screen overlay with backdrop
 * - Two options: Light Mode and Dark Mode
 * - Show current selection with checkmark
 * - Uses nativewind's useColorScheme for theme management
 * - Smooth animation when changing themes
 * - Haptic feedback on selection
 * - Auto-persists theme selection
 */
export function ThemePage({ visible, onClose }: ThemePageProps) {
  const { colorScheme, setColorScheme } = useColorScheme();
  const { t } = useLanguage();
  
  const handleClose = React.useCallback(() => {
    console.log('🎯 Theme page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);
  
  const handleThemeSelect = React.useCallback((theme: 'light' | 'dark') => {
    // Don't do anything if already selected
    if (colorScheme === theme) {
      return;
    }
    
    console.log('🌓 Theme selected:', theme);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    // Change theme immediately - page stays open
    setColorScheme(theme);
  }, [colorScheme, setColorScheme]);
  
  if (!visible) return null;
  
  return (
    <View className="absolute inset-0 z-50">
      {/* Backdrop */}
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      {/* Page */}
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <View className="flex-1">
          {/* Header */}
          <SettingsHeader
            title={t('settings.themeTitle') || 'Theme'}
            onClose={handleClose}
          />
          
          {/* Theme Options */}
          <View className="px-6 gap-3">
            {/* Light Mode */}
            <ThemeOption
              icon={Sun}
              label={t('settings.lightMode') || 'Light Mode'}
              isSelected={colorScheme === 'light'}
              onPress={() => handleThemeSelect('light')}
            />
            
            {/* Dark Mode */}
            <ThemeOption
              icon={Moon}
              label={t('settings.darkMode') || 'Dark Mode'}
              isSelected={colorScheme === 'dark'}
              onPress={() => handleThemeSelect('dark')}
            />
          </View>
          
          {/* Current Theme Indicator */}
          <View className="px-6 mt-8">
            <View className="p-4 bg-secondary rounded-2xl">
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              {t('settings.currentTheme') || 'Current Theme'}:{' '}
              <Text className="font-roobert-medium text-foreground">
                {colorScheme === 'dark' 
                  ? (t('settings.darkMode') || 'Dark Mode')
                  : (t('settings.lightMode') || 'Light Mode')
                }
              </Text>
            </Text>
          </View>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * ThemeOption Component
 */
interface ThemeOptionProps {
  icon: typeof Sun;
  label: string;
  isSelected: boolean;
  onPress: () => void;
}

function ThemeOption({ icon, label, isSelected, onPress }: ThemeOptionProps) {
  const { colorScheme } = useColorScheme();
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
  
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className={`h-16 px-4 rounded-2xl flex-row items-center justify-between ${
        isSelected 
          ? 'bg-primary/10 border-2 border-primary' 
          : 'bg-secondary border-2 border-transparent'
      }`}
    >
      <View className="flex-row items-center gap-3">
        <View className={`w-10 h-10 rounded-full items-center justify-center ${
          isSelected ? 'bg-primary' : 'bg-primary/10'
        }`}>
          <Icon 
            as={icon} 
            size={20} 
            className={isSelected ? 'text-primary-foreground' : 'text-foreground/60'} 
            strokeWidth={2} 
          />
        </View>
        <Text className={`text-base font-roobert-medium ${
          isSelected ? 'text-foreground' : 'text-foreground/80'
        }`}>
          {label}
        </Text>
      </View>
      
      {isSelected && (
        <Icon 
          as={Check} 
          size={20} 
          className="text-primary" 
          strokeWidth={2.5} 
        />
      )}
    </AnimatedPressable>
  );
}

