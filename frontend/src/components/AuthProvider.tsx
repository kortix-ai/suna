'use client';

/**
 * DEPRECATED: This AuthProvider is being replaced by CognitoAuthProvider
 * We're keeping this file to re-export Cognito auth for backward compatibility
 */

import { useCognitoAuth } from './CognitoAuthProvider';

// Re-export Cognito auth as useAuth for backward compatibility
export const useAuth = useCognitoAuth;

// Note: The old Supabase-based AuthProvider has been replaced with CognitoAuthProvider
// All new code should use useCognitoAuth from CognitoAuthProvider directly
// This export is just for backward compatibility with existing components
