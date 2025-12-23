'use client';

import { useEffect } from 'react';

export function ReactScan() {
  useEffect(() => {
    // Only load React Scan in development mode
    if (process.env.NODE_ENV === 'development') {
      import('react-scan').then((reactScan) => {
        reactScan.scan({
          enabled: false,
          log: true,
        });
      }).catch((error) => {
        console.warn('Failed to load React Scan:', error);
      });
    }
  }, []);

  return null;
}
