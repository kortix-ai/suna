'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  CognitoAuthService,
  CognitoUser,
  InternalAuthResponse,
} from '@/lib/cognito/cognito-auth-service';

interface CognitoAuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: CognitoUser | null;
  internalJWT: string | null;
  signOut: () => Promise<void>;
  redirectToAuth: () => void;
  refreshJWT: () => Promise<void>;
}

const CognitoAuthContext = createContext<CognitoAuthContextType | null>(null);

export const useCognitoAuth = () => {
  const context = useContext(CognitoAuthContext);
  if (!context) {
    throw new Error('useCognitoAuth must be used within CognitoAuthProvider');
  }
  return context;
};

// Local storage keys
const JWT_STORAGE_KEY = 'super_enso_jwt';
const REFRESH_TOKEN_STORAGE_KEY = 'super_enso_refresh_token';

interface CognitoAuthProviderProps {
  children: React.ReactNode;
}

export const CognitoAuthProvider: React.FC<CognitoAuthProviderProps> = ({
  children,
}) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<CognitoUser | null>(null);
  const [internalJWT, setInternalJWT] = useState<string | null>(null);

  const authService = CognitoAuthService.getInstance();

  const storeJWTs = (authData: InternalAuthResponse) => {
    console.log('💾 [Auth Provider] Storing JWTs in localStorage');
    localStorage.setItem(JWT_STORAGE_KEY, authData.access_token);
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, authData.refresh_token);
    setInternalJWT(authData.access_token);
    console.log('✅ [Auth Provider] JWTs stored successfully');
  };

  const clearJWTs = () => {
    console.log('🗑️ [Auth Provider] Clearing JWTs from localStorage');
    localStorage.removeItem(JWT_STORAGE_KEY);
    localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
    setInternalJWT(null);
    console.log('✅ [Auth Provider] JWTs cleared');
  };

  const refreshJWT = async () => {
    try {
      console.log('🔄 [Auth Provider] Refreshing JWT...');
      const authData = await authService.performInternalAuth();
      if (authData) {
        storeJWTs(authData);
        console.log('✅ [Auth Provider] JWT refreshed successfully');
      } else {
        console.error('❌ [Auth Provider] Failed to refresh JWT');
      }
    } catch (error) {
      console.error('❌ [Auth Provider] Error refreshing JWT:', error);
    }
  };

  useEffect(() => {
    const initializeAuth = async () => {
      console.log(
        '🚀 [Auth Provider] Starting authentication initialization...',
      );

      try {
        // Step 1: Initialize Amplify/Cognito
        console.log('📝 [Auth Provider] Step 1: Initializing Amplify...');
        authService.initialize();
        console.log('✅ [Auth Provider] Step 1 complete: Amplify initialized');

        // Step 2: Check if user is authenticated with Cognito
        console.log(
          '📝 [Auth Provider] Step 2: Checking Cognito authentication...',
        );
        const cognitoAuthenticated = await authService.isAuthenticated();
        console.log('📝 [Auth Provider] Step 2 result:', {
          cognitoAuthenticated,
        });

        if (!cognitoAuthenticated) {
          console.log('⚠️ [Auth Provider] No Cognito authentication found');
          setIsAuthenticated(false);
          setUser(null);
          clearJWTs();
          setIsLoading(false);
          console.log('✅ [Auth Provider] Initialization complete (no auth)');
          return;
        }

        console.log(
          '✅ [Auth Provider] Step 2 complete: User authenticated with Cognito',
        );

        // Step 3: Get Cognito user data
        console.log('📝 [Auth Provider] Step 3: Fetching Cognito user data...');
        const userData = await authService.getCurrentUser();
        console.log('📝 [Auth Provider] Step 3 result:', userData);
        setUser(userData);
        console.log('✅ [Auth Provider] Step 3 complete: User data set');

        // Step 4: Check if we have a valid internal JWT
        console.log('📝 [Auth Provider] Step 4: Checking for stored JWT...');
        const storedJWT = localStorage.getItem(JWT_STORAGE_KEY);
        console.log('📝 [Auth Provider] Step 4 result:', {
          hasStoredJWT: !!storedJWT,
        });

        if (storedJWT) {
          // TODO: Optionally verify JWT is not expired
          console.log('✅ [Auth Provider] Using stored JWT');
          setInternalJWT(storedJWT);
          setIsAuthenticated(true);
          console.log('✅ [Auth Provider] Step 4 complete: Using cached JWT');
        } else {
          // Step 5: Perform internal authentication to get JWT
          console.log(
            '📝 [Auth Provider] Step 5: No stored JWT, performing internal auth...',
          );
          const authData = await authService.performInternalAuth();

          if (!authData) {
            console.error('❌ [Auth Provider] Failed to get internal JWT');
            throw new Error('Failed to get internal JWT');
          }

          console.log('📝 [Auth Provider] Step 5 result:', {
            hasAccessToken: !!authData.access_token,
            userId: authData.user_id,
            isNewUser: authData.is_new_user,
          });

          // Store JWTs
          storeJWTs(authData);
          setIsAuthenticated(true);

          if (authData.is_new_user) {
            console.log('🎉 [Auth Provider] NEW USER CREATED!');
          }

          console.log(
            '✅ [Auth Provider] Step 5 complete: Internal auth successful',
          );
        }

        console.log('🎉 [Auth Provider] Authentication flow complete!', {
          isAuthenticated: true,
          userId: userData?.userId,
          email: userData?.email,
        });
      } catch (error) {
        console.error('❌ [Auth Provider] Auth initialization error:', error);
        setIsAuthenticated(false);
        setUser(null);
        clearJWTs();
      } finally {
        setIsLoading(false);
        console.log('✅ [Auth Provider] Initialization phase complete');
      }
    };

    initializeAuth();
  }, []);

  const signOut = async () => {
    try {
      console.log('👋 [Auth Provider] Signing out user...');
      await authService.signOut();
      setIsAuthenticated(false);
      setUser(null);
      clearJWTs();
      console.log('✅ [Auth Provider] Sign out complete');
    } catch (error) {
      console.error('❌ [Auth Provider] Sign out error:', error);
    }
  };

  const redirectToAuth = () => {
    console.log('🔀 [Auth Provider] Redirecting to main app authentication...');
    authService.redirectToMainAppAuth();
  };

  const value: CognitoAuthContextType = {
    isAuthenticated,
    isLoading,
    user,
    internalJWT,
    signOut,
    redirectToAuth,
    refreshJWT,
  };

  console.log('🔐 [Auth Provider] Current state:', {
    isAuthenticated,
    isLoading,
    hasUser: !!user,
    hasJWT: !!internalJWT,
  });

  return (
    <CognitoAuthContext.Provider value={value}>
      {children}
    </CognitoAuthContext.Provider>
  );
};
