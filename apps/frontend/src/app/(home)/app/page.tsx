'use client';

import { useState, useEffect } from 'react';
import { Smartphone, Bell, Shield, Zap } from 'lucide-react';
import { motion } from 'framer-motion';

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


const FEATURES = [
  { icon: Smartphone, label: 'Always on the go' },
  { icon: Bell, label: 'Push notifications' },
  { icon: Shield, label: 'Secure & private' },
  { icon: Zap, label: 'Lightning fast' },
];

type MobilePlatform = 'ios' | 'android';

export default function AppDownloadPage() {
  const [selectedPlatform, setSelectedPlatform] = useState<MobilePlatform>('ios');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const currentStoreUrl = STORE_LINKS[selectedPlatform];

  if (!mounted) {
    return null;
  }

  return (
    <main className="w-full min-h-screen bg-gradient-to-b from-background via-background to-foreground/5 relative overflow-hidden">
      {/* Decorative circles */}
      <div className="absolute -top-48 -right-48 w-96 h-96 bg-foreground/5 rounded-full blur-3xl" />
      <div className="absolute -bottom-48 -left-48 w-96 h-96 bg-foreground/5 rounded-full blur-3xl" />

      <div className="relative flex flex-col items-center justify-center min-h-screen px-6 py-16">
        <div className="w-full max-w-5xl mx-auto">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center mb-16"
          >
            {/* App icon with glow effect */}
            <div className="relative mb-8">
              <div className="absolute inset-0 bg-foreground/20 rounded-[32px] blur-3xl scale-150" />
              <div className="relative w-32 h-32 bg-foreground rounded-[32px] flex items-center justify-center shadow-2xl">
                <KortixSymbol size={64} className="text-background dark:text-foreground" />
              </div>
            </div>
            
            <h1 className="text-5xl md:text-6xl font-bold text-foreground text-center tracking-tight mb-4">
              Kortix for Mobile
            </h1>
            <p className="text-xl text-muted-foreground text-center max-w-2xl leading-relaxed">
              Your AI Worker, in your pocket. Download the app and take Kortix with you everywhere.
            </p>
          </motion.div>

          {/* Main Content Grid */}
          <div className="grid md:grid-cols-2 gap-12 items-center">
            {/* Left: QR Code & Platform Selection */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col items-center"
            >
              {/* QR Code Card */}
              <div className="relative bg-white dark:bg-[#2a2a2a] rounded-3xl shadow-2xl overflow-hidden border border-border/60 dark:border-[#232324] w-full max-w-md">
                {/* QR Code area */}
                <div className="relative bg-muted dark:bg-[#e8e4df] flex items-center justify-center p-12">
                  <div className="relative bg-white rounded-2xl p-4 shadow-lg">
                    <img 
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentStoreUrl)}&format=svg&ecc=H`}
                      alt={`QR Code to download Kortix on ${selectedPlatform === 'ios' ? 'App Store' : 'Play Store'}`}
                      width={200}
                      height={200}
                      className="block"
                    />
                    {/* Kortix logo in center */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="bg-white p-2 rounded-xl shadow-md">
                        <KortixSymbol size={32} className="text-black" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Platform Selection */}
                <div className="p-8 bg-muted/30 dark:bg-[#161618]">
                  <h3 className="text-foreground dark:text-white text-lg font-semibold mb-4 text-center">
                    Scan to download
                  </h3>
                  
                  {/* Store badges */}
                  <div className="flex gap-3 max-w-sm mx-auto">
                    <div className="flex-1">
                      <button
                        onClick={() => {
                          setSelectedPlatform('ios');
                          window.open(STORE_LINKS.ios, '_blank');
                        }}
                        className={`w-full block hover:scale-[1.02] active:scale-[0.98] transition-all rounded-md overflow-hidden ${
                          selectedPlatform === 'ios' ? 'ring-2 ring-offset-2 ring-foreground/30' : ''
                        }`}
                      >
                        {/* White button on white background for light mode */}
                        <div className="bg-white p-1 dark:hidden">
                          <img 
                            src="/stores/app store white button.svg"
                            alt="Download on the App Store"
                            className="w-full h-auto"
                          />
                        </div>
                        {/* Black button on black background for dark mode */}
                        <div className="bg-black p-1 hidden dark:block">
                          <img 
                            src="/stores/app store black button.svg"
                            alt="Download on the App Store"
                            className="w-full h-auto"
                          />
                        </div>
                      </button>
                    </div>
                    <div className="flex-1">
                      <button
                        onClick={() => {
                          setSelectedPlatform('android');
                          window.open(STORE_LINKS.android, '_blank');
                        }}
                        className={`w-full block hover:scale-[1.02] active:scale-[0.98] transition-all rounded-md overflow-hidden ${
                          selectedPlatform === 'android' ? 'ring-2 ring-offset-2 ring-foreground/30' : ''
                        }`}
                      >
                        {/* White button on white background for light mode */}
                        <div className="bg-white p-1 dark:hidden">
                          <img 
                            src="/stores/google play white button.svg"
                            alt="Get it on Google Play"
                            className="w-full h-auto"
                          />
                        </div>
                        {/* Black button on black background for dark mode */}
                        <div className="bg-black p-1 hidden dark:block">
                          <img 
                            src="/stores/google play black button.svg"
                            alt="Get it on Google Play"
                            className="w-full h-auto"
                          />
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>

            {/* Right: Features */}
            <motion.div
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="space-y-6"
            >
              <h2 className="text-3xl font-bold text-foreground mb-8">
                Why you'll love it
              </h2>
              
              {FEATURES.map((feature, index) => (
                <motion.div
                  key={feature.label}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 + index * 0.1, duration: 0.5 }}
                  className="flex items-start gap-4 group"
                >
                  <div className="w-12 h-12 bg-foreground/10 dark:bg-foreground/5 rounded-2xl flex items-center justify-center group-hover:bg-foreground/20 dark:group-hover:bg-foreground/10 transition-colors flex-shrink-0">
                    <feature.icon className="h-6 w-6 text-foreground" />
                  </div>
                  <div className="flex-1 pt-2">
                    <h3 className="text-lg font-semibold text-foreground mb-1">
                      {feature.label}
                    </h3>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      {feature.label === 'Always on the go' && 'Access your AI worker from anywhere, anytime. Your tasks never stop.'}
                      {feature.label === 'Push notifications' && 'Get instant updates when your agents complete tasks or need your input.'}
                      {feature.label === 'Secure & private' && 'Your data is encrypted and secure. Privacy-first, always.'}
                      {feature.label === 'Lightning fast' && 'Native performance optimized for mobile. Faster than the web app.'}
                    </p>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          </div>

          {/* Footer Note */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8, duration: 0.6 }}
            className="mt-16 text-center"
          >
            <p className="text-sm text-muted-foreground">
              Available on iOS and Android. Free to download.
            </p>
          </motion.div>
        </div>
      </div>
    </main>
  );
}

