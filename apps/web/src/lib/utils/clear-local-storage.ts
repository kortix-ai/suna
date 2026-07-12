export const clearUserLocalStorage = () => {
  if (typeof window === 'undefined') return;

  try {
    localStorage.removeItem('customModels');
    localStorage.removeItem('model-selection-v3');
    localStorage.removeItem('agent-selection-storage');
    localStorage.removeItem('auth-tracking-storage');
    localStorage.removeItem('pendingAgentPrompt');
    localStorage.removeItem('kortix-runtime-model-store-v1');
    // Clean up legacy keys
    localStorage.removeItem('opencode-model-store-v1');
    // Clear tab state so it doesn't leak across accounts
    localStorage.removeItem('kortix-tabs');
    // Clear pattern-based keys
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('maintenance-dismissed-')) {
        localStorage.removeItem(key);
      }
    });
    // Clear sessionStorage runtime connection flag
    try { sessionStorage.removeItem('kortix-runtime-was-connected'); } catch {}

    console.log('✅ Local storage cleared on logout');
  } catch (error) {
    console.error('❌ Error clearing local storage:', error);
  }
};
