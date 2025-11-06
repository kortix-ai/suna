import { useState, useCallback } from 'react';
import { ProjectLimitError, BillingError } from '@/lib/api/errors';

interface UseBillingModalReturn {
  showModal: boolean;
  creditsExhausted: boolean;
  openModal: (error?: BillingError | ProjectLimitError) => void;
  closeModal: () => void;
}

/**
 * Unified hook for handling billing modals consistently across the app.
 * Determines if credits are exhausted based on the error type and message.
 */
export function useBillingModal(): UseBillingModalReturn {
  const [showModal, setShowModal] = useState(false);
  const [creditsExhausted, setCreditsExhausted] = useState(false);

  const openModal = useCallback((error?: BillingError | ProjectLimitError) => {
    // Determine if credits are exhausted
    // Credits are exhausted if:
    // 1. It's a BillingError (not ProjectLimitError)
    // 2. The error message indicates insufficient credits/balance
    let isCreditsExhausted = false;

    if (error instanceof BillingError) {
      const message = error.detail?.message?.toLowerCase() || '';
      // Check if the error message indicates credits/balance issues
      isCreditsExhausted = 
        message.includes('credit') ||
        message.includes('balance') ||
        message.includes('insufficient') ||
        message.includes('out of credits') ||
        message.includes('no credits');
    } else if (error instanceof ProjectLimitError) {
      // Project limit errors are not about credits
      isCreditsExhausted = false;
    } else {
      // If no error provided, assume it's a general billing issue (not credits exhausted)
      isCreditsExhausted = false;
    }

    setCreditsExhausted(isCreditsExhausted);
    setShowModal(true);
  }, []);

  const closeModal = useCallback(() => {
    setShowModal(false);
    // Reset credits exhausted state when closing
    setCreditsExhausted(false);
  }, []);

  return {
    showModal,
    creditsExhausted,
    openModal,
    closeModal,
  };
}
