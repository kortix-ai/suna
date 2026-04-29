import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Check, ImageIcon, Monitor, Moon, Palette, Sun } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLogo } from '@/components/ui/KortixLogo';
import {
  DEFAULT_APPEARANCE_THEME,
  DEFAULT_WALLPAPER,
  useAppearanceStore,
  type AppearanceThemeId,
  type WallpaperId,
} from '@/stores/appearance-store';
import { getToggleTrackBg, getToggleActiveBg } from '@/lib/theme-colors';

const THEME_PREFERENCE_KEY = '@theme_preference';

type ThemePreference = 'light' | 'dark' | 'system';

interface AppearanceTheme {
  id: AppearanceThemeId;
  name: string;
  accentColor: string;
}

interface WallpaperOption {
  id: WallpaperId;
  name: string;
  badge?: string;
}

const COLOR_MODES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const APPEARANCE_THEMES: AppearanceTheme[] = [
  { id: 'graphite', name: 'Classic', accentColor: '#737373' },
  { id: 'teal', name: 'Teal', accentColor: '#22808D' },
  { id: 'amber', name: 'Amber', accentColor: '#D4A017' },
  { id: 'rose', name: 'Rose', accentColor: '#D14D72' },
  { id: 'violet', name: 'Violet', accentColor: '#7C5CFC' },
  { id: 'emerald', name: 'Emerald', accentColor: '#2D9F6F' },
  { id: 'neon', name: 'Neon', accentColor: '#E8E000' },
];

const WALLPAPERS: WallpaperOption[] = [
  { id: 'brandmark', name: 'Brandmark' },
  { id: 'symbol', name: 'Symbol' },
  { id: 'aurora', name: 'Aurora', badge: 'Default' },
];

