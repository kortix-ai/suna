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

// Smooth streaming animation hooks (from shared package)
export { 
  useSmoothText, 
  useSmoothToolArguments, 
  useSmoothToolField, 
  useSmoothToolContent,
  useSmoothAnimation,
  extractFieldFromArguments,
  type SmoothTextResult,
  type SmoothToolArgumentsResult,
  type SmoothToolFieldResult,
  type SmoothAnimationConfig,
  type SmoothAnimationState,
  type SmoothAnimationResult,
} from '@agentpress/shared/animations';

// Keyboard hooks (using react-native-keyboard-controller for native animations)
export {
  useKeyboard,
  useKeyboardVisible,
  useAnimatedKeyboard,
  useKeyboardBottomOffset,
  useReanimatedKeyboardAnimation,
  useKeyboardHandler,
  useResizeMode,
  isKeyboardCurrentlyVisible,
  getKeyboardState,
  dismissKeyboard,
  focusNextInput,
  focusPreviousInput,
  setAndroidInputMode,
  resetAndroidInputMode,
  KeyboardController,
  AndroidSoftInputModes,
  type KeyboardState,
  type AnimatedKeyboardOptions,
  type AnimatedKeyboardResult,
  type KeyboardBottomOffsetResult,
} from './useKeyboard';

// Composite chat hooks
export { useChatCommons } from './useChatCommons';

// Account setup hooks
export { useAccountInitialization } from './useAccountInitialization';
export { useAccountSetup } from './useAccountSetup';

// System status hooks
export { useSystemStatus, useMaintenanceNotice, useTechnicalIssue } from './useSystemStatus';
export type { SystemStatus, MaintenanceNotice, TechnicalIssue } from './useSystemStatus';

// Admin hooks
export { useAdminRole } from './useAdminRole';

// Billing hooks
export {
  useUpgradePaywall,
  PAYWALL_NAMES,
  getPaywallForTier,
  isTopupsTier,
  logAvailablePaywalls,
  type PaywallName,
} from './useUpgradePaywall';

// Re-export commonly used hooks from lib for convenience
export {
  useMessages,
  useSendMessage,
  useThreads,
  useUnifiedAgentStart,
  useDeleteThread,
  useShareThread,
} from '@/lib/chat';
export { useAgents, useAgent } from '@/lib/agents';
export { useTrigger } from '@/lib/triggers';
export { useSubscription, useCreditBalance } from '@/lib/billing';
export { useBillingCheck } from '@/lib/billing/validation';
