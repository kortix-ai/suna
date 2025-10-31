import type { Session, User } from '@supabase/supabase-js';

/**
 * Authentication state
 */
export interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

/**
 * Sign in with email credentials
 */
export interface SignInCredentials {
  email: string;
  password: string;
}

/**
 * Sign up with email credentials
 */
export interface SignUpCredentials {
  email: string;
  password: string;
  fullName?: string;
}

/**
 * OAuth provider types
 */
export type OAuthProvider = 'google' | 'github' | 'apple';

/**
 * Password reset request
 */
export interface PasswordResetRequest {
  email: string;
}

/**
 * Auth error types
 */
export interface AuthError {
  message: string;
  status?: number;
}

