import * as React from 'react';
import { Pressable, View, ScrollView, Platform, StyleSheet, TouchableOpacity } from 'react-native';
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
import { NativeHeader } from './NativeHeader';
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

  const backgroundColor = Platform.OS === 'ios'
    ? (colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF')
    : (colorScheme === 'dark' ? '#121212' : '#F5F5F5');

  if (themePreference === null) {
    return (
      <View style={{ flex: 1, backgroundColor, alignItems: 'center', justifyContent: 'center' }}>
        <Text className="text-muted-foreground">Loading...</Text>
      </View>
    );
  }
  
  return (
    <View style={{ flex: 1, backgroundColor }}>
      <NativeHeader
        title={t('theme.title')}
        onBack={handleClose}
      />
      
      <ScrollView 
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16 }}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
      >
        <View style={{ 
          backgroundColor: colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF',
          borderRadius: 20,
          overflow: 'hidden',
          marginBottom: 16,
        }}>
          <ThemeOption
            icon={Sun}
            label={t('theme.light')}
            description={t('theme.lightDescription')}
            isSelected={themePreference === 'light'}
            onPress={() => handleThemeSelect('light')}
            disabled={isTransitioning}
            isFirst={true}
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
            isLast={true}
          />
        </View>
        <View style={{ height: 80 }} />
      </ScrollView>
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
  isFirst?: boolean;
  isLast?: boolean;
}

function ThemeOption({ icon, label, description, isSelected, onPress, disabled, isFirst, isLast }: ThemeOptionProps) {
  const { colorScheme } = useColorScheme();
  
  return (
    <>
      {!isFirst && (
        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
            marginLeft: 16,
          }}
        />
      )}
      <TouchableOpacity
        onPress={disabled ? undefined : onPress}
        disabled={disabled}
        activeOpacity={0.6}
        style={{
          paddingHorizontal: 16,
          paddingVertical: 12,
          minHeight: 56,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
          <Icon 
            as={icon} 
            size={24} 
            className="text-foreground"
            strokeWidth={2} 
          />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 17, color: colorScheme === 'dark' ? '#FFFFFF' : '#000000' }}>
              {label}
            </Text>
          </View>
        </View>
        
        {isSelected && (
          <Icon 
            as={Check} 
            size={24}
            color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'}
            strokeWidth={2.5} 
          />
        )}
      </TouchableOpacity>
    </>
  );
}
