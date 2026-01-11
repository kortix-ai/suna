'use client';

import { useState, useEffect } from 'react';
import { Smartphone, Bell, Shield, Zap } from 'lucide-react';
import { motion } from 'framer-motion';
import { AppDownloadQR, APP_DOWNLOAD_URL } from '@/components/common/app-download-qr';
import { SimpleFooter } from '@/components/home/simple-footer';

// Mobile users are redirected at the edge by middleware (hyper-fast)
// This page only renders for desktop users

const STORE_LINKS = {
  ios: 'https://apps.apple.com/ie/app/kortix/id6754448524',
  android: 'https://play.google.com/store/apps/details?id=com.kortix.app',
};

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

// Apple logo SVG
function AppleLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
    </svg>
  );
}

// Play icon SVG
function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 406 455" fill="currentColor">
      <path d="M382.634 187.308C413.301 205.014 413.301 249.277 382.634 266.983L69.0001 448.06C38.3334 465.765 3.84111e-05 443.633 3.9959e-05 408.222L5.57892e-05 46.0689C5.73371e-05 10.6581 38.3334 -11.4738 69.0001 6.23166L382.634 187.308Z"/>
    </svg>
  );
}

const FEATURES = [
  { icon: Smartphone, label: 'Always on the go' },
  { icon: Bell, label: 'Push notifications' },
  { icon: Shield, label: 'Secure & private' },
  { icon: Zap, label: 'Lightning fast' },
];

export default function AppDownloadPage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <main className="w-full min-h-screen bg-background relative flex flex-col">

      <div className="relative z-10 flex flex-col items-center justify-center flex-1 px-6 py-16">
        <div className="w-full max-w-5xl mx-auto">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center mb-12"
          >
            {/* App icon */}
            <div className="relative mb-6 z-10">
              <div className="relative w-20 h-20 bg-foreground rounded-[20px] flex items-center justify-center">
                <KortixSymbol size={40} className="text-background" />
              </div>
            </div>
            
            <h1 className="text-2xl md:text-3xl font-semibold text-foreground text-center tracking-tight mb-3">
              Kortix for Mobile
            </h1>
            <p className="text-base text-muted-foreground text-center max-w-xl leading-relaxed">
              Your AI Worker, in your pocket.<br />
              Download the app and take Kortix with you everywhere.
            </p>
          </motion.div>

          {/* QR Code Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center mb-16"
          >
            <div className="relative bg-white dark:bg-[#2a2a2a] rounded-3xl overflow-hidden border border-border/60 dark:border-[#232324] w-full max-w-md">
              {/* QR Code area */}
              <div className="relative bg-muted dark:bg-[#e8e4df] flex items-center justify-center p-12">
                <AppDownloadQR size={200} logoSize={32} />
              </div>

              {/* Info area */}
              <div className="p-6 bg-muted/30 dark:bg-[#161618]">
                <h3 className="text-foreground dark:text-white text-sm font-medium mb-1 text-center">
                  Scan to download
                </h3>
                <p className="text-muted-foreground dark:text-white/60 text-xs text-center mb-5">
                  Automatically opens the right store for your device
                </p>
                
                {/* Direct store links for desktop users */}
                <div className="flex gap-3 max-w-sm mx-auto">
                  <a
                    href={STORE_LINKS.ios}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 h-12 bg-black dark:bg-white rounded-xl flex items-center justify-center gap-1.5 hover:opacity-90 active:scale-[0.98] transition-all"
                  >
                    <AppleLogo className="h-4 w-4 text-white dark:text-black" />
                    <span className="text-base font-semibold text-white dark:text-black">
                      iOS
                    </span>
                  </a>
                  <a
                    href={STORE_LINKS.android}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 h-12 bg-black dark:bg-white rounded-xl flex items-center justify-center gap-1.5 hover:opacity-90 active:scale-[0.98] transition-all"
                  >
                    <PlayIcon className="h-3 w-3 text-white dark:text-black" />
                    <span className="text-base font-semibold text-white dark:text-black">
                      Android
                    </span>
                  </a>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Features Section */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-4xl mx-auto"
          >
            <h2 className="text-2xl md:text-3xl font-medium text-foreground mb-12">
              Why you'll love it
            </h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16 gap-y-12">
              {FEATURES.map((feature, index) => (
                <motion.div
                  key={feature.label}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 + index * 0.1, duration: 0.5 }}
                  className="flex flex-col"
                >
                  <div className="w-10 h-10 bg-foreground/10 dark:bg-foreground/5 rounded-xl flex items-center justify-center mb-4">
                    <feature.icon className="h-5 w-5 text-foreground" />
                  </div>
                  <h3 className="text-base font-semibold text-foreground mb-3">
                    {feature.label}
                  </h3>
                  <p className="text-muted-foreground text-base leading-relaxed">
                    {feature.label === 'Always on the go' && 'Access your AI worker from anywhere, anytime. Your tasks never stop.'}
                    {feature.label === 'Push notifications' && 'Get instant updates when your agents complete tasks or need your input.'}
                    {feature.label === 'Secure & private' && 'Your data is encrypted end-to-end and stored securely. Privacy-first, always.'}
                    {feature.label === 'Lightning fast' && 'Native performance optimized for mobile. Faster than the web app.'}
                  </p>
                </motion.div>
              ))}
            </div>
          </motion.div>

        </div>
      </div>

      <SimpleFooter />
    </main>
  );
}
