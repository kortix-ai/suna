'use client';

import { useTranslations } from 'next-intl';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { XIcon as X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
  const ua = userAgent.toLowerCase();
  const mobileRegex =
    /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i;
  const isIOSSimulator = ua.includes('macintosh') && navigator.maxTouchPoints > 0;
  return mobileRegex.test(ua) || isIOSSimulator;
}

function getMobilePlatform(): 'ios' | 'android' | null {
  if (typeof window === 'undefined') return null;
  const userAgent = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(userAgent)) return 'ios';
  if (userAgent.includes('macintosh') && navigator.maxTouchPoints > 0) return 'ios';
  if (/android/.test(userAgent)) return 'android';
  return null;
}

interface MobileAppBannerProps {
  shareId: string;
}

export function MobileAppBanner({ shareId }: MobileAppBannerProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  // Mobile app banner disabled — mobile users go through normal auth flow
  return null;
  const [isMobile, setIsMobile] = useState(false);
  const [platform, setPlatform] = useState<'ios' | 'android' | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const dismissed = sessionStorage.getItem('mobile-app-banner-dismissed');
    if (dismissed) {
      setIsDismissed(true);
      return;
    }
    const mobile = isMobileDevice();
    const mobilePlatform = getMobilePlatform();
    setIsMobile(mobile);
    setPlatform(mobilePlatform);
    if (mobile) {
      const timer = setTimeout(() => setIsVisible(true), 500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleDismiss = () => {
    setIsVisible(false);
    setIsDismissed(true);
    sessionStorage.setItem('mobile-app-banner-dismissed', 'true');
  };

  const handleOpenInApp = () => {
    const appUrl = `kortix://share/${shareId}`;
    window.location.href = appUrl;

    setTimeout(() => {
      if (platform === 'ios') {
        window.location.href = 'https://apps.apple.com/ie/app/kortix/id6754448524';
      } else if (platform === 'android') {
        window.location.href = 'https://play.google.com/store/apps/details?id=com.kortix.app';
      }
    }, 2000);
  };

  if (!isMobile || isDismissed) return null;

  return (
    <div
      className={cn(
        'fixed top-0 right-0 left-0 z-50 transform transition-transform duration-300 ease-out',
        isVisible ? 'translate-y-0' : '-translate-y-full',
      )}
    >
      <div className="bg-background/95 border-border/50 safe-area-top border-b px-3 py-2.5 backdrop-blur-md">
        <div className="flex items-center gap-3">
          {/* App icon */}
          <div className="bg-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl">
            <KortixLogo size={20} className="invert dark:invert-0" />
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            <h3 className="text-foreground text-sm leading-tight font-semibold">dosco</h3>
            <p className="text-muted-foreground text-xs leading-tight">
              {tHardcodedUi.raw(
                'appShareShareidComponentsMobileappbanner.line94JsxTextOpenThisContentInApp',
              )}
            </p>
          </div>

          {/* Open button */}
          <Button onClick={handleOpenInApp} size="sm" className="px-4 text-xs">
            Open
          </Button>

          {/* Close button */}
          <button
            onClick={handleDismiss}
            className="hover:bg-muted/80 -mr-1 shrink-0 rounded-full p-1.5 transition-colors"
            aria-label="Dismiss"
          >
            <X className="text-muted-foreground h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
