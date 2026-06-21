'use client';

import { APP_DOWNLOAD_URL, AppDownloadQR } from '@/components/common/app-download-qr';
import { desktopDownloadUrl, isDesktop, startDownload } from '@/lib/desktop';
import { featureFlags } from '@/lib/feature-flags';
import { Monitor, Smartphone, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useEffect, useState } from 'react';

const MOBILE_STORAGE_KEY = 'kortix-mobile-banner-dismissed';
const DESKTOP_STORAGE_KEY = 'kortix-desktop-banner-dismissed';

const STORE_LINKS = {
  ios: 'https://apps.apple.com/ie/app/kortix/id6754448524',
  android: 'https://play.google.com/store/apps/details?id=com.kortix.app',
};

type DesktopPlatform = 'windows' | 'mac' | 'linux';

type KortixAppBannersProps = {
  /**
   * When true, hides ONLY the mobile (App Store / Play Store) banner.
   * Desktop download banner can still show.
   *
   * If omitted, defaults to the global `featureFlags.disableMobileAdvertising`.
   */
  disableMobileAdvertising?: boolean;
  /**
   * Master switch for the mobile banner. Defaults to `false` — the mobile
   * widget is kept implemented but hidden for now. Flip to `true` (and clear
   * `disableMobileAdvertising`) to bring it back.
   */
  showMobile?: boolean;
};

// Apple logo SVG
function AppleLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

// Google Play logo SVG
function GooglePlayLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z" />
    </svg>
  );
}

