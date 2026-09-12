import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Monitor, Moon, Sun } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { haptics } from '@/lib/haptics';
import { getToggleTrackBg, getToggleActiveBg } from '@/lib/theme-colors';

const THEME_PREFERENCE_KEY = '@theme_preference';

type ThemePreference = 'light' | 'dark' | 'system';

const COLOR_MODES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export default function AppearanceScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme, setColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [isLoaded, setIsLoaded] = React.useState(false);
  const [modePreference, setModePreference] = React.useState<ThemePreference>('light');

  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const savedMode = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);

        if (!mounted) return;

        if (savedMode === 'light' || savedMode === 'dark' || savedMode === 'system') {
          setModePreference(savedMode);
        } else {
          setModePreference(colorScheme === 'dark' ? 'dark' : 'light');
        }
      } finally {
        if (mounted) {
          setIsLoaded(true);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [colorScheme]);

  const handleModeSelect = React.useCallback(
    async (mode: ThemePreference) => {
      if (modePreference === mode) return;

      haptics.selection();
      setModePreference(mode);
      setColorScheme(mode);
      await AsyncStorage.setItem(THEME_PREFERENCE_KEY, mode);
    },
    [modePreference, setColorScheme],
  );

  if (!isLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-sm font-roobert text-muted-foreground">Loading appearance...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <View className="px-5 pt-1 pb-8">
        <View className="px-1">
          <Text className="text-sm font-roobert text-muted-foreground">
            Choose a color mode.
          </Text>
        </View>

        <View className="mt-5 px-1">
          <Text className="text-[13px] font-roobert-medium text-foreground/85">Color Mode</Text>
          <View
            className="mt-2 flex-row rounded-full p-1"
            style={{ backgroundColor: getToggleTrackBg(isDark) }}
          >
            {COLOR_MODES.map((mode) => {
              const active = modePreference === mode.value;
              return (
                <Pressable
                  key={mode.value}
                  onPress={() => handleModeSelect(mode.value)}
                  className="flex-1 rounded-full active:opacity-85"
                  style={{
                    backgroundColor: active ? getToggleActiveBg(isDark) : 'transparent',
                  }}
                >
                  <View className="flex-row items-center justify-center px-2 py-2">
                    <Icon
                      as={mode.icon}
                      size={14}
                      className={active ? 'text-foreground' : 'text-muted-foreground'}
                      strokeWidth={2.2}
                    />
                    <Text
                      className={`ml-1.5 text-xs font-roobert-medium ${
                        active ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {mode.label}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </ScrollView>
  );
}
