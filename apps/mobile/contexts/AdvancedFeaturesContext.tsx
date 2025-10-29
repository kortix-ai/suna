import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ADVANCED_FEATURES_KEY = '@advanced_features_enabled';

interface AdvancedFeaturesContextType {
  isEnabled: boolean;
  isLoading: boolean;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  toggle: () => Promise<boolean>;
}

const AdvancedFeaturesContext = createContext<AdvancedFeaturesContextType | undefined>(undefined);

interface AdvancedFeaturesProviderProps {
  children: ReactNode;
}

/**
 * AdvancedFeaturesProvider
 * 
 * Provides shared state for Advanced Features across the entire app.
 * This ensures that when the toggle is changed in SettingsPage,
 * all other components immediately reflect the change.
 * 
 * Features:
 * - Shared state across all components
 * - AsyncStorage persistence
 * - Defaults to false (disabled) - users must opt-in to beta features
 * - Loading state management
 */
export function AdvancedFeaturesProvider({ children }: AdvancedFeaturesProviderProps) {
  const [isEnabled, setIsEnabled] = useState<boolean>(false); // Default to disabled
  const [isLoading, setIsLoading] = useState(true);

  // Check advanced features status on mount
  useEffect(() => {
    checkAdvancedFeaturesStatus();
  }, []);

  const checkAdvancedFeaturesStatus = async () => {
    try {
      const enabled = await AsyncStorage.getItem(ADVANCED_FEATURES_KEY);
      // Default to false (disabled) if not set
      setIsEnabled(enabled === null ? false : enabled === 'true');
    } catch (error) {
      console.error('Failed to check advanced features status:', error);
      // Default to disabled if we can't read the value
      setIsEnabled(false);
    } finally {
      setIsLoading(false);
    }
  };

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      await AsyncStorage.setItem(ADVANCED_FEATURES_KEY, enabled ? 'true' : 'false');
      setIsEnabled(enabled);
      console.log(`✅ Advanced features ${enabled ? 'enabled' : 'disabled'}`);
      return true;
    } catch (error) {
      console.error('Failed to save advanced features status:', error);
      return false;
    }
  }, []);

  const toggle = useCallback(async () => {
    return setEnabled(!isEnabled);
  }, [isEnabled, setEnabled]);

  const value: AdvancedFeaturesContextType = {
    isEnabled,
    isLoading,
    setEnabled,
    toggle,
  };

  return (
    <AdvancedFeaturesContext.Provider value={value}>
      {children}
    </AdvancedFeaturesContext.Provider>
  );
}

/**
 * useAdvancedFeatures Hook
 * 
 * Custom hook to access the Advanced Features context.
 * Must be used within an AdvancedFeaturesProvider.
 * 
 * @example
 * const { isEnabled, isLoading, toggle, setEnabled } = useAdvancedFeatures();
 */
export function useAdvancedFeatures(): AdvancedFeaturesContextType {
  const context = useContext(AdvancedFeaturesContext);
  if (context === undefined) {
    throw new Error('useAdvancedFeatures must be used within an AdvancedFeaturesProvider');
  }
  return context;
}
