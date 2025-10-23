import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = '@onboarding_completed';

/**
 * Custom hook to manage onboarding state
 * 
 * Tracks whether user has completed onboarding
 * Uses AsyncStorage for persistence
 * 
 * @example
 * const { hasCompletedOnboarding, isLoading, markAsCompleted } = useOnboarding();
 */
export function useOnboarding() {
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check onboarding status on mount
  useEffect(() => {
    checkOnboardingStatus();
  }, []);

  const checkOnboardingStatus = async () => {
    try {
      const completed = await AsyncStorage.getItem(ONBOARDING_KEY);
      setHasCompletedOnboarding(completed === 'true');
    } catch (error) {
      console.error('Failed to check onboarding status:', error);
      // Default to completed if we can't read the value
      setHasCompletedOnboarding(true);
    } finally {
      setIsLoading(false);
    }
  };

  const markAsCompleted = useCallback(async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
      setHasCompletedOnboarding(true);
      return true;
    } catch (error) {
      console.error('Failed to save onboarding status:', error);
      return false;
    }
  }, []);

  const resetOnboarding = useCallback(async () => {
    try {
      await AsyncStorage.removeItem(ONBOARDING_KEY);
      setHasCompletedOnboarding(false);
      return true;
    } catch (error) {
      console.error('Failed to reset onboarding:', error);
      return false;
    }
  }, []);

  return {
    hasCompletedOnboarding,
    isLoading,
    markAsCompleted,
    resetOnboarding,
  };
}

