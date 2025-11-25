import * as React from 'react';
import { Pressable, View, ScrollView, useColorScheme as useSystemColorScheme } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Sun, Moon, Check, Monitor } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const THEME_PREFERENCE_KEY = '@theme_preference';

type ThemePreference = 'light' | 'dark' | 'system';

interface ThemePageProps {
  visible: boolean;
  onClose: () => void;
}

export function ThemePage({ visible, onClose }: ThemePageProps) {
  const { colorScheme, setColorScheme } = useColorScheme();
  const systemColorScheme = useSystemColorScheme();
  const { t } = useLanguage();
  
  // Start with null - we'll determine the actual preference after checking storage and current theme
  const [themePreference, setThemePreference] = React.useState<ThemePreference | null>(null);
  const [isTransitioning, setIsTransitioning] = React.useState(false);

  // Load preference from storage when component becomes visible
  React.useEffect(() => {
    if (visible) {
      loadThemePreference();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  React.useEffect(() => {
    if (themePreference === 'system' && systemColorScheme) {
      console.log('🌓 System theme changed to:', systemColorScheme);
      setColorScheme(systemColorScheme);
    }
  }, [systemColorScheme, themePreference, setColorScheme]);

  const loadThemePreference = async () => {
    try {
      const saved = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
      const currentTheme = colorScheme || systemColorScheme || 'light';
      
      console.log('🌓 Loading theme preference:', {
        saved,
        currentColorScheme: colorScheme,
        systemColorScheme,
        resolvedTheme: currentTheme
      });
      
      if (saved) {
        const preference = saved as ThemePreference;
        console.log('🌓 Loaded saved theme preference:', preference);
        setThemePreference(preference);
        
        // Apply the saved preference to colorScheme if needed
        if (preference === 'system' && systemColorScheme) {
          setColorScheme(systemColorScheme);
        } else if (preference !== 'system') {
          setColorScheme(preference as 'light' | 'dark');
        }
      } else {
        // No saved preference - derive from current colorScheme
        const derivedPreference = currentTheme === 'dark' ? 'dark' : 'light';
        console.log('🌓 No saved preference, deriving from current theme:', derivedPreference, 'from:', currentTheme);
        setThemePreference(derivedPreference);
      }
    } catch (error) {
      console.error('🌓 Failed to load theme preference:', error);
      // Fallback: derive from current colorScheme
      const currentTheme = colorScheme || systemColorScheme || 'light';
      const derivedPreference = currentTheme === 'dark' ? 'dark' : 'light';
      console.log('🌓 Error fallback, deriving:', derivedPreference);
      setThemePreference(derivedPreference);
    }
  };

  const saveThemePreference = async (preference: ThemePreference) => {
    try {
      console.log('🌓 Saving theme preference:', preference);
      await AsyncStorage.setItem(THEME_PREFERENCE_KEY, preference);
      setThemePreference(preference);
      console.log('🌓 Theme preference saved successfully. State updated to:', preference);
    } catch (error) {
      console.error('Failed to save theme preference:', error);
    }
  };
  
  const handleClose = React.useCallback(() => {
    console.log('🎯 Theme page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);
  
  const handleThemeSelect = React.useCallback(async (preference: ThemePreference) => {
    console.log('🌓 handleThemeSelect called:', {
      preference,
      currentThemePreference: themePreference,
      currentColorScheme: colorScheme,
      isTransitioning
    });
    
    if (isTransitioning) {
      console.log('🌓 Skipping - transitioning');
      return;
    }
    
    // Check if already selected (handle null case)
    if (themePreference !== null && themePreference === preference) {
      console.log('🌓 Skipping - already selected');
      return;
    }
    
    console.log('🌓 Theme preference selected:', preference);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    setIsTransitioning(true);
    
    const newTheme = preference === 'system' 
      ? (systemColorScheme || 'light')
      : preference;
    
    console.log('🌓 Setting colorScheme to:', newTheme);
    setColorScheme(newTheme);
    
    // Await the save operation to ensure state is updated
    await saveThemePreference(preference);
    
    console.log('🌓 Theme preference saved. New themePreference:', preference, 'New colorScheme:', newTheme);
    
    setTimeout(() => {
      setIsTransitioning(false);
    }, 100);
  }, [themePreference, isTransitioning, systemColorScheme, setColorScheme, colorScheme]);
  
  if (!visible) return null;

  // Don't render until we've determined the theme preference
  // This prevents showing the wrong selection initially
  if (themePreference === null) {
    return (
      <View className="absolute inset-0 z-50">
        <Pressable
          onPress={handleClose}
          className="absolute inset-0 bg-black/50"
        />
        <View className="absolute top-0 left-0 right-0 bottom-0 bg-background items-center justify-center">
          <Text className="text-muted-foreground">Loading...</Text>
        </View>
      </View>
    );
  }

  const currentTheme = colorScheme || 'light';
  
  // Determine selected state based on themePreference
  // If themePreference is 'system', check the actual colorScheme
  const getSelectedPreference = (): 'light' | 'dark' => {
    if (themePreference === 'system') {
      return (colorScheme || systemColorScheme || 'light') === 'dark' ? 'dark' : 'light';
    }
    return themePreference;
  };

  const selectedPreference = getSelectedPreference();
  
  console.log('🌓 Rendering theme options:', {
    themePreference,
    colorScheme,
    selectedPreference,
    isLightSelected: selectedPreference === 'light',
    isDarkSelected: selectedPreference === 'dark'
  });
  
  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView 
          className="flex-1" 
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <SettingsHeader
            title={t('theme.title')}
            onClose={handleClose}
          />

          <View className="px-6 pb-8">
            {/* <View className="mb-6">
              <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                {t('theme.preview')}
              </Text>
              <View className="flex-row gap-4 mb-6">
                <DeviceMock theme="light" isActive={currentTheme === 'light'} />
                <DeviceMock theme="dark" isActive={currentTheme === 'dark'} />
              </View>
            </View> */}

            <View className="mb-3">
              <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                {t('theme.themeOptions')}
              </Text>
            </View>

            <View className="gap-3">
              <ThemeOption
                icon={Sun}
                label={t('theme.light')}
                description={t('theme.lightDescription')}
                isSelected={selectedPreference === 'light'}
                onPress={() => handleThemeSelect('light')}
                disabled={isTransitioning}
              />
              
              <ThemeOption
                icon={Moon}
                label={t('theme.dark')}
                description={t('theme.darkDescription')}
                isSelected={selectedPreference === 'dark'}
                onPress={() => handleThemeSelect('dark')}
                disabled={isTransitioning}
              />

              {/* <ThemeOption
                icon={Monitor}
                label={t('theme.system')}
                description={t('theme.systemDescription')}
                isSelected={themePreference === 'system'}
                onPress={() => handleThemeSelect('system')}
                disabled={isTransitioning}
              /> */}
            </View>
          </View>
          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

interface ThemeOptionProps {
  icon: typeof Sun;
  label: string;
  description: string;
  isSelected: boolean;
  onPress: () => void;
  disabled?: boolean;
}

function ThemeOption({ icon, label, description, isSelected, onPress, disabled }: ThemeOptionProps) {
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = () => {
    if (!disabled) {
      scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
    }
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };
  
  return (
    <AnimatedPressable
      onPress={disabled ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      disabled={disabled}
      className={`bg-primary/5 rounded-3xl p-4 ${
        disabled ? 'opacity-60' : 'active:opacity-80'
      }`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-3 flex-1">
          <View className={`h-10 w-10 rounded-full items-center justify-center ${
            isSelected ? 'bg-primary' : 'bg-primary/10'
          }`}>
            <Icon 
              as={icon} 
              size={18} 
              className={isSelected ? 'text-primary-foreground' : 'text-primary'} 
              strokeWidth={2.5} 
            />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-roobert-semibold text-foreground mb-0.5">
              {label}
            </Text>
            <Text className="text-xs font-roobert text-muted-foreground">
              {description}
            </Text>
          </View>
        </View>
        
        {isSelected && (
          <View className="ml-2 h-5 w-5 items-center justify-center rounded-full bg-primary">
            <Icon 
              as={Check} 
              size={12} 
              className="text-primary-foreground" 
              strokeWidth={3} 
            />
          </View>
        )}
      </View>
    </AnimatedPressable>
  );
}

interface DeviceMockProps {
  theme: 'light' | 'dark';
  isActive: boolean;
}

function DeviceMock({ theme, isActive }: DeviceMockProps) {
  const { t } = useLanguage();
  const isLight = theme === 'light';
  const scale = useSharedValue(1);

  React.useEffect(() => {
    if (isActive) {
      scale.value = withSpring(1.05, {
        damping: 15,
        stiffness: 200,
      });
    } else {
      scale.value = withSpring(1, {
        damping: 15,
        stiffness: 200,
      });
    }
  }, [isActive, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View style={animatedStyle} className="items-center flex-1">
      {/* Device Container with Shadow */}
      <View
        className={`relative rounded-[32px] overflow-hidden ${
          isActive ? 'shadow-2xl' : 'shadow-lg'
        }`}
        style={{
          width: 130,
          height: 260,
          shadowColor: isActive ? '#3b82f6' : '#000',
          shadowOffset: { width: 0, height: isActive ? 12 : 8 },
          shadowOpacity: isActive ? 0.3 : 0.15,
          shadowRadius: isActive ? 20 : 12,
          elevation: isActive ? 12 : 6,
        }}
      >
        {/* Outer Frame (Device Bezel) */}
        <View
          className={`absolute inset-0 rounded-[32px] border-[3px] ${
            isActive ? 'border-primary' : 'border-border/30'
          }`}
          style={{
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 4,
          }}
        >
          {/* Screen Background */}
          <View
            className={`absolute inset-[3px] rounded-[29px] ${
              isLight ? 'bg-[#FAFAFA]' : 'bg-[#0A0A0B]'
            }`}
          >
            {/* Dynamic Island / Notch */}
            <View className="absolute top-0 left-0 right-0 h-12 items-center justify-center z-10">
              <View
                className={`w-20 h-[22px] rounded-full ${
                  isLight ? 'bg-[#0A0A0B]' : 'bg-[#1C1C1E]'
                }`}
                style={{
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.3,
                  shadowRadius: 3,
                }}
              >
                {/* Camera */}
                <View className="absolute top-1.5 left-4 w-2 h-2 rounded-full bg-[#1a1a1a]/60" />
                {/* Speaker Grille */}
                <View className="absolute top-2 right-4 w-6 h-1 rounded-full bg-[#1a1a1a]/40" />
              </View>
            </View>

            {/* Screen Content */}
            <View className="absolute top-14 left-0 right-0 bottom-8 px-4">
              {/* Status Bar Area */}
              <View className="flex-row justify-between items-center mb-4 px-1">
                <View className={`w-12 h-2 rounded-full ${
                  isLight ? 'bg-[#D1D5DB]' : 'bg-[#2C2C2E]'
                }`} />
                <View className={`w-8 h-2 rounded-full ${
                  isLight ? 'bg-[#D1D5DB]' : 'bg-[#2C2C2E]'
                }`} />
              </View>

              {/* Content Cards with Gradient Effect */}
              <View className={`h-14 rounded-2xl mb-3 overflow-hidden ${
                isLight ? 'bg-white' : 'bg-[#1C1C1E]'
              }`}
              style={{
                shadowColor: isLight ? '#000' : '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: isLight ? 0.05 : 0.2,
                shadowRadius: 2,
              }}>
                <View className={`h-3 rounded-t-2xl ${
                  isLight ? 'bg-gradient-to-r from-blue-100 to-purple-100' : 'bg-[#2C2C2E]'
                }`} />
              </View>

              <View className={`h-20 rounded-2xl mb-3 overflow-hidden ${
                isLight ? 'bg-white' : 'bg-[#1C1C1E]'
              }`}
              style={{
                shadowColor: isLight ? '#000' : '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: isLight ? 0.05 : 0.2,
                shadowRadius: 2,
              }}>
                <View className={`h-4 rounded-t-2xl ${
                  isLight ? 'bg-gradient-to-r from-green-100 to-teal-100' : 'bg-[#2C2C2E]'
                }`} />
              </View>

              <View className={`h-16 rounded-2xl mb-3 overflow-hidden ${
                isLight ? 'bg-white' : 'bg-[#1C1C1E]'
              }`}
              style={{
                shadowColor: isLight ? '#000' : '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: isLight ? 0.05 : 0.2,
                shadowRadius: 2,
              }}>
                <View className={`h-3 rounded-t-2xl ${
                  isLight ? 'bg-gradient-to-r from-orange-100 to-pink-100' : 'bg-[#2C2C2E]'
                }`} />
              </View>

              <View className={`h-14 rounded-2xl overflow-hidden ${
                isLight ? 'bg-white' : 'bg-[#1C1C1E]'
              }`}
              style={{
                shadowColor: isLight ? '#000' : '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: isLight ? 0.05 : 0.2,
                shadowRadius: 2,
              }}>
                <View className={`h-3 rounded-t-2xl ${
                  isLight ? 'bg-gradient-to-r from-purple-100 to-indigo-100' : 'bg-[#2C2C2E]'
                }`} />
              </View>
            </View>

            {/* Home Indicator */}
            <View className="absolute bottom-2 left-0 right-0 items-center">
              <View
                className={`w-28 h-[5px] rounded-full ${
                  isLight ? 'bg-[#0A0A0B]/30' : 'bg-[#FAFAFA]/30'
                }`}
              />
            </View>
          </View>
        </View>

        {/* Side Buttons */}
        <View
          className={`absolute right-[-3px] top-[60px] w-[3px] h-12 rounded-l-sm ${
            isLight ? 'bg-[#D1D5DB]' : 'bg-[#3C3C3E]'
          }`}
        />
        <View
          className={`absolute right-[-3px] top-[90px] w-[3px] h-8 rounded-l-sm ${
            isLight ? 'bg-[#D1D5DB]' : 'bg-[#3C3C3E]'
          }`}
        />
        <View
          className={`absolute left-[-3px] top-[70px] w-[3px] h-6 rounded-r-sm ${
            isLight ? 'bg-[#D1D5DB]' : 'bg-[#3C3C3E]'
          }`}
        />
      </View>

      {/* Label */}
      <View className="mt-3 items-center">
        <Text
          className={`text-xs font-roobert-medium tracking-wide ${
            isActive ? 'text-primary' : 'text-muted-foreground'
          }`}
        >
          {isLight ? t('theme.lightMode') : t('theme.darkMode')}
        </Text>
      </View>
    </Animated.View>
  );
}


