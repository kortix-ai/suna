import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthContext } from '@/contexts/AuthContext';

const ONBOARDING_KEY_PREFIX = '@onboarding_completed_';

/**
 * Custom hook to manage onboarding state
 * 
 * Tracks whether user has completed onboarding PER USER PER DEVICE
 * Uses AsyncStorage for persistence with user-specific keys
 * 
 * @example
 * const { hasCompletedOnboarding, isLoading, markAsCompleted } = useOnboarding();
 */
export function useOnboarding() {
  const { session, isLoading: authLoading } = useAuthContext();
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState(true);

  // Generate user-specific key
  const getOnboardingKey = useCallback(() => {
    const userId = session?.user?.id || 'anonymous';
    return `${ONBOARDING_KEY_PREFIX}${userId}`;
  }, [session?.user?.id]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const key = getOnboardingKey();
      const completed = await AsyncStorage.getItem(key);
      setHasCompletedOnboarding(completed === 'true');
    } catch (error) {
      console.error('Failed to check onboarding status:', error);
      // Default to not completed if we can't read the value
      setHasCompletedOnboarding(false);
    } finally {
      setIsLoading(false);
    }
  }, [getOnboardingKey]);

  // Check onboarding status ONLY after auth is loaded and when user changes
  useEffect(() => {
    // Wait for auth to complete first
    if (authLoading) {
      return;
    }
    
    checkOnboardingStatus();
  }, [checkOnboardingStatus, authLoading]);

  const markAsCompleted = useCallback(async () => {
    try {
      const key = getOnboardingKey();
      await AsyncStorage.setItem(key, 'true');
      setHasCompletedOnboarding(true);
      return true;
    } catch (error) {
      console.error('Failed to save onboarding status:', error);
      return false;
    }
  }, [getOnboardingKey]);

  const resetOnboarding = useCallback(async () => {
    try {
      const key = getOnboardingKey();
      await AsyncStorage.removeItem(key);
      setHasCompletedOnboarding(false);
      return true;
    } catch (error) {
      console.error('Failed to reset onboarding:', error);
      return false;
    }
  }, [getOnboardingKey]);

  return {
    hasCompletedOnboarding,
    isLoading,
    markAsCompleted,
    resetOnboarding,
  };
}

