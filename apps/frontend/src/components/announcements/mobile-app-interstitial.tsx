'use client';

import * as React from 'react';
import { useState, useEffect } from 'react';
import { X, Smartphone, Bell, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const INTERSTITIAL_STORAGE_KEY = 'kortix-mobile-interstitial-dismissed';
const INTERSTITIAL_DISMISS_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

// Kortix symbol SVG (inline to avoid loading issues)
function KortixSymbol({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 30 25" 
      fill="currentColor" 
      className={className}
    >
      <path d="M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z"/>
    </svg>
  );
}

const STORE_LINKS = {
  ios: 'https://apps.apple.com/ie/app/kortix/id6754448524',
  android: 'https://play.google.com/store/apps/details?id=com.kortix.app',
};

const DEEP_LINK = 'kortix://';

type MobilePlatform = 'ios' | 'android' | null;

// Detect actual mobile device (not just viewport) using userAgent
function detectMobileDevice(): MobilePlatform {
  if (typeof window === 'undefined') return null;
  
  const userAgent = window.navigator.userAgent.toLowerCase();
  
  // Check for iOS devices
  if (/iphone|ipad|ipod/.test(userAgent)) {
    return 'ios';
  }
  
  // Check for Android devices
  if (/android/.test(userAgent)) {
    return 'android';
  }
  
  return null;
}

// Check if dismissed within expiry period
function isDismissedRecently(): boolean {
  if (typeof window === 'undefined') return false;
  
  const dismissedAt = localStorage.getItem(INTERSTITIAL_STORAGE_KEY);
  if (!dismissedAt) return false;
  
  const dismissedTime = parseInt(dismissedAt, 10);
  const now = Date.now();
  
  return (now - dismissedTime) < INTERSTITIAL_DISMISS_EXPIRY;
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
function PlayStoreLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/>
    </svg>
  );
}

const FEATURES = [
  { icon: Smartphone, label: 'Always on the go' },
  { icon: Bell, label: 'Push notifications' },
  { icon: Shield, label: 'Secure & private' },
];

export function MobileAppInterstitial() {
  const [isVisible, setIsVisible] = useState(false);
  const [platform, setPlatform] = useState<MobilePlatform>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    
    const detectedPlatform = detectMobileDevice();
    setPlatform(detectedPlatform);
    
    // Only show on actual mobile devices and if not recently dismissed
    if (detectedPlatform && !isDismissedRecently()) {
      // Show instantly on mobile devices
      setIsVisible(true);
    }
  }, []);

  const handleDismiss = () => {
    setIsVisible(false);
    localStorage.setItem(INTERSTITIAL_STORAGE_KEY, Date.now().toString());
  };

  const handleOpenInApp = () => {
    // Try to open the app via deep link
    window.location.href = DEEP_LINK;
    
    // If the app doesn't open within 1.5s, redirect to store
    setTimeout(() => {
      if (document.hasFocus()) {
        // User is still on the page, app didn't open
        handleDownload();
      }
    }, 1500);
  };

  const handleDownload = () => {
    if (platform) {
      window.open(STORE_LINKS[platform], '_blank');
    }
  };

  if (!mounted || !isVisible || !platform) return null;

  const storeName = platform === 'ios' ? 'App Store' : 'Google Play';
  const StoreLogo = platform === 'ios' ? AppleLogo : PlayStoreLogo;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4 }}
        className="fixed inset-0 z-[200] overflow-hidden"
      >
        {/* Beautiful gradient background */}
        <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-foreground/5" />
        
        {/* Decorative circles */}
        <div className="absolute -top-32 -right-32 w-64 h-64 bg-foreground/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-32 -left-32 w-64 h-64 bg-foreground/5 rounded-full blur-3xl" />

        {/* Close button - smaller, more subtle */}
        <button
          onClick={handleDismiss}
          className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-muted/60 hover:bg-muted transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>

        {/* Content */}
        <div className="relative flex flex-col items-center justify-between min-h-screen px-6 py-8 safe-area-inset">
          
          {/* Top section - Logo and headline */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center pt-8"
          >
            {/* App icon with glow effect */}
            <div className="relative mb-6">
              <div className="absolute inset-0 bg-foreground/20 rounded-3xl blur-2xl scale-150" />
              <div className="relative w-24 h-24 bg-foreground rounded-[28px] flex items-center justify-center shadow-2xl">
                <KortixSymbol size={48} className="text-background dark:text-foreground" />
              </div>
            </div>
            
            <h1 className="text-3xl font-bold text-foreground text-center tracking-tight">
              Kortix
            </h1>
            <p className="text-muted-foreground text-center text-sm mt-1">
              Your AI Worker, in your pocket
            </p>
          </motion.div>

          {/* Middle section - Value proposition */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.2, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="flex-1 flex flex-col items-center justify-center w-full max-w-sm py-8"
          >
            {/* Main message */}
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-foreground mb-3 leading-tight">
                Get the best experience<br />on mobile
              </h2>
              <p className="text-muted-foreground text-base leading-relaxed">
                We highly recommend using our native app for an optimized mobile experience.
              </p>
            </div>

            {/* Feature list */}
            <div className="flex flex-wrap justify-center gap-2 w-full mb-8">
              {FEATURES.map((feature, index) => (
                <motion.div
                  key={feature.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 + index * 0.05, duration: 0.3 }}
                  className="flex items-center gap-2 bg-muted/50 rounded-full px-4 py-2"
                >
                  <feature.icon className="h-4 w-4 text-foreground/70 flex-shrink-0" />
                  <span className="text-xs font-medium text-foreground/80">{feature.label}</span>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Bottom section - CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-sm space-y-3 pb-4"
          >
            {/* Primary CTA - Open in App */}
            <button
              onClick={handleOpenInApp}
              className="w-full h-14 bg-foreground hover:bg-foreground/90 text-background rounded-2xl text-base font-semibold flex items-center justify-center gap-2 transition-all active:scale-[0.98] shadow-lg"
            >
              <KortixSymbol size={20} className="text-background dark:text-foreground" />
              Open in Kortix App
            </button>

            {/* Secondary CTA - Download with store badge styling */}
            <button
              onClick={handleDownload}
              className="w-full h-14 bg-black dark:bg-white rounded-2xl flex items-center justify-center gap-3 hover:opacity-90 transition-all active:scale-[0.98] shadow-lg"
            >
              <StoreLogo className="h-7 w-7 text-white dark:text-black" />
              <div className="flex flex-col items-start">
                <span className="text-[10px] text-white/70 dark:text-black/70 leading-none font-medium">
                  {platform === 'ios' ? 'Download on the' : 'GET IT ON'}
                </span>
                <span className="text-base font-bold text-white dark:text-black leading-tight">
                  {storeName}
                </span>
              </div>
            </button>

            {/* Continue in browser - more prominent */}
            <button
              onClick={handleDismiss}
              className="w-full h-12 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-xl transition-all"
            >
              Continue in browser
            </button>
          </motion.div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
