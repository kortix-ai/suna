import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AuthMethod = 'google' | 'github' | 'email';

interface AuthTrackingState {
  lastAuthMethod: AuthMethod | null;
  setLastAuthMethod: (method: AuthMethod) => void;
  wasLastAuthMethod: (method: AuthMethod) => boolean;
  clearLastAuthMethod: () => void;
}

export const useAuthTracking = create<AuthTrackingState>()(
  persist(
    (set, get) => ({
      lastAuthMethod: null,
      
      setLastAuthMethod: (method: AuthMethod) => {
        set({ lastAuthMethod: method });
      },
      
      wasLastAuthMethod: (method: AuthMethod) => {
        return get().lastAuthMethod === method;
      },
      
      clearLastAuthMethod: () => {
        set({ lastAuthMethod: null });
      },
    }),
    {
      name: 'auth-tracking-storage',
      partialize: (state) => ({ lastAuthMethod: state.lastAuthMethod }),
    }
  )
);

export const useAuthMethodTracking = (method: AuthMethod) => {
  const { lastAuthMethod, setLastAuthMethod } = useAuthTracking();
  
  const wasLastMethod = lastAuthMethod === method;
  
  const markAsUsed = () => {
    setLastAuthMethod(method);
  };

  return { wasLastMethod, markAsUsed };
}; 