'use client';

import * as React from 'react';
import { useState, useEffect } from 'react';
import { X, Smartphone, Monitor } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { isElectron } from '@/lib/utils/is-electron';
import { featureFlags } from '@/lib/feature-flags';

const MOBILE_STORAGE_KEY = 'kortix-mobile-banner-dismissed';
const DESKTOP_STORAGE_KEY = 'kortix-desktop-banner-dismissed';

const STORE_LINKS = {
  ios: 'https://apps.apple.com/ie/app/kortix/id6754448524',
  android: 'https://play.google.com/store/apps/details?id=com.kortix.app',
};

const DOWNLOAD_LINKS = {
  windows: 'https://download.kortix.com/desktop/latest/windows/Kortix%20Setup%201.0.0.exe',
  macArm: 'https://download.kortix.com/desktop/latest/macos/Kortix-1.0.0-arm64.dmg',
  macIntel: 'https://download.kortix.com/desktop/latest/macos/Kortix-1.0.0-x64.dmg',
};

type MobilePlatform = 'ios' | 'android';
type DesktopPlatform = 'windows' | 'mac';

type KortixAppBannersProps = {
  /**
   * When true, hides ONLY the mobile (App Store / Play Store) banner.
   * Desktop download banner can still show.
   *
   * If omitted, defaults to the global `featureFlags.disableMobileAdvertising`.
   */
  disableMobileAdvertising?: boolean;
};

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

function detectDesktopPlatform(): DesktopPlatform {
  if (typeof window === 'undefined') return 'mac';
  
  const userAgent = window.navigator.userAgent.toLowerCase();
  const platform = window.navigator.platform?.toLowerCase() || '';
  
  if (platform.includes('win') || userAgent.includes('windows')) {
    return 'windows';
  }
  
  return 'mac';
}

// Detect mobile platform from user agent
function detectMobilePlatform(): MobilePlatform {
  if (typeof window === 'undefined') return 'ios';
  
  const userAgent = window.navigator.userAgent.toLowerCase();
  
  // Check for Android devices
  if (/android/.test(userAgent)) {
    return 'android';
  }
  
  // Default to iOS (more common for this use case)
  return 'ios';
}


export function KortixAppBanners(props: KortixAppBannersProps) {
  const disableMobileAdvertising =
    props.disableMobileAdvertising ?? featureFlags.disableMobileAdvertising;

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
    
    // Auto-detect mobile platform for QR code
    const detectedMobilePlatform = detectMobilePlatform();
    setSelectedMobilePlatform(detectedMobilePlatform);
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('[KortixAppBanners] flags', { disableMobileAdvertising, detectedMobilePlatform });
    }

    const desktopDismissed = localStorage.getItem(DESKTOP_STORAGE_KEY);
    
    const mobileDismissed = disableMobileAdvertising
      ? 'true'
      : localStorage.getItem(MOBILE_STORAGE_KEY);

    setMobileVisible(!mobileDismissed && !disableMobileAdvertising);
    // Hide desktop banner if running in Electron
    setDesktopVisible(!desktopDismissed && !isElectron());
    
    // Show banners after a short delay if at least one is not dismissed
    if ((!mobileDismissed && !disableMobileAdvertising) || (!desktopDismissed && !isElectron())) {
      const timer = setTimeout(() => {
        setIsVisible(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [disableMobileAdvertising]);

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

  const handleOpenStore = () => {
    window.open(STORE_LINKS[selectedMobilePlatform], '_blank');
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
                  <KortixSymbol size={20} className="text-background dark:text-black" />
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
                      <button
                        onClick={handleOpenStore}
                        className="relative bg-white rounded-lg p-2 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                      >
                <img 
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(currentStoreUrl)}&format=svg&ecc=H`}
                  alt={`QR Code to download Kortix on ${selectedMobilePlatform === 'ios' ? 'App Store' : 'Play Store'}`}
                  width={100}
                  height={100}
                  className="block"
                />
                {/* Kortix logo in center */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="bg-white p-1.5 rounded-lg">
                    <KortixSymbol size={24} className="text-black" />
                  </div>
                </div>
                      </button>
                    </div>

                    {/* Content area */}
                    <div className="p-4 bg-muted/50 dark:bg-[#161618]">
                      <h3 className="text-foreground dark:text-white text-sm font-semibold mb-1">
                        Kortix for Mobile is here
                      </h3>
                      <p className="text-muted-foreground dark:text-white/60 text-xs leading-relaxed mb-3">
                        {selectedMobilePlatform === 'ios' 
                          ? 'Download on App Store now.' 
                          : 'Download on Play Store now.'}
                      </p>

                      {/* Store badges - native app store styling */}
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setSelectedMobilePlatform('ios');
                            window.open(STORE_LINKS.ios, '_blank');
                          }}
                          className={`flex-1 h-10 bg-black dark:bg-white rounded-lg flex items-center justify-center gap-2 hover:opacity-90 transition-opacity ${
                            selectedMobilePlatform === 'ios' ? 'ring-2 ring-offset-1 ring-foreground/20' : ''
                          }`}
                        >
                          <AppleLogo className="h-5 w-5 text-white dark:text-black" />
                          <div className="flex flex-col items-start">
                            <span className="text-[8px] text-white/80 dark:text-black/80 leading-none">
                              Download on the
                            </span>
                            <span className="text-[11px] font-semibold text-white dark:text-black leading-tight">
                              App Store
                            </span>
                          </div>
                        </button>
                        <button
                          onClick={() => {
                            setSelectedMobilePlatform('android');
                            window.open(STORE_LINKS.android, '_blank');
                          }}
                          className={`flex-1 h-10 bg-black dark:bg-white rounded-lg flex items-center justify-center gap-2 hover:opacity-90 transition-opacity ${
                            selectedMobilePlatform === 'android' ? 'ring-2 ring-offset-1 ring-foreground/20' : ''
                          }`}
                        >
                          <PlayStoreLogo className="h-5 w-5 text-white dark:text-black" />
                          <div className="flex flex-col items-start">
                            <span className="text-[8px] text-white/80 dark:text-black/80 leading-none">
                              GET IT ON
                            </span>
                            <span className="text-[11px] font-semibold text-white dark:text-black leading-tight">
                              Google Play
                            </span>
                          </div>
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
                          <KortixSymbol size={16} className="text-background dark:text-white" />
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

                      {/* Desktop download badge */}
                      <button
                        onClick={handleDownload}
                        className="w-full h-10 bg-black dark:bg-white rounded-lg flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
                      >
                        {desktopPlatform === 'mac' ? (
                          <AppleLogo className="h-5 w-5 text-white dark:text-black" />
                        ) : (
                          <Monitor className="h-5 w-5 text-white dark:text-black" />
                        )}
                        <div className="flex flex-col items-start">
                          <span className="text-[8px] text-white/80 dark:text-black/80 leading-none">
                            Download for
                          </span>
                          <span className="text-[11px] font-semibold text-white dark:text-black leading-tight">
                            {desktopPlatformLabel}
                          </span>
                        </div>
                      </button>
                      
                      {desktopPlatform === 'mac' && (
                        <button
                          onClick={handleDownloadIntel}
                          className="w-full mt-2 text-[10px] text-muted-foreground dark:text-white/60 hover:text-foreground dark:hover:text-white transition-colors"
                        >
                          Intel Mac? Download here
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

