import { useState, useCallback } from 'react';
import { BillingError } from '@kortix/sdk/react';

interface UseBillingModalReturn {
  showModal: boolean;
  creditsExhausted: boolean;
  openModal: (error?: BillingError) => void;
  closeModal: () => void;
}

/**
 * Unified hook for handling billing modals consistently across the app.
 * Determines if credits are exhausted based on the error type and message.
 */
export function useBillingModal(): UseBillingModalReturn {
  const [showModal, setShowModal] = useState(false);
  const [creditsExhausted, setCreditsExhausted] = useState(false);

  const openModal = useCallback((error?: BillingError) => {
    let isCreditsExhausted = false;

    if (error instanceof BillingError) {
      const message = error.detail?.message?.toLowerCase() || '';
      isCreditsExhausted =
        message.includes('credit') ||
        message.includes('balance') ||
        message.includes('insufficient') ||
        message.includes('out of credits') ||
        message.includes('no credits');
    }

    setCreditsExhausted(isCreditsExhausted);
    setShowModal(true);
  }, []);

  const closeModal = useCallback(() => {
    setShowModal(false);
    setCreditsExhausted(false);
  }, []);

  return {
    showModal,
    creditsExhausted,
    openModal,
    closeModal,
  };
}
