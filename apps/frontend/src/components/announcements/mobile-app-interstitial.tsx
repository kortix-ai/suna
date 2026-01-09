'use client';

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const STORAGE_KEY = 'kortix-mobile-banner-dismissed';
const DISMISS_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const STORE_LINKS = {
  ios: 'https://apps.apple.com/ie/app/kortix/id6754448524',
  android: 'https://play.google.com/store/apps/details?id=com.kortix.app',
} as const;

type Platform = 'ios' | 'android';

function detectPlatform(): Platform | null {
  if (typeof window === 'undefined') return null;
  const ua = window.navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return null;
}

function wasDismissedRecently(): boolean {
  if (typeof window === 'undefined') return false;
  const dismissedAt = localStorage.getItem(STORAGE_KEY);
  if (!dismissedAt) return false;
  return Date.now() - parseInt(dismissedAt, 10) < DISMISS_EXPIRY_MS;
}

function KortixLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 30 25" fill="currentColor" className={className}>
      <path d="M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z" />
    </svg>
  );
}

// Apple logo SVG
function AppleLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
    </svg>
  );
}

// Google Play logo SVG
function GooglePlayLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/>
    </svg>
  );
}

export function MobileAppInterstitial() {
  const [isVisible, setIsVisible] = useState(false);
  const [platform, setPlatform] = useState<Platform | null>(null);

  useEffect(() => {
    const detected = detectPlatform();
    setPlatform(detected);

    if (detected && !wasDismissedRecently()) {
      const timer = setTimeout(() => setIsVisible(true), 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const dismiss = () => {
    setIsVisible(false);
    localStorage.setItem(STORAGE_KEY, Date.now().toString());
  };

  const openStore = () => {
    if (platform) {
      window.open(STORE_LINKS[platform], '_blank');
    }
  };

  if (!isVisible || !platform) return null;

  const isIOS = platform === 'ios';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 120, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 120, opacity: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="fixed bottom-0 left-0 right-0 z-[100] p-4"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        <div className="relative max-w-lg mx-auto">
          {/* Close Button */}
          <button
            onClick={dismiss}
            className="absolute -top-2 -right-2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white dark:bg-neutral-800 border border-black/10 dark:border-white/10 shadow-md hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4 text-neutral-500 dark:text-neutral-400" />
          </button>

          {/* Card */}
          <button
            onClick={openStore}
            className="w-full bg-white dark:bg-neutral-900 border border-black/10 dark:border-white/10 rounded-2xl shadow-xl text-left active:scale-[0.98] transition-transform"
          >
            <div className="p-5 flex items-center gap-4">
              {/* App Icon */}
              <div className="w-14 h-14 bg-black dark:bg-white rounded-xl flex items-center justify-center flex-shrink-0">
                <KortixLogo className="w-7 h-7 text-white dark:text-black" />
              </div>

              {/* Text */}
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-neutral-900 dark:text-white mb-0.5">
                  Get Kortix for Mobile
                </h3>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  Your AI Worker, in your pocket
                </p>
              </div>

              {/* Store Button - minimal design */}
              <div className="flex-shrink-0 h-10 px-3 bg-black dark:bg-white rounded-lg flex items-center justify-center gap-2">
                {isIOS ? (
                  <>
                    <AppleLogo className="h-5 w-5 text-white dark:text-black" />
                    <div className="flex flex-col items-start">
                      <span className="text-[8px] text-white/70 dark:text-black/70 leading-none">
                        App Store
                      </span>
                      <span className="text-[11px] font-semibold text-white dark:text-black leading-tight">
                        iOS
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <GooglePlayLogo className="h-4 w-4 text-white dark:text-black" />
                    <div className="flex flex-col items-start">
                      <span className="text-[8px] text-white/70 dark:text-black/70 leading-none">
                        Google Play
                      </span>
                      <span className="text-[11px] font-semibold text-white dark:text-black leading-tight">
                        Android
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