// Kortix symbol SVG (inline to avoid loading issues)
function KortixSymbol({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 25" fill="currentColor" className={className}>
      <path d="M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z" />
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
  if (platform.includes('linux') || userAgent.includes('linux')) {
    // Treat Android (also reports "linux") as non-desktop — handled by mobile.
    if (!userAgent.includes('android')) return 'linux';
  }

  return 'mac';
}

const PLATFORM_LABELS: Record<DesktopPlatform, string> = {
  windows: 'Windows',
  mac: 'Mac',
  linux: 'Linux',
};

export function KortixAppBanners(props: KortixAppBannersProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const showMobile = props.showMobile ?? false;
  const disableMobileAdvertising = showMobile
    ? (props.disableMobileAdvertising ?? featureFlags.disableMobileAdvertising)
    : true;

  const [isVisible, setIsVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Mobile banner state
  const [mobileVisible, setMobileVisible] = useState(false);

  // Desktop banner state
  const [desktopVisible, setDesktopVisible] = useState(true);
  const [desktopPlatform, setDesktopPlatform] = useState<DesktopPlatform>('mac');

  useEffect(() => {
    setMounted(true);
    setDesktopPlatform(detectDesktopPlatform());

    const desktopDismissed = localStorage.getItem(DESKTOP_STORAGE_KEY);

    const mobileDismissed = disableMobileAdvertising
      ? 'true'
      : localStorage.getItem(MOBILE_STORAGE_KEY);

    const mobileShouldShow = !mobileDismissed && !disableMobileAdvertising;
    // Never advertise the desktop app from inside the desktop app itself.
    const desktopShouldShow = !desktopDismissed && !isDesktop();

    setMobileVisible(mobileShouldShow);
    setDesktopVisible(desktopShouldShow);

    // Show banners after a short delay if at least one is not dismissed
    if (mobileShouldShow || desktopShouldShow) {
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
    const platform =
      desktopPlatform === 'windows' ? 'windows' : desktopPlatform === 'linux' ? 'linux' : 'macos';
    startDownload(desktopDownloadUrl(platform));
  };

  const desktopPlatformLabel = PLATFORM_LABELS[desktopPlatform];

  if (!mounted || !isVisible) return null;
  if (!mobileVisible && !desktopVisible) return null;

  const showBothBanners = mobileVisible && desktopVisible;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.95 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed right-4 bottom-4 z-[100] w-[280px]"
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
              className="border-border/60 cursor-pointer rounded-2xl border bg-white p-3 shadow-xl dark:border-[#232324] dark:bg-[#2a2a2a]"
            >
              <div className="flex items-center gap-3">
                <div className="flex -space-x-2">
                  <div className="bg-foreground flex h-10 w-10 items-center justify-center rounded-lg border-2 border-white dark:border-[#2a2a2a] dark:bg-white">
                    <Smartphone className="text-background h-5 w-5 dark:text-black" />
                  </div>
                  <div className="bg-foreground flex h-10 w-10 items-center justify-center rounded-lg border-2 border-white dark:border-[#2a2a2a] dark:bg-white">
                    <Monitor className="text-background h-5 w-5 dark:text-black" />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm font-semibold dark:text-white">
                    {tI18nHardcoded.raw(
                      'autoComponentsAnnouncementsKortixAppBannersJsxTextGetKortixAppsc0780da4',
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs dark:text-white/60">
                    {tI18nHardcoded.raw(
                      'autoComponentsAnnouncementsKortixAppBannersJsxTextMobileDesktop42d7fa14',
                    )}
                  </p>
                </div>
                <div className="bg-foreground flex h-10 w-10 items-center justify-center rounded-xl shadow-sm dark:bg-white">
                  <KortixSymbol size={20} className="text-background dark:text-black" />
                </div>
              </div>
            </motion.div>
          ) : isExpanded || !showBothBanners ? (
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
                  <div className="border-border/60 relative overflow-hidden rounded-xl border bg-white shadow-xl dark:border-[#232324] dark:bg-[#2a2a2a]">
                    {/* Close button */}
                    <button
                      onClick={handleCloseMobile}
                      className="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/10 transition-colors hover:bg-black/20 dark:bg-black/80 dark:hover:bg-black"
                    >
                      <X className="text-foreground h-3 w-3 dark:text-white" />
                    </button>

                    {/* QR Code area - single QR that auto-redirects to correct store */}
                    <div className="bg-muted relative flex h-[140px] items-center justify-center p-4 dark:bg-[#e8e4df]">
                      <a
                        href={APP_DOWNLOAD_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-transform hover:scale-[1.02]"
                      >
                        <AppDownloadQR
                          size={100}
                          logoSize={24}
                          className="rounded-lg p-2 shadow-sm"
                        />
                      </a>
                    </div>

                    {/* Content area */}
                    <div className="bg-muted/50 p-4 dark:bg-[#161618]">
                      <h3 className="text-foreground mb-1 text-sm font-semibold dark:text-white">
                        {tI18nHardcoded.raw(
                          'autoComponentsAnnouncementsKortixAppBannersJsxTextKortixForMobilec50716d4',
                        )}
                      </h3>
                      <p className="text-muted-foreground mb-3 text-xs leading-relaxed dark:text-white/60">
                        {tI18nHardcoded.raw(
                          'autoComponentsAnnouncementsKortixAppBannersJsxTextScanQROrfcd2deaa',
                        )}
                      </p>

                      {/* Store buttons - direct links */}
                      <div className="flex gap-2">
                        <a
                          href={STORE_LINKS.ios}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-black transition-all hover:opacity-90 active:scale-[0.98] dark:bg-white"
                        >
                          <AppleLogo className="h-5 w-5 text-white dark:text-black" />
                          <div className="flex flex-col items-start">
                            <span className="text-[8px] leading-none text-white/70 dark:text-black/70">
                              {tI18nHardcoded.raw(
                                'autoComponentsAnnouncementsKortixAppBannersJsxTextAppStoref8af2f35',
                              )}
                            </span>
                            <span className="text-[11px] leading-tight font-semibold text-white dark:text-black">
                              iOS
                            </span>
                          </div>
                        </a>
                        <a
                          href={STORE_LINKS.android}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-black transition-all hover:opacity-90 active:scale-[0.98] dark:bg-white"
                        >
                          <GooglePlayLogo className="h-4 w-4 text-white dark:text-black" />
                          <div className="flex flex-col items-start">
                            <span className="text-[8px] leading-none text-white/70 dark:text-black/70">
                              {tI18nHardcoded.raw(
                                'autoComponentsAnnouncementsKortixAppBannersJsxTextGooglePlayacce92d9',
                              )}
                            </span>
                            <span className="text-[11px] leading-tight font-semibold text-white dark:text-black">
                              Android
                            </span>
                          </div>
                        </a>
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
                  transition={{
                    duration: 0.4,
                    ease: [0.16, 1, 0.3, 1],
                    delay: mobileVisible ? 0.1 : 0,
                  }}
                >
                  <div className="border-border/60 relative overflow-hidden rounded-xl border bg-white shadow-xl dark:border-[#232324] dark:bg-[#2a2a2a]">
                    {/* Close button */}
                    <button
                      onClick={handleCloseDesktop}
                      className="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/10 transition-colors hover:bg-black/20 dark:bg-black/80 dark:hover:bg-black"
                    >
                      <X className="text-foreground h-3 w-3 dark:text-white" />
                    </button>

                    {/* Illustration area */}
                    <div className="bg-muted relative flex h-[80px] items-center justify-center dark:bg-[#e8e4df]">
                      <div className="bg-background border-border/40 relative flex h-[50px] w-[160px] items-center justify-center rounded-2xl border p-2 dark:border-transparent dark:bg-white">
                        <div className="absolute bottom-1.5 left-2 flex gap-1">
                          <div className="bg-muted-foreground/30 h-2.5 w-2.5 rounded-sm dark:bg-gray-300" />
                          <div className="bg-muted-foreground/30 h-2.5 w-2.5 rounded-sm dark:bg-gray-300" />
                          <div className="bg-muted-foreground/30 h-2.5 w-2.5 rounded-sm dark:bg-gray-300" />
                        </div>

                        <div className="bg-foreground flex h-8 w-8 items-center justify-center rounded-lg dark:bg-[#1a1a1a]">
                          <KortixSymbol size={16} className="text-background dark:text-white" />
                        </div>

                        <div className="absolute right-2 bottom-1.5 flex gap-1">
                          <div className="bg-muted-foreground/30 h-2.5 w-2.5 rounded-sm dark:bg-gray-300" />
                          <div className="bg-muted-foreground/30 h-2.5 w-2.5 rounded-sm dark:bg-gray-300" />
                          <div className="bg-muted-foreground/30 h-2.5 w-2.5 rounded-sm dark:bg-gray-300" />
                        </div>
                      </div>
                    </div>

                    {/* Content area */}
                    <div className="bg-muted/50 p-4 dark:bg-[#161618]">
                      <h3 className="text-foreground mb-1 text-sm font-semibold dark:text-white">
                        {tI18nHardcoded.raw(
                          'autoComponentsAnnouncementsKortixAppBannersJsxTextKortixForDesktop4fbe6a69',
                        )}
                      </h3>
                      <p className="text-muted-foreground mb-3 text-xs leading-relaxed dark:text-white/60">
                        {tI18nHardcoded.raw(
                          'autoComponentsAnnouncementsKortixAppBannersJsxTextHandItOffb7c5ad4b',
                        )}
                        {desktopPlatformLabel}
                        {tI18nHardcoded.raw(
                          'autoComponentsAnnouncementsKortixAppBannersJsxTextDownloadNowb096164a',
                        )}
                      </p>

                      {/* Desktop download badge */}
                      <button
                        onClick={handleDownload}
                        className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-black transition-opacity hover:opacity-90 dark:bg-white"
                      >
                        {desktopPlatform === 'mac' ? (
                          <AppleLogo className="h-5 w-5 text-white dark:text-black" />
                        ) : (
                          <Monitor className="h-5 w-5 text-white dark:text-black" />
                        )}
                        <div className="flex flex-col items-start">
                          <span className="text-[8px] leading-none text-white/80 dark:text-black/80">
                            {tI18nHardcoded.raw(
                              'autoComponentsAnnouncementsKortixAppBannersJsxTextDownloadFord6d78f54',
                            )}
                          </span>
                          <span className="text-[11px] leading-tight font-semibold text-white dark:text-black">
                            {desktopPlatformLabel}
                          </span>
                        </div>
                      </button>
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
