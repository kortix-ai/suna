'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  CognitoAuthService,
  CognitoUser,
  InternalAuthResponse,
} from '@/lib/cognito/cognito-auth-service';
import { createClient } from '@/lib/supabase/client';

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
    localStorage.setItem(JWT_STORAGE_KEY, authData.access_token);
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, authData.refresh_token);

    document.cookie = `super_enso_jwt=${authData.access_token}; path=/; max-age=${60 * 60 * 24 * 7}; secure; samesite=strict`;

    setInternalJWT(authData.access_token);
  };

  const clearJWTs = () => {
    localStorage.removeItem(JWT_STORAGE_KEY);
    localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);

    document.cookie =
      'super_enso_jwt=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';

    setInternalJWT(null);
  };

  const refreshJWT = async () => {
    try {
      const authData = await authService.performInternalAuth();
      if (authData) {
        storeJWTs(authData);
      } else {
        console.error('[CognitoAuthProvider] Failed to refresh JWT');
      }
    } catch (error) {
      console.error('[CognitoAuthProvider] JWT refresh error:', error);
    }
  };

  useEffect(() => {
    const initializeAuth = async () => {
      try {
        authService.initialize();

        const cognitoAuthenticated = await authService.isAuthenticated();

        if (!cognitoAuthenticated) {
          setIsAuthenticated(false);
          setUser(null);
          clearJWTs();
          setIsLoading(false);
          return;
        }

        const userData = await authService.getCurrentUser();
        setUser(userData);

        const authData = await authService.performInternalAuth();

        if (!authData) {
          console.error('[CognitoAuthProvider] Failed to get internal JWT');
          throw new Error('Failed to get internal JWT');
        }

        storeJWTs(authData);
        setIsAuthenticated(true);

        if (authData.is_new_user) {
          console.log(
            '[CognitoAuthProvider] New user created:',
            authData.user_id,
          );
        }
      } catch (error) {
        console.error(
          '[CognitoAuthProvider] Auth initialization error:',
          error,
        );
        setIsAuthenticated(false);
        setUser(null);
        clearJWTs();
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();
  }, [authService]);

  const signOut = async () => {
    try {
      await authService.signOut();
      setIsAuthenticated(false);
      setUser(null);
      clearJWTs();
    } catch (error) {
      console.error('[CognitoAuthProvider] Sign out error:', error);
    }
  };

  const redirectToAuth = () => {
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

  return (
    <CognitoAuthContext.Provider value={value}>
      {children}
    </CognitoAuthContext.Provider>
  );
};
