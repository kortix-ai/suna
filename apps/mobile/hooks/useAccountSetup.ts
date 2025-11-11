import { useState, useEffect, useCallback } from 'react';
import { useAuthContext } from '@/contexts';
import { useAccountInitialization } from './useAccountInitialization';
import { useBillingContext } from '@/contexts/BillingContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, AppStateStatus } from 'react-native';

const ACCOUNT_SETUP_KEY = '@account_setup_status_';
const ACCOUNT_SETUP_ATTEMPT_KEY = '@account_setup_attempt_';

interface AccountSetupState {
  isChecking: boolean;
  needsSetup: boolean;
  setupError: Error | null;
  isInitializing: boolean;
  attemptCount: number;
}

export function useAccountSetup() {
  const { session, user, isAuthenticated } = useAuthContext();
  const { hasActiveSubscription, subscriptionLoading } = useBillingContext();
  const initializeMutation = useAccountInitialization();
  
  const [state, setState] = useState<AccountSetupState>({
    isChecking: true,
    needsSetup: false,
    setupError: null,
    isInitializing: false,
    attemptCount: 0,
  });

  const getSetupStatusKey = useCallback(() => {
    return `${ACCOUNT_SETUP_KEY}${user?.id || 'unknown'}`;
  }, [user?.id]);

  const getAttemptCountKey = useCallback(() => {
    return `${ACCOUNT_SETUP_ATTEMPT_KEY}${user?.id || 'unknown'}`;
  }, [user?.id]);

  const checkSetupStatus = useCallback(async (): Promise<boolean> => {
    if (!isAuthenticated || !user) {
      console.log('🔍 No user authenticated, skipping setup check');
      return false;
    }

    try {
      console.log('🔍 Checking account setup status...');
      
      const setupKey = getSetupStatusKey();
      const attemptKey = getAttemptCountKey();
      const cachedStatus = await AsyncStorage.getItem(setupKey);
      const attemptCountStr = await AsyncStorage.getItem(attemptKey);
      const attemptCount = attemptCountStr ? parseInt(attemptCountStr, 10) : 0;
      
      if (cachedStatus === 'completed') {
        console.log('✅ Account setup already completed (cached)');
        return false;
      }

      if (hasActiveSubscription) {
        console.log('✅ User has active subscription, marking setup as complete');
        await AsyncStorage.setItem(setupKey, 'completed');
        await AsyncStorage.removeItem(attemptKey);
        return false;
      }

      if (attemptCount >= 3) {
        console.log('⚠️  Max setup attempts reached, skipping to allow manual retry via billing');
        return false;
      }

      console.log(`⚠️  Account needs setup/initialization (attempt ${attemptCount + 1}/3)`);
      return true;
      
    } catch (error) {
      console.error('❌ Error checking setup status:', error);
      return false;
    }
  }, [isAuthenticated, user, hasActiveSubscription, getSetupStatusKey, getAttemptCountKey]);

  const initializeAccount = useCallback(async (): Promise<boolean> => {
    if (!isAuthenticated || state.isInitializing) {
      return false;
    }

    console.log('🚀 Starting account initialization...');
    
    const attemptKey = getAttemptCountKey();
    const attemptCountStr = await AsyncStorage.getItem(attemptKey);
    const attemptCount = attemptCountStr ? parseInt(attemptCountStr, 10) : 0;
    
    await AsyncStorage.setItem(attemptKey, (attemptCount + 1).toString());
    
    setState(prev => ({ 
      ...prev, 
      isInitializing: true, 
      setupError: null,
      attemptCount: attemptCount + 1 
    }));

    return new Promise((resolve) => {
      initializeMutation.mutate(undefined, {
        onSuccess: async (data) => {
          console.log('✅ Account initialized successfully:', data);
          
          const setupKey = getSetupStatusKey();
          await AsyncStorage.setItem(setupKey, 'completed');
          await AsyncStorage.removeItem(attemptKey);
          
          setState({
            isChecking: false,
            needsSetup: false,
            setupError: null,
            isInitializing: false,
            attemptCount: 0,
          });
          
          resolve(true);
        },
        onError: async (error) => {
          console.error('❌ Account initialization failed:', error);
          
          const currentAttemptStr = await AsyncStorage.getItem(attemptKey);
          const currentAttempt = currentAttemptStr ? parseInt(currentAttemptStr, 10) : 0;
          
          setState({
            isChecking: false,
            needsSetup: false,
            setupError: error instanceof Error ? error : new Error('Initialization failed'),
            isInitializing: false,
            attemptCount: currentAttempt,
          });
          
          resolve(false);
        },
      });
    });
  }, [isAuthenticated, state.isInitializing, initializeMutation, getSetupStatusKey, getAttemptCountKey]);

  const markSetupComplete = useCallback(async () => {
    const setupKey = getSetupStatusKey();
    const attemptKey = getAttemptCountKey();
    await AsyncStorage.setItem(setupKey, 'completed');
    await AsyncStorage.removeItem(attemptKey);
    setState({
      isChecking: false,
      needsSetup: false,
      setupError: null,
      isInitializing: false,
      attemptCount: 0,
    });
  }, [getSetupStatusKey, getAttemptCountKey]);

  const retrySetup = useCallback(() => {
    setState(prev => ({ ...prev, setupError: null }));
    initializeAccount();
  }, [initializeAccount]);

  useEffect(() => {
    if (!isAuthenticated || subscriptionLoading) {
      return;
    }

    let isMounted = true;

    const performCheck = async () => {
      const needsSetup = await checkSetupStatus();
      
      if (isMounted) {
        setState(prev => ({
          ...prev,
          isChecking: false,
          needsSetup,
        }));
      }
    };

    performCheck();

    return () => {
      isMounted = false;
    };
  }, [isAuthenticated, subscriptionLoading, checkSetupStatus]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active' && isAuthenticated) {
        console.log('📱 App became active, rechecking setup status...');
        const needsSetup = await checkSetupStatus();
        setState(prev => ({
          ...prev,
          isChecking: false,
          needsSetup,
        }));
      }
    });

    return () => {
      subscription.remove();
    };
  }, [isAuthenticated, checkSetupStatus]);

  return {
    ...state,
    initializeAccount,
    markSetupComplete,
    retrySetup,
    checkSetupStatus,
  };
}

