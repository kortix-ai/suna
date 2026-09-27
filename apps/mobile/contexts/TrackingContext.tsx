import * as React from 'react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { log } from '@/lib/logger';

let Tracking: any = null;
try {
  Tracking = require('expo-tracking-transparency');
} catch (e) {
  log.warn('⚠️ expo-tracking-transparency not available (needs native rebuild)');
}

interface TrackingContextType {
  canTrack: boolean;
  isLoading: boolean;
  requestTrackingPermission: () => Promise<boolean>;
}

const TrackingContext = React.createContext<TrackingContextType | undefined>(undefined);

/**
 * Tracking permission state. Launch only reads the current status; the iOS
 * App Tracking Transparency prompt appears when a feature that tracks calls
 * `requestTrackingPermission()`, never on cold start.
 */
export function TrackingProvider({ children }: { children: React.ReactNode }) {
  const [canTrack, setCanTrack] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const checkTracking = async () => {
      if (!Tracking) {
        log.warn('⚠️ Tracking module not available, defaulting to no tracking');
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
        const { status } = await Tracking.getTrackingPermissionsAsync();
        if (!mounted) return;
        log.log(status === 'granted' ? '✅ Tracking already authorized' : `Tracking status: ${status}`);
        setCanTrack(status === 'granted');
      } catch (error) {
        log.error('Error checking tracking permission:', error);
        if (!mounted) return;
        setCanTrack(false);
      }
      setIsLoading(false);
    };

    void checkTracking();
    return () => {
      mounted = false;
    };
  }, []);

  const requestTrackingPermission = useCallback(async (): Promise<boolean> => {
    if (!Tracking) {
      log.warn('⚠️ Tracking module not available');
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
      log.error('Error requesting tracking permission:', error);
      return false;
    }
  }, []);

  const value = useMemo<TrackingContextType>(
    () => ({ canTrack, isLoading, requestTrackingPermission }),
    [canTrack, isLoading, requestTrackingPermission]
  );

  return <TrackingContext.Provider value={value}>{children}</TrackingContext.Provider>;
}

export function useTracking() {
  const context = React.useContext(TrackingContext);
  
  if (context === undefined) {
    throw new Error('useTracking must be used within a TrackingProvider');
  }
  
  return context;
}
