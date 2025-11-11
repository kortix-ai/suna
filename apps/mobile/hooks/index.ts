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
// Advanced Features now provided by context
export { useAdvancedFeatures } from '@/contexts';

// Export types
export type { UseChatReturn } from './useChat';

// UI hooks
export * from './ui';

// Media hooks
export * from './media';

// Animation hooks
export { useBackgroundScale } from './useBackgroundScale';

// Composite chat hooks
export { useChatCommons } from './useChatCommons';

// Account setup hooks
export { useAccountInitialization } from './useAccountInitialization';
export { useAccountSetup } from './useAccountSetup';

// Re-export commonly used hooks from lib for convenience
export { useMessages, useSendMessage, useThreads, useUnifiedAgentStart, useDeleteThread, useShareThread } from '@/lib/chat';
export { useAgents, useAgent } from '@/lib/agents';
export { useTrigger } from '@/lib/triggers';
export { useSubscription, useCreditBalance } from '@/lib/billing';
export { useBillingCheck } from '@/lib/billing/validation';
