import { ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Colors } from '@/constants/Colors';
import { fonts } from '@/constants/Fonts';
import { useColorScheme } from '@/hooks/useColorScheme';
import { PanelProvider } from '@/hooks/usePanelContext';
import { AppProviders } from '@/providers/AppProviders';

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];

  // Custom navigation themes using our color system
  const customTheme = {
    dark: colorScheme === 'dark',
    colors: {
      primary: colors.primary,
      background: colors.background,
      card: colors.card,
      text: colors.foreground,
      border: colors.border,
      notification: colors.destructive,
    },
    fonts: {
      regular: {
        fontFamily: 'Geist_400Regular',
        fontWeight: '400' as const,
      },
      medium: {
        fontFamily: 'Geist_500Medium',
        fontWeight: '500' as const,
      },
      bold: {
        fontFamily: 'Geist_700Bold',
        fontWeight: '700' as const,
      },
      heavy: {
        fontFamily: 'Geist_800ExtraBold',
        fontWeight: '800' as const,
      },
    },
  };

  const [loaded, error] = useFonts({
    // Geist Sans font family
    Geist_100Thin: fonts.Geist_100Thin,
    Geist_200ExtraLight: fonts.Geist_200ExtraLight,
    Geist_300Light: fonts.Geist_300Light,
    Geist_400Regular: fonts.Geist_400Regular,
    Geist_500Medium: fonts.Geist_500Medium,
    Geist_600SemiBold: fonts.Geist_600SemiBold,
    Geist_700Bold: fonts.Geist_700Bold,
    Geist_800ExtraBold: fonts.Geist_800ExtraBold,
    Geist_900Black: fonts.Geist_900Black,
  });

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) {
    return null;
  }

  return (
    <AppProviders>
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <PanelProvider>
            <ThemeProvider value={customTheme}>
              <Stack screenOptions={{ headerShown: false }} />
              <StatusBar style="auto" />
            </ThemeProvider>
          </PanelProvider>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </AppProviders>
  );
}
