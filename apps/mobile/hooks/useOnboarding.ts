import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthContext } from '@/contexts/AuthContext';
import { supabase } from '@/api/supabase';
import { log } from '@/lib/logger';

const ONBOARDING_KEY_PREFIX = '@onboarding_completed_';

/**
 * Custom hook to manage onboarding state
 * 
 * Tracks whether user has completed onboarding ACROSS ALL DEVICES
 * Uses Supabase user_metadata as source of truth, with AsyncStorage as cache
 * 
 * Flow:
 * 1. On first registration → user completes onboarding → saves to user_metadata AND AsyncStorage
 * 2. On login from ANY device → checks user_metadata → shows/skips onboarding accordingly
 * 3. AsyncStorage used as cache for faster checks, but user_metadata is the source of truth
 * 
 * @example
 * const { hasCompletedOnboarding, isLoading, markAsCompleted } = useOnboarding();
 */
export function useOnboarding() {
  const { session, isLoading: authLoading } = useAuthContext();
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState(true);

  // Generate user-specific AsyncStorage key (for cache)
  const getOnboardingKey = useCallback(() => {
    const userId = session?.user?.id || 'anonymous';
    return `${ONBOARDING_KEY_PREFIX}${userId}`;
  }, [session?.user?.id]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      // First check user_metadata (source of truth)
      const userMetadata = session?.user?.user_metadata;
      const completedInMetadata = userMetadata?.onboarding_completed === true;
      
      if (completedInMetadata) {
        log.log('✅ Onboarding completed (from user_metadata)');
        setHasCompletedOnboarding(true);
        
        // Update AsyncStorage cache for faster future checks
        const key = getOnboardingKey();
        await AsyncStorage.setItem(key, 'true');
      } else {
        // Fallback: check AsyncStorage (for backwards compatibility with existing users)
        const key = getOnboardingKey();
        const completedInStorage = await AsyncStorage.getItem(key);
        
        if (completedInStorage === 'true') {
          log.log('✅ Onboarding completed (from AsyncStorage cache, migrating to metadata...)');
          setHasCompletedOnboarding(true);
          
          // Migrate to user_metadata so it works on other devices
          await supabase.auth.updateUser({
            data: { onboarding_completed: true }
          });
        } else {
          log.log('📋 Onboarding not completed yet');
          setHasCompletedOnboarding(false);
        }
      }
    } catch (error) {
      log.error('Failed to check onboarding status:', error);
      // Default to not completed if we can't read the value
      setHasCompletedOnboarding(false);
    } finally {
      setIsLoading(false);
    }
  }, [getOnboardingKey, session?.user?.user_metadata]);

  // Check onboarding status ONLY after auth is loaded and when user changes
  useEffect(() => {
    // Wait for auth to complete first
    if (authLoading || !session) {
      if (!authLoading && !session) {
        setIsLoading(false);
      }
      return;
    }
    
    checkOnboardingStatus();
  }, [checkOnboardingStatus, authLoading, session]);

  const markAsCompleted = useCallback(async () => {
    try {
      log.log('✅ Marking onboarding as completed...');
      
      // Save to user_metadata (source of truth - works across devices)
      const { error: metadataError } = await supabase.auth.updateUser({
        data: { onboarding_completed: true }
      });
      
      if (metadataError) {
        log.error('Failed to save onboarding status to user_metadata:', metadataError);
        throw metadataError;
      }
      
      // Also save to AsyncStorage (cache for faster checks)
      const key = getOnboardingKey();
      await AsyncStorage.setItem(key, 'true');
      
      setHasCompletedOnboarding(true);
      log.log('✅ Onboarding status saved successfully');
      return true;
    } catch (error) {
      log.error('Failed to save onboarding status:', error);
      return false;
    }
  }, [getOnboardingKey]);

  const resetOnboarding = useCallback(async () => {
    try {
      log.log('🔄 Resetting onboarding status...');
      
      // Remove from user_metadata
      const { error: metadataError } = await supabase.auth.updateUser({
        data: { onboarding_completed: false }
      });
      
      if (metadataError) {
        log.error('Failed to reset onboarding status in user_metadata:', metadataError);
        throw metadataError;
      }
      
      // Remove from AsyncStorage cache
      const key = getOnboardingKey();
      await AsyncStorage.removeItem(key);
      
      setHasCompletedOnboarding(false);
      log.log('✅ Onboarding status reset successfully');
      return true;
    } catch (error) {
      log.error('Failed to reset onboarding:', error);
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

