export const clearUserLocalStorage = () => {
  if (typeof window === 'undefined') return;

  try {
    localStorage.removeItem('customModels');
    localStorage.removeItem('model-selection-v3');
    localStorage.removeItem('agent-selection-storage');
    localStorage.removeItem('pendingAgentPrompt');
    // Clean up legacy keys
    localStorage.removeItem('opencode-model-store-v1');
    // Clear sandbox/server state — prevents stale sandbox IDs leaking across accounts
    localStorage.removeItem('opencode-servers-v4');
    localStorage.removeItem('kortix-tabs');
    localStorage.removeItem('kortix-tabs-per-server');
    // Clear pattern-based keys
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('maintenance-dismissed-')) {
        localStorage.removeItem(key);
      }
    });
    // Clear sessionStorage sandbox connection flag
    try { sessionStorage.removeItem('kortix-sandbox-was-connected'); } catch {}
  } catch (error) {
    console.error('Error clearing local storage:', error);
  }
};
