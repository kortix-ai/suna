import * as React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const GUEST_MODE_KEY = '@kortix_guest_mode';
const GUEST_SESSION_ID_KEY = '@kortix_guest_session_id';

interface GuestModeContextType {
  isGuestMode: boolean;
  enableGuestMode: () => Promise<void>;
  exitGuestMode: () => Promise<void>;
  isLoading: boolean;
}

const GuestModeContext = React.createContext<GuestModeContextType | undefined>(undefined);

export function GuestModeProvider({ children }: { children: React.ReactNode }) {
  const [isGuestMode, setIsGuestMode] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    loadGuestModeState();
  }, []);

  const loadGuestModeState = async () => {
    try {
      const value = await AsyncStorage.getItem(GUEST_MODE_KEY);
      const sessionId = await AsyncStorage.getItem(GUEST_SESSION_ID_KEY);
      
      console.log('🔍 Loading guest mode state:', {
        guestModeValue: value,
        sessionId: sessionId ? `${sessionId.substring(0, 8)}...` : null,
        isGuestMode: value === 'true'
      });
      
      setIsGuestMode(value === 'true');
    } catch (error) {
      console.error('❌ Error loading guest mode state:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const enableGuestMode = React.useCallback(async () => {
    try {
      const generateUUID = () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      };
      
      const sessionId = generateUUID();
      
      console.log('🔵 Enabling guest mode with session:', sessionId);
      console.trace('Guest mode enable call stack');
      
      await AsyncStorage.multiSet([
        [GUEST_MODE_KEY, 'true'],
        [GUEST_SESSION_ID_KEY, sessionId],
      ]);
      
      setIsGuestMode(true);
      console.log('✅ Guest mode enabled with session:', sessionId);
    } catch (error) {
      console.error('❌ Error enabling guest mode:', error);
    }
  }, []);

  const exitGuestMode = React.useCallback(async () => {
    try {
      console.log('🔴 Exiting guest mode...');
      await AsyncStorage.multiRemove([GUEST_MODE_KEY, GUEST_SESSION_ID_KEY]);
      setIsGuestMode(false);
      console.log('👋 Guest mode disabled');
    } catch (error) {
      console.error('❌ Error exiting guest mode:', error);
    }
  }, []);

  const value = React.useMemo(() => ({
    isGuestMode,
    enableGuestMode,
    exitGuestMode,
    isLoading,
  }), [isGuestMode, enableGuestMode, exitGuestMode, isLoading]);

  return (
    <GuestModeContext.Provider value={value}>
      {children}
    </GuestModeContext.Provider>
  );
}

export function useGuestMode() {
  const context = React.useContext(GuestModeContext);
  
  if (context === undefined) {
    throw new Error('useGuestMode must be used within a GuestModeProvider');
  }
  
  return context;
}

