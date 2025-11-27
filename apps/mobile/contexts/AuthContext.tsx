import * as React from 'react';
import { useAuth } from '@/hooks/useAuth';
import type { AuthState, SignInCredentials, SignUpCredentials, OAuthProvider } from '@/lib/utils/auth-types';

/**
 * Auth Context Type
 */
interface AuthContextType extends AuthState {
  signIn: (credentials: SignInCredentials) => Promise<any>;
  signUp: (credentials: SignUpCredentials) => Promise<any>;
  signInWithOAuth: (provider: OAuthProvider) => Promise<any>;
  resetPassword: (data: { email: string }) => Promise<any>;
  updatePassword: (newPassword: string) => Promise<any>;
  signOut: () => Promise<any>;
  error: any;
  isSigningOut: boolean;
}

const AuthContext = React.createContext<AuthContextType | undefined>(undefined);

/**
 * Auth Provider Component
 * 
 * Wraps the app with authentication state and methods
 * 
 * @example
 * <AuthProvider>
 *   <App />
 * </AuthProvider>
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Hook to use auth context
 * 
 * @example
 * const { user, signIn, signOut } = useAuthContext();
 */
export function useAuthContext() {
  const context = React.useContext(AuthContext);
  
  if (context === undefined) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  
  return context;
}

