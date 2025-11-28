/**
 * Checkout Mode Management
 * 
 * DEPRECATED: Web checkout is disabled. Only native (RevenueCat) checkout is supported.
 * This file is kept for backward compatibility but always returns 'native'.
 */

export type CheckoutMode = 'native';

/**
 * Get checkout mode - always returns 'native' (web checkout disabled)
 */
export async function getCheckoutMode(): Promise<CheckoutMode> {
  return 'native';
}

/**
 * Set checkout mode - no-op (web checkout disabled)
 */
export async function setCheckoutMode(mode: CheckoutMode): Promise<void> {
  // No-op - web checkout is disabled
  if (mode !== 'native') {
    console.warn('⚠️ Web checkout is disabled. Only native checkout is supported.');
  }
}

/**
 * React hook for checkout mode management
 * Always returns 'native' (web checkout disabled)
 */
export function useCheckoutMode() {
  return {
    mode: 'native' as CheckoutMode,
    setMode: async () => {
      console.warn('⚠️ Web checkout is disabled. Only native checkout is supported.');
    },
    isLoading: false,
  };
}