export default function AppearanceScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme, setColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const themeId = useAppearanceStore((s) => s.themeId);
  const wallpaperId = useAppearanceStore((s) => s.wallpaperId);
  const setAppearanceThemeId = useAppearanceStore((s) => s.setThemeId);
  const setAppearanceWallpaperId = useAppearanceStore((s) => s.setWallpaperId);
  const resetAppearance = useAppearanceStore((s) => s.reset);

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

  const activeTheme = React.useMemo(
    () => APPEARANCE_THEMES.find((theme) => theme.id === themeId) || APPEARANCE_THEMES[0],
    [themeId],
  );

  const hasCustomSettings =
    themeId !== DEFAULT_APPEARANCE_THEME || wallpaperId !== DEFAULT_WALLPAPER;

  const handleModeSelect = React.useCallback(
    async (mode: ThemePreference) => {
      if (modePreference === mode) return;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setModePreference(mode);
      setColorScheme(mode);
      await AsyncStorage.setItem(THEME_PREFERENCE_KEY, mode);
    },
    [modePreference, setColorScheme],
  );

  const handleThemeSelect = React.useCallback((id: AppearanceThemeId) => {
    if (themeId === id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAppearanceThemeId(id);
  }, [setAppearanceThemeId, themeId]);

  const handleWallpaperSelect = React.useCallback((id: WallpaperId) => {
    if (wallpaperId === id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAppearanceWallpaperId(id);
  }, [setAppearanceWallpaperId, wallpaperId]);

  const handleReset = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    resetAppearance();
  }, [resetAppearance]);

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
            Choose a theme, color mode, and wallpaper.
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

        <View className="mt-5 px-1">
          <View className="mb-2 flex-row items-center">
            <Icon as={ImageIcon} size={14} className="text-muted-foreground" strokeWidth={2.2} />
            <Text className="ml-2 text-[13px] font-roobert-medium text-foreground/85">Wallpaper</Text>
          </View>

          <View style={{ gap: 12 }}>
          {WALLPAPERS.map((wallpaper) => (
            <WallpaperCard
              key={wallpaper.id}
              wallpaper={wallpaper}
              isSelected={wallpaperId === wallpaper.id}
              accentColor={activeTheme.accentColor}
              isDark={isDark}
              onPress={() => handleWallpaperSelect(wallpaper.id)}
            />
          ))}
          </View>
        </View>

        <View className="mt-5 h-px bg-border/40" />

        <View className="mt-4 px-1">
          <View className="mb-1 flex-row items-center">
            <Icon as={Palette} size={14} className="text-muted-foreground" strokeWidth={2.2} />
            <Text className="ml-2 text-[13px] font-roobert-medium text-foreground/85">Theme Palette</Text>
          </View>

          <View className="mt-1">
            {APPEARANCE_THEMES.map((theme) => {
              const selected = theme.id === themeId;
              return (
                <Pressable
                  key={theme.id}
                  onPress={() => handleThemeSelect(theme.id)}
                  className={`rounded-xl px-2 py-2.5 active:opacity-85 ${selected ? 'bg-muted/60' : ''}`}
                >
                  <View className="flex-row items-center">
                    <View
                      className="h-6 w-6 rounded-full border border-border/40"
                      style={{ backgroundColor: theme.accentColor }}
                    />
                    <Text className="ml-3 text-[15px] font-roobert-medium text-foreground">
                      {theme.name}
                    </Text>
                    {theme.id === DEFAULT_APPEARANCE_THEME && (
                      <View className="ml-2 rounded-full bg-muted px-2 py-0.5">
                        <Text className="text-[10px] font-roobert-medium text-muted-foreground">Default</Text>
                      </View>
                    )}

                    <View className="ml-auto h-5 w-5 items-center justify-center">
                      {selected && (
                        <Icon as={Check} size={16} className="text-primary" strokeWidth={2.7} />
                      )}
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>

        {hasCustomSettings && (
          <Pressable
            onPress={handleReset}
            className="mt-4 self-start rounded-xl bg-muted/60 px-3 py-2 active:opacity-85"
          >
            <Text className="text-xs font-roobert-medium text-muted-foreground">Reset to defaults</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

function WallpaperCard({
  wallpaper,
  isSelected,
  accentColor,
  isDark,
  onPress,
}: {
  wallpaper: WallpaperOption;
  isSelected: boolean;
  accentColor: string;
  isDark: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="overflow-hidden rounded-2xl active:opacity-90"
      style={{
        borderWidth: 1.5,
        borderColor: isSelected
          ? accentColor
          : isDark
            ? 'rgba(248,248,248,0.12)'
            : 'rgba(18,18,21,0.1)',
      }}
    >
      <View style={{ aspectRatio: 2.1 }}>
        <LinearGradient
          colors={
            isDark
              ? ['rgba(30,30,34,1)', 'rgba(20,20,24,1)']
              : ['rgba(245,246,248,1)', 'rgba(237,239,242,1)']
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />

        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
          <View className="h-1/2 border-b border-border/20" />
          <View className="h-1/2" />
        </View>

        <View className="absolute inset-0 items-center justify-center">
          <View style={{
            opacity: wallpaper.id === 'symbol'
              ? (isDark ? 0.05 : 0.04)
              : wallpaper.id === 'aurora'
                ? (isDark ? 0.08 : 0.06)
                : (isDark ? 0.18 : 0.14),
          }}>
            <KortixLogo
              size={wallpaper.id === 'symbol' ? 48 : wallpaper.id === 'aurora' ? 30 : 94}
              variant={wallpaper.id === 'aurora' ? 'logomark' : 'symbol'}
              color={isDark ? 'dark' : 'light'}
            />
          </View>
        </View>

        {isSelected && (
          <View
            className="absolute right-2 top-2 h-5 w-5 items-center justify-center rounded-full"
            style={{ backgroundColor: accentColor }}
          >
            <Icon as={Check} size={12} className="text-white" strokeWidth={2.8} />
          </View>
        )}
      </View>

      <View className="flex-row items-center px-2.5 py-1.5">
        <Text className="text-xs font-roobert-medium text-foreground">{wallpaper.name}</Text>
        {!!wallpaper.badge && (
          <View className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5">
            <Text className="text-[10px] font-roobert-medium text-muted-foreground">{wallpaper.badge}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}
