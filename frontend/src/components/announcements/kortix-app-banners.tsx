'use client';

import * as React from 'react';
import { useState, useEffect } from 'react';
import { X, Download, Smartphone, Monitor } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { isElectron } from '@/lib/utils/is-electron';

const MOBILE_STORAGE_KEY = 'kortix-mobile-banner-dismissed';
const DESKTOP_STORAGE_KEY = 'kortix-desktop-banner-dismissed';

const STORE_LINKS = {
  ios: 'https://apps.apple.com/ie/app/kortix/id6754448524',
  android: 'https://play.google.com/store/games?hl=en',
};

const DOWNLOAD_LINKS = {
  windows: 'https://download.kortix.com/desktop/latest/windows/Kortix%20Setup%201.0.0.exe',
  macArm: 'https://download.kortix.com/desktop/latest/macos/Kortix-1.0.0-arm64.dmg',
  macIntel: 'https://download.kortix.com/desktop/latest/macos/Kortix-1.0.0-x64.dmg',
};

type MobilePlatform = 'ios' | 'android';
type DesktopPlatform = 'windows' | 'mac';

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

function detectDesktopPlatform(): DesktopPlatform {
  if (typeof window === 'undefined') return 'mac';
  
  const userAgent = window.navigator.userAgent.toLowerCase();
  const platform = window.navigator.platform?.toLowerCase() || '';
  
  if (platform.includes('win') || userAgent.includes('windows')) {
    return 'windows';
  }
  
  return 'mac';
}


