import * as React from 'react';
import { useState, useEffect } from 'react';
import { Platform } from 'react-native';

let Tracking: any = null;
try {
  Tracking = require('expo-tracking-transparency');
} catch (e) {
  console.warn('⚠️ expo-tracking-transparency not available (needs native rebuild)');
}

interface TrackingContextType {
  canTrack: boolean;
  isLoading: boolean;
  requestTrackingPermission: () => Promise<boolean>;
}

const TrackingContext = React.createContext<TrackingContextType | undefined>(undefined);

export function TrackingProvider({ children }: { children: React.ReactNode }) {
  const [canTrack, setCanTrack] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    checkAndRequestTracking();
  }, []);

  const checkAndRequestTracking = async () => {
    if (!Tracking) {
      console.warn('⚠️ Tracking module not available, defaulting to no tracking');
      setCanTrack(false);
      setIsLoading(false);
      return;
    }

    if (Platform.OS !== 'ios') {
      setCanTrack(true);
      setIsLoading(false);
      return;
    }

    try {
      const { status: currentStatus } = await Tracking.getTrackingPermissionsAsync();
      
      if (currentStatus === 'granted') {
        console.log('✅ Tracking already authorized');
        setCanTrack(true);
        setIsLoading(false);
        return;
      }

      if (currentStatus === 'undetermined') {
        console.log('⏳ Requesting tracking permission...');
        const { status: newStatus } = await Tracking.requestTrackingPermissionsAsync();
        const granted = newStatus === 'granted';
        
        console.log(granted ? '✅ Tracking authorized' : '❌ Tracking denied');
        setCanTrack(granted);
      } else {
        console.log('❌ Tracking not authorized, status:', currentStatus);
        setCanTrack(false);
      }
      
      setIsLoading(false);
    } catch (error) {
      console.error('Error checking/requesting tracking permission:', error);
      setCanTrack(false);
      setIsLoading(false);
    }
  };

  const requestTrackingPermission = async (): Promise<boolean> => {
    if (!Tracking) {
      console.warn('⚠️ Tracking module not available');
      return false;
    }

    if (Platform.OS !== 'ios') {
      return true;
    }

    try {
      const { status } = await Tracking.requestTrackingPermissionsAsync();
      const granted = status === 'granted';
      setCanTrack(granted);
      return granted;
    } catch (error) {
      console.error('Error requesting tracking permission:', error);
      return false;
    }
  };

  return (
    <TrackingContext.Provider value={{ canTrack, isLoading, requestTrackingPermission }}>
      {children}
    </TrackingContext.Provider>
  );
}

export function useTracking() {
  const context = React.useContext(TrackingContext);
  
  if (context === undefined) {
    throw new Error('useTracking must be used within a TrackingProvider');
  }
  
  return context;
}

