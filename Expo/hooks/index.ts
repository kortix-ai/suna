/**
 * Hooks Exports
 *
 * High-level composite hooks that orchestrate lib/ modules
 * For low-level API hooks, import from lib/ directly
 */

// High-level composite hooks
export { useAuth } from './useAuth';
export { useOnboarding } from './useOnboarding';
export { useNavigation } from './useNavigation';
export { useAuthDrawer } from './useAuthDrawer';

// UI hooks
export * from './ui';

// Animation hooks
export { useBackgroundScale } from './useBackgroundScale';

// Re-export commonly used hooks from lib for convenience
export { useSubscription, useCreditBalance } from '@/lib/billing';
export { useBillingCheck } from '@/lib/billing/validation'; // Direct import to avoid circular dependency
