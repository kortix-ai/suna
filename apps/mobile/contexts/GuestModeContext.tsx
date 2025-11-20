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
      setIsGuestMode(value === 'true');
    } catch (error) {
      console.error('Error loading guest mode state:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const enableGuestMode = async () => {
    try {
      const generateUUID = () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      };
      
      const sessionId = generateUUID();
      
      await AsyncStorage.multiSet([
        [GUEST_MODE_KEY, 'true'],
        [GUEST_SESSION_ID_KEY, sessionId],
      ]);
      
      setIsGuestMode(true);
      console.log('✅ Guest mode enabled with session:', sessionId);
    } catch (error) {
      console.error('Error enabling guest mode:', error);
    }
  };

  const exitGuestMode = async () => {
    try {
      await AsyncStorage.multiRemove([GUEST_MODE_KEY, GUEST_SESSION_ID_KEY]);
      setIsGuestMode(false);
      console.log('👋 Guest mode disabled');
    } catch (error) {
      console.error('Error exiting guest mode:', error);
    }
  };

  return (
    <GuestModeContext.Provider value={{ isGuestMode, enableGuestMode, exitGuestMode, isLoading }}>
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

