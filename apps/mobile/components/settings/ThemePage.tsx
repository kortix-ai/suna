import * as React from 'react';
import { View, ScrollView, Platform, StyleSheet, TouchableOpacity, ViewStyle } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Sun, Moon, Check, Monitor } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDrawerBackgroundColor } from '@agentpress/shared';

const THEME_PREFERENCE_KEY = '@theme_preference';
type ThemePreference = 'light' | 'dark' | 'system';

interface ThemePageProps {
  visible: boolean;
  onClose: () => void;
  isDrawer?: boolean;
}

export function ThemePage({ visible, onClose, isDrawer = false }: ThemePageProps) {
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

  const backgroundColor = getDrawerBackgroundColor(Platform.OS, colorScheme);

  if (themePreference === null) {
    return (
      <View style={{ flex: 1, backgroundColor, alignItems: 'center', justifyContent: 'center' }}>
        <Text className="text-muted-foreground">Loading...</Text>
      </View>
    );
  }
  
  const isIOS = Platform.OS === 'ios';
  
  const groupedBackgroundStyle = isIOS 
    ? { borderRadius: 20, overflow: 'hidden' }
    : { 
        backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF',
        borderRadius: 12,
      };

  return (
    <View style={{ flex: 1, backgroundColor, width: '100%', overflow: 'hidden' }}>
      <ScrollView 
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ padding: 16, width: '100%' }}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
      >
        <View 
          style={groupedBackgroundStyle as ViewStyle}
          className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
        >
          <ThemeOption
            icon={Sun}
            label={t('theme.light')}
            isSelected={themePreference === 'light'}
            onPress={() => handleThemeSelect('light')}
            disabled={isTransitioning}
            isFirst={true}
          />
          
          <ThemeOption
            icon={Moon}
            label={t('theme.dark')}
            isSelected={themePreference === 'dark'}
            onPress={() => handleThemeSelect('dark')}
            disabled={isTransitioning}
          />

          <ThemeOption
            icon={Monitor}
            label={t('theme.system')}
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
  isSelected: boolean;
  onPress: () => void;
  disabled?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
}

function ThemeOption({ icon, label, isSelected, onPress, disabled, isFirst, isLast }: ThemeOptionProps) {
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';
  
  // Match SettingsPage colors exactly
  const separatorColor = colorScheme === 'dark' ? '#38383A' : '#C6C6C8';
  
  return (
    <>
      {!isFirst && (
        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: separatorColor,
            marginLeft: isIOS ? 52 : 16,
          }}
        />
      )}
      <TouchableOpacity
        onPress={disabled ? undefined : onPress}
        disabled={disabled}
        activeOpacity={isIOS ? 0.6 : 0.7}
        style={{
          paddingHorizontal: 16,
          paddingVertical: isIOS ? 11 : 14,
          minHeight: isIOS ? 44 : 56,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: isIOS ? 12 : 16, flex: 1 }}>
          <Icon 
            as={icon} 
            size={isIOS ? 20 : 24} 
            className="text-foreground"
            strokeWidth={2} 
          />
          <Text 
            style={{ 
              fontSize: isIOS ? 17 : 16,
              fontWeight: isIOS ? '400' : '500',
              flex: 1,
            }}
            className="text-foreground"
          >
            {label}
          </Text>
        </View>
        
        {isSelected && (
          <Icon 
            as={Check} 
            size={isIOS ? 20 : 24}
            color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'}
            strokeWidth={2.5} 
          />
        )}
      </TouchableOpacity>
    </>
  );
}