export function KortixAppBanners() {
  const [isVisible, setIsVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  
  // Mobile banner state
  const [mobileVisible, setMobileVisible] = useState(true);
  const [selectedMobilePlatform, setSelectedMobilePlatform] = useState<MobilePlatform>('ios');
  
  // Desktop banner state
  const [desktopVisible, setDesktopVisible] = useState(true);
  const [desktopPlatform, setDesktopPlatform] = useState<DesktopPlatform>('mac');

  useEffect(() => {
    setMounted(true);
    setDesktopPlatform(detectDesktopPlatform());
    
    const mobileDismissed = localStorage.getItem(MOBILE_STORAGE_KEY);
    const desktopDismissed = localStorage.getItem(DESKTOP_STORAGE_KEY);
    
    setMobileVisible(!mobileDismissed);
    // Hide desktop banner if running in Electron
    setDesktopVisible(!desktopDismissed && !isElectron());
    
    // Show banners after a short delay if at least one is not dismissed
    if (!mobileDismissed || (!desktopDismissed && !isElectron())) {
      const timer = setTimeout(() => {
        setIsVisible(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleCloseMobile = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMobileVisible(false);
    localStorage.setItem(MOBILE_STORAGE_KEY, 'true');
  };

  const handleCloseDesktop = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDesktopVisible(false);
    localStorage.setItem(DESKTOP_STORAGE_KEY, 'true');
  };

  const handleDownload = () => {
    let downloadUrl: string;
    if (desktopPlatform === 'windows') {
      downloadUrl = DOWNLOAD_LINKS.windows;
    } else {
      // Mac - default to ARM (M series)
      downloadUrl = DOWNLOAD_LINKS.macArm;
    }
    window.open(downloadUrl, '_blank');
  };

  const handleDownloadIntel = () => {
    window.open(DOWNLOAD_LINKS.macIntel, '_blank');
  };

  const currentStoreUrl = STORE_LINKS[selectedMobilePlatform];
  const desktopPlatformLabel = desktopPlatform === 'windows' ? 'Windows' : 'Mac (M series)';

  if (!mounted || !isVisible) return null;
  if (!mobileVisible && !desktopVisible) return null;

  const showBothBanners = mobileVisible && desktopVisible;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.95 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed bottom-4 right-4 z-[100] w-[280px]"
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      <div className="flex flex-col gap-2">
        <AnimatePresence mode="wait">
          {/* Collapsed state - pill with icons */}
          {!isExpanded && showBothBanners ? (
            <motion.div
              key="collapsed"
              initial={{ opacity: 0, scale: 0.95, y: 5 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 5 }}
              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              className="bg-white dark:bg-[#2a2a2a] rounded-xl shadow-xl border border-border/60 dark:border-[#232324] p-3 cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <div className="flex -space-x-2">
                  <div className="w-10 h-10 bg-foreground dark:bg-white rounded-lg flex items-center justify-center border-2 border-white dark:border-[#2a2a2a]">
                    <Smartphone className="h-5 w-5 text-background dark:text-black" />
                  </div>
                  <div className="w-10 h-10 bg-foreground dark:bg-white rounded-lg flex items-center justify-center border-2 border-white dark:border-[#2a2a2a]">
                    <Monitor className="h-5 w-5 text-background dark:text-black" />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-foreground dark:text-white text-sm font-semibold truncate">
                    Get Kortix Apps
                  </p>
                  <p className="text-muted-foreground dark:text-white/60 text-xs">
                    Mobile & Desktop
                  </p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-foreground dark:bg-white flex items-center justify-center shadow-sm">
                  <KortixLogo size={20} className="invert dark:invert-0" />
                </div>
              </div>
            </motion.div>
          ) : (isExpanded || !showBothBanners) ? (
            <motion.div
              key="expanded"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              className="flex flex-col gap-2"
            >
              {/* Mobile Banner */}
              {mobileVisible && (
                <motion.div
                  initial={{ opacity: 0, y: 40 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="relative bg-white dark:bg-[#2a2a2a] rounded-xl shadow-xl overflow-hidden border border-border/60 dark:border-[#232324]">
                    {/* Close button */}
                    <button
                      onClick={handleCloseMobile}
                      className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-black/80 dark:hover:bg-black transition-colors"
                    >
                      <X className="h-3 w-3 text-foreground dark:text-white" />
                    </button>

                    {/* QR Code area */}
                    <div className="relative h-[140px] bg-muted dark:bg-[#e8e4df] flex items-center justify-center p-4">
                      <div className="relative bg-white rounded-lg p-2 shadow-sm">
                <img 
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(currentStoreUrl)}&format=svg&ecc=H`}
                  alt={`QR Code to download Kortix on ${selectedMobilePlatform === 'ios' ? 'App Store' : 'Play Store'}`}
                  width={100}
                  height={100}
                  className={`block ${selectedMobilePlatform === 'android' ? 'grayscale opacity-40' : ''}`}
                />
                {/* Kortix logo in center */}
                <div className={`absolute inset-0 flex items-center justify-center ${selectedMobilePlatform === 'android' ? 'opacity-40' : ''}`}>
                  <div className="bg-white p-1.5 rounded-lg">
                    <KortixLogo size={24} />
                  </div>
                </div>
                        {selectedMobilePlatform === 'android' && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <span className="bg-foreground/90 dark:bg-black/80 text-background dark:text-white text-sm font-bold px-3 py-1 rounded-md">
                              Soon
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Content area */}
                    <div className="p-4 bg-muted/50 dark:bg-[#161618]">
                      <h3 className="text-foreground dark:text-white text-sm font-semibold mb-1">
                        Kortix for Mobile coming soon
                      </h3>
                      <p className="text-muted-foreground dark:text-white/60 text-xs leading-relaxed mb-3">
                        {selectedMobilePlatform === 'ios' 
                          ? 'Preorder on App Store now.' 
                          : 'Coming soon to Android devices.'}
                      </p>

                      {/* Platform switcher */}
                      <div className="flex gap-2">
                        <button
                          onClick={() => setSelectedMobilePlatform('ios')}
                          className={`flex-1 h-9 flex items-center justify-center gap-1.5 text-xs font-medium rounded-lg transition-all ${
                            selectedMobilePlatform === 'ios'
                              ? 'bg-foreground dark:bg-white text-background dark:text-black'
                              : 'bg-transparent border border-border dark:border-[#3a3a3c] text-muted-foreground hover:text-foreground hover:border-foreground/50 dark:hover:text-white dark:hover:border-white/30'
                          }`}
                        >
                          <AppleLogo className="h-3.5 w-3.5" />
                          App Store
                        </button>
                        <button
                          onClick={() => setSelectedMobilePlatform('android')}
                          className={`flex-1 h-9 flex items-center justify-center gap-1.5 text-xs font-medium rounded-lg transition-all ${
                            selectedMobilePlatform === 'android'
                              ? 'bg-foreground dark:bg-white text-background dark:text-black'
                              : 'bg-transparent border border-border dark:border-[#3a3a3c] text-muted-foreground hover:text-foreground hover:border-foreground/50 dark:hover:text-white dark:hover:border-white/30'
                          }`}
                        >
                          <PlayStoreLogo className="h-3.5 w-3.5" />
                          Play Store
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Desktop Banner */}
              {desktopVisible && (
                <motion.div
                  initial={{ opacity: 0, y: 40 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: mobileVisible ? 0.1 : 0 }}
                >
                  <div className="relative bg-white dark:bg-[#2a2a2a] rounded-xl shadow-xl overflow-hidden border border-border/60 dark:border-[#232324]">
                    {/* Close button */}
                    <button
                      onClick={handleCloseDesktop}
                      className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-black/80 dark:hover:bg-black transition-colors"
                    >
                      <X className="h-3 w-3 text-foreground dark:text-white" />
                    </button>

                    {/* Illustration area */}
                    <div className="relative h-[80px] bg-muted dark:bg-[#e8e4df] flex items-center justify-center">
                      <div className="w-[160px] h-[50px] bg-background dark:bg-white rounded-lg p-2 relative flex items-center justify-center border border-border/40 dark:border-transparent">
                        <div className="flex gap-1 absolute bottom-1.5 left-2">
                          <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                          <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                          <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                        </div>
                        
                        <div className="w-8 h-8 bg-foreground dark:bg-[#1a1a1a] rounded-lg flex items-center justify-center">
                          <KortixLogo size={16} className="invert dark:invert" />
                        </div>
                        
                        <div className="flex gap-1 absolute bottom-1.5 right-2">
                          <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                          <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                          <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                        </div>
                      </div>
                    </div>

                    {/* Content area */}
                    <div className="p-4 bg-muted/50 dark:bg-[#161618]">
                      <h3 className="text-foreground dark:text-white text-sm font-semibold mb-1">
                        Kortix for Desktop is here
                      </h3>
                      <p className="text-muted-foreground dark:text-white/60 text-xs leading-relaxed mb-3">
                        Hand it off to Kortix. From anywhere on your {desktopPlatform === 'mac' ? 'Mac' : 'Desktop'}. Download now.
                      </p>

                      <Button
                        onClick={handleDownload}
                        variant="outline"
                        size="sm"
                        className="w-full h-9 !bg-foreground hover:!bg-foreground/90 dark:!bg-white dark:hover:!bg-gray-100 !border-transparent !text-background dark:!text-black text-xs rounded-lg gap-1.5"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download for {desktopPlatformLabel}
                      </Button>
                      
                      {desktopPlatform === 'mac' && (
                        <button
                          onClick={handleDownloadIntel}
                          className="w-full mt-2 text-xs text-muted-foreground dark:text-white/60 hover:text-foreground dark:hover:text-white transition-colors underline"
                        >
                          Download for Intel Mac
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

