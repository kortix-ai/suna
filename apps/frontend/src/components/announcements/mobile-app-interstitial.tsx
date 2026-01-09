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

              {/* Store Badge */}
              <div className="flex-shrink-0">
                {isIOS ? (
                  <>
                    <img
                      src="/stores/app store white button.svg"
                      alt="Download on the App Store"
                      className="w-28 h-auto dark:hidden"
                    />
                    <img
                      src="/stores/app store black button.svg"
                      alt="Download on the App Store"
                      className="w-28 h-auto hidden dark:block"
                    />
                  </>
                ) : (
                  <>
                    <img
                      src="/stores/google play white button.svg"
                      alt="Get it on Google Play"
                      className="w-28 h-auto dark:hidden"
                    />
                    <img
                      src="/stores/google play black button.svg"
                      alt="Get it on Google Play"
                      className="w-28 h-auto hidden dark:block"
                    />
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
