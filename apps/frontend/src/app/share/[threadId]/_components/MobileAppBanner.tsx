'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { X, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Detect if user is on mobile device
function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;

  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
  const ua = userAgent.toLowerCase();

  // Check for mobile user agents
  const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i;

  // Also check for iOS Simulator (Macintosh with touch support)
  const isIOSSimulator = ua.includes('macintosh') && navigator.maxTouchPoints > 0;

  return mobileRegex.test(ua) || isIOSSimulator;
}

// Detect specific platform
function getMobilePlatform(): 'ios' | 'android' | null {
  if (typeof window === 'undefined') return null;

  const userAgent = navigator.userAgent.toLowerCase();

  // Check for iOS devices or iOS Simulator (Macintosh with touch)
  if (/iphone|ipad|ipod/.test(userAgent)) {
    return 'ios';
  }
  // iOS Simulator on Mac shows as Macintosh but has touch support
  if (userAgent.includes('macintosh') && navigator.maxTouchPoints > 0) {
    return 'ios';
  }
  if (/android/.test(userAgent)) {
    return 'android';
  }
  return null;
}

interface MobileAppBannerProps {
  threadId: string;
}

export function MobileAppBanner({ threadId }: MobileAppBannerProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [platform, setPlatform] = useState<'ios' | 'android' | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Check if banner was previously dismissed for this session
    const dismissed = sessionStorage.getItem('mobile-app-banner-dismissed');
    if (dismissed) {
      setIsDismissed(true);
      return;
    }

    const mobile = isMobileDevice();
    const mobilePlatform = getMobilePlatform();

    setIsMobile(mobile);
    setPlatform(mobilePlatform);

    // Show banner after a short delay for better UX
    if (mobile) {
      setTimeout(() => setIsVisible(true), 500);
    }
  }, []);

  const handleDismiss = () => {
    setIsVisible(false);
    setIsDismissed(true);
    sessionStorage.setItem('mobile-app-banner-dismissed', 'true');
  };

  const handleOpenInApp = () => {
    // Use custom URL scheme to open the app
    const appUrl = `kortix://share/${threadId}`;

    // Try to open the app
    window.location.href = appUrl;

    // Fallback: If app doesn't open within 2 seconds, show app store
    setTimeout(() => {
      if (platform === 'ios') {
        window.location.href = 'https://apps.apple.com/app/kortix/id6739583417';
      } else if (platform === 'android') {
        window.location.href = 'https://play.google.com/store/apps/details?id=com.kortix.app';
      }
    }, 2000);
  };

  // Don't render on desktop or if dismissed
  if (!isMobile || isDismissed) {
    return null;
  }

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-50 transform transition-transform duration-300 ease-out ${isVisible ? 'translate-y-0' : 'translate-y-full'
        }`}
    >
      <div className="mx-4 mb-4 rounded-2xl bg-background border border-border shadow-lg p-4">
        <div className="flex items-start gap-3">
          {/* App icon */}
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Smartphone className="w-6 h-6 text-primary" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground text-sm">
              Open in Kortix App
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Get the full experience with the native app
            </p>

            <div className="flex gap-2 mt-3">
              <Button
                onClick={handleOpenInApp}
                size="sm"
                className="flex-1 h-10 text-sm font-medium"
              >
                Open App
              </Button>
              <Button
                onClick={handleDismiss}
                variant="outline"
                size="sm"
                className="flex-1 h-10 text-sm font-medium"
              >
                Continue in Browser
              </Button>
            </div>
          </div>

          {/* Close button */}
          <button
            onClick={handleDismiss}
            className="flex-shrink-0 p-1 rounded-full hover:bg-muted transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}
