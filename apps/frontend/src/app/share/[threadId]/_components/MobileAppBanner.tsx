'use client';

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

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
      className={`fixed top-0 left-0 right-0 z-50 transform transition-transform duration-300 ease-out ${isVisible ? 'translate-y-0' : '-translate-y-full'
        }`}
    >
      <div className="bg-background/95 backdrop-blur-md border-b border-border/50 px-3 py-2.5 safe-area-top">
        <div className="flex items-center gap-3">
          {/* App icon */}
          <div className="shrink-0 w-10 h-10 rounded-xl bg-foreground flex items-center justify-center">
            <KortixLogo size={20} className="invert dark:invert-0" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground text-sm leading-tight">
              Kortix
            </h3>
            <p className="text-xs text-muted-foreground leading-tight">
              Open this content in app
            </p>
          </div>

          {/* Open button */}
          <Button
            onClick={handleOpenInApp}
            size="sm"
            className="h-8 px-4 text-xs font-semibold rounded-full"
          >
            Open
          </Button>

          {/* Close button */}
          <button
            onClick={handleDismiss}
            className="shrink-0 p-1.5 -mr-1 rounded-full hover:bg-muted/80 transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}
