import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { Appearance } from 'react-native';
import { log } from '@/lib/logger';

const THEME_PREFERENCE_KEY = '@theme_preference';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  /** User's preference: light, dark, or system */
  preference: ThemePreference;
  /** The actual resolved theme based on preference and system setting */
  resolvedTheme: ResolvedTheme;
  /** Whether theme has been loaded from storage */
  isLoaded: boolean;
  /** Initialize theme from AsyncStorage */
  initialize: () => Promise<void>;
  /** Set theme preference and persist */
  setPreference: (preference: ThemePreference) => Promise<void>;
  /** Toggle between light and dark (ignores system) */
  toggle: () => Promise<void>;
}

function getSystemTheme(): ResolvedTheme {
  return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') {
    return getSystemTheme();
  }
  return preference;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: 'light',
  resolvedTheme: 'light',
  isLoaded: false,

  initialize: async () => {
    try {
      const saved = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
      log.log('🌓 Theme store: Loading preference from storage:', saved);
      
      const preference: ThemePreference = (saved as ThemePreference) || 'light';
      const resolvedTheme = resolveTheme(preference);
      
      log.log('🌓 Theme store: Initialized with:', { preference, resolvedTheme });
      
      set({ preference, resolvedTheme, isLoaded: true });
    } catch (error) {
      log.error('🌓 Theme store: Failed to load preference:', error);
      set({ preference: 'light', resolvedTheme: 'light', isLoaded: true });
    }
  },

  setPreference: async (preference: ThemePreference) => {
    const resolvedTheme = resolveTheme(preference);
    
    log.log('🌓 Theme store: Setting preference:', { preference, resolvedTheme });
    
    set({ preference, resolvedTheme });
    
    try {
      await AsyncStorage.setItem(THEME_PREFERENCE_KEY, preference);
      log.log('🌓 Theme store: Preference saved to storage');
    } catch (error) {
      log.error('🌓 Theme store: Failed to save preference:', error);
    }
  },

  toggle: async () => {
    const { resolvedTheme } = get();
    const newPreference: ThemePreference = resolvedTheme === 'dark' ? 'light' : 'dark';
    await get().setPreference(newPreference);
  },
}));

// Listen to system theme changes
Appearance.addChangeListener(({ colorScheme }) => {
  const state = useThemeStore.getState();
  if (state.preference === 'system') {
    const resolvedTheme = colorScheme === 'dark' ? 'dark' : 'light';
    log.log('🌓 Theme store: System theme changed to:', resolvedTheme);
    useThemeStore.setState({ resolvedTheme });
  }
});

