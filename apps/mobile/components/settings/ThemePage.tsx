import * as React from 'react';
import { Pressable, View, ScrollView } from 'react-native';
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
  const { t } = useLanguage();
  
  const [themePreference, setThemePreference] = React.useState<ThemePreference | null>(null);
  const [isTransitioning, setIsTransitioning] = React.useState(false);
  const isMountedRef = React.useRef(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (visible) {
      loadThemePreference();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const loadThemePreference = async () => {
    try {
      const saved = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
      if (!isMountedRef.current) return;
      if (saved) {
        const preference = saved as ThemePreference;
        setThemePreference(preference);
        setColorScheme(preference === 'system' ? 'system' : preference);
      } else {
        const currentTheme = colorScheme || 'light';
        const derivedPreference = currentTheme === 'dark' ? 'dark' : 'light';
        setThemePreference(derivedPreference);
      }
    } catch {
      if (!isMountedRef.current) return;
      const derivedPreference = colorScheme === 'dark' ? 'dark' : 'light';
      setThemePreference(derivedPreference);
    }
  };

  const saveThemePreference = async (preference: ThemePreference) => {
    try {
      await AsyncStorage.setItem(THEME_PREFERENCE_KEY, preference);
      setThemePreference(preference);
    } catch {
    }
  };
  
  const handleClose = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);
  
  const handleThemeSelect = React.useCallback(async (preference: ThemePreference) => {
    if (isTransitioning) return;
    if (themePreference !== null && themePreference === preference) return;
    
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsTransitioning(true);
    
    await saveThemePreference(preference);
    setColorScheme(preference === 'system' ? 'system' : preference);
    
    setTimeout(() => {
      setIsTransitioning(false);
    }, 100);
  }, [themePreference, isTransitioning, setColorScheme]);
  
  if (!visible) return null;

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
                isSelected={themePreference === 'light'}
                onPress={() => handleThemeSelect('light')}
                disabled={isTransitioning}
              />
              
              <ThemeOption
                icon={Moon}
                label={t('theme.dark')}
                description={t('theme.darkDescription')}
                isSelected={themePreference === 'dark'}
                onPress={() => handleThemeSelect('dark')}
                disabled={isTransitioning}
              />

              <ThemeOption
                icon={Monitor}
                label={t('theme.system')}
                description={t('theme.systemDescription')}
                isSelected={themePreference === 'system'}
                onPress={() => handleThemeSelect('system')}
                disabled={isTransitioning}
              />
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
