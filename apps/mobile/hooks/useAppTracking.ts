import { useState, useEffect } from 'react';
import { Platform } from 'react-native';
import * as Tracking from 'expo-tracking-transparency';

export type TrackingStatus = 'unavailable' | 'denied' | 'authorized' | 'restricted' | 'not-determined';

interface AppTrackingState {
  status: TrackingStatus;
  isLoading: boolean;
  canTrack: boolean;
}

export function useAppTracking() {
  const [state, setState] = useState<AppTrackingState>({
    status: 'not-determined',
    isLoading: true,
    canTrack: false,
  });

  useEffect(() => {
    checkTrackingStatus();
  }, []);

  const checkTrackingStatus = async () => {
    if (Platform.OS !== 'ios') {
      setState({
        status: 'authorized',
        isLoading: false,
        canTrack: true,
      });
      return;
    }

    try {
      const { status } = await Tracking.getTrackingPermissionsAsync();
      const canTrack = status === 'granted';
      
      setState({
        status: status as TrackingStatus,
        isLoading: false,
        canTrack,
      });
    } catch (error) {
      console.error('Error checking tracking status:', error);
      setState({
        status: 'unavailable',
        isLoading: false,
        canTrack: false,
      });
    }
  };

  const requestTrackingPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'ios') {
      return true;
    }

    try {
      const { status } = await Tracking.requestTrackingPermissionsAsync();
      const canTrack = status === 'granted';
      
      setState({
        status: status as TrackingStatus,
        isLoading: false,
        canTrack,
      });

      return canTrack;
    } catch (error) {
      console.error('Error requesting tracking permission:', error);
      return false;
    }
  };

  return {
    ...state,
    requestTrackingPermission,
    checkTrackingStatus,
  };
}

