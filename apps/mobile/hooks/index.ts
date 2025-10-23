/**
 * Hooks Exports
 * 
 * High-level composite hooks that orchestrate lib/ modules
 * For low-level API hooks, import from lib/ directly
 */

// High-level composite hooks
export { useChat } from './useChat';
export { useAuth } from './useAuth';
export { useOnboarding } from './useOnboarding';
export { useNavigation } from './useNavigation';
export { useAuthDrawer } from './useAuthDrawer';

// Export types
export type { UseChatReturn } from './useChat';

// UI hooks
export * from './ui';

// Media hooks
export * from './media';

// Re-export commonly used hooks from lib for convenience
export { useMessages, useSendMessage, useThreads, useInitiateAgent } from '@/lib/chat';
export { useAgents, useAgent } from '@/lib/agents';
export { useTriggers } from '@/lib/triggers';
export { useSubscription, useCreditBalance } from '@/lib/billing';
export { useBillingCheck } from '@/lib/billing/validation'; // Direct import to avoid circular dependency
