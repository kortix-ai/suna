'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { siteConfig } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import { X, Menu } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useRouter, usePathname } from 'next/navigation';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { useTranslations } from 'next-intl';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { AppDownloadQR } from '@/components/common/app-download-qr';
import { isMobileDevice } from '@/lib/utils/is-mobile-device';

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

// Scroll threshold with hysteresis to prevent flickering
const SCROLL_THRESHOLD_DOWN = 50;
const SCROLL_THRESHOLD_UP = 20;

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const drawerVariants = {
  hidden: { opacity: 0, y: 100 },
  visible: {
    opacity: 1,
    y: 0,
    rotate: 0,
    transition: {
      type: 'spring' as const,
      damping: 15,
      stiffness: 200,
      staggerChildren: 0.03,
    },
  },
  exit: {
    opacity: 0,
    y: 100,
    transition: { duration: 0.1 },
  },
};

const drawerMenuContainerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const drawerMenuVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

export function Navbar() {
  const [hasScrolled, setHasScrolled] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('hero');
  const [isMobile, setIsMobile] = useState(false);
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');
  const lastScrollY = useRef(0);

  const filteredNavLinks = siteConfig.nav.links;

  // Detect if user is on an actual mobile device (iOS/Android)
  // Mobile users clicking "Try Free" will be redirected to /app which then redirects to app stores
  useEffect(() => {
    setIsMobile(isMobileDevice());
  }, []);

  // Get the appropriate CTA link based on device type
  const ctaLink = isMobile ? '/app' : '/auth';

  // Single unified scroll handler with hysteresis
  const handleScroll = useCallback(() => {
    const currentScrollY = window.scrollY;
    
    // Hysteresis: different thresholds for scrolling up vs down
    if (!hasScrolled && currentScrollY > SCROLL_THRESHOLD_DOWN) {
      setHasScrolled(true);
    } else if (hasScrolled && currentScrollY < SCROLL_THRESHOLD_UP) {
      setHasScrolled(false);
    }

    // Update active section
    const sections = filteredNavLinks.map((item) => item.href.substring(1));
    for (const section of sections) {
      const element = document.getElementById(section);
      if (element) {
        const rect = element.getBoundingClientRect();
        if (rect.top <= 150 && rect.bottom >= 150) {
          setActiveSection(section);
          break;
        }
      }
    }

    lastScrollY.current = currentScrollY;
  }, [hasScrolled, filteredNavLinks]);

  useEffect(() => {
    // Use passive listener for better scroll performance
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // Initial check
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const toggleDrawer = () => setIsDrawerOpen((prev) => !prev);
  const handleOverlayClick = () => setIsDrawerOpen(false);

  return (
    <header className="sticky top-4 z-50 flex justify-center mx-2 md:mx-0">
      <div
        className={cn(
          'w-full max-w-4xl px-2 sm:px-3 md:px-0 transition-all duration-300 ease-out',
          hasScrolled ? 'scale-[0.98]' : 'scale-100'
        )}
      >
        <div
          className={cn(
            'mx-auto rounded-2xl transition-all duration-300 ease-out',
            hasScrolled
              ? 'px-2 md:px-3 border border-border/60 backdrop-blur-xl bg-background/80 shadow-lg shadow-black/[0.03]'
              : 'px-3 md:px-6 bg-transparent border border-transparent',
          )}
        >
          <div className="relative flex h-[56px] items-center p-2 md:p-4">
            {/* Left Section - Logo */}
            <div className="flex items-center justify-start flex-shrink-0">
              <Link href="/" className="flex items-center gap-3">
                <KortixLogo size={18} variant='logomark' />
              </Link>
            </div>

            {/* Center Section - Nav Links (absolutely centered) */}
            <nav className="hidden md:flex items-center justify-center gap-1 absolute left-1/2 -translate-x-1/2">
              {filteredNavLinks.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className={cn(
                    "px-3 py-1.5 text-sm font-medium rounded-lg transition-colors",
                    pathname === item.href
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {item.name}
                </Link>
              ))}
              
              {/* Mobile App Download with QR Popover */}
              <div className="relative group">
                <Link
                  href="/app"
                  className={cn(
                    "px-3 py-1.5 text-sm font-medium rounded-lg transition-colors",
                    pathname === '/app'
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Mobile
                </Link>
                
                {/* QR Code Popover - appears on hover */}
                <div className="absolute top-full left-1/2 -translate-x-1/2 pt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
                  {/* Arrow */}
                  <div className="absolute top-0.5 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#E8E8E8] dark:bg-[#1a1a1a] border-l border-t border-border/60 dark:border-[#2a2a2a] rotate-45" />
                  
                  <div className="relative bg-[#E8E8E8] dark:bg-[#1a1a1a] rounded-2xl border border-border/60 dark:border-[#2a2a2a] p-4 min-w-[200px]">
                    <AppDownloadQR size={160} logoSize={24} className="rounded-xl p-3 shadow-md" />
                    <p className="text-xs text-muted-foreground text-center mt-3">
                      Scan to download
                    </p>
                    <div className="flex items-center justify-center gap-1.5 mt-1.5">
                      <AppleLogo className="h-3 w-3 text-muted-foreground/60" />
                      <PlayIcon className="h-2.5 w-2.5 text-muted-foreground/60" />
                    </div>
                  </div>
                </div>
              </div>
            </nav>

            {/* Right Section - Actions */}
            <div className="flex items-center justify-end gap-2 sm:gap-3 ml-auto">
              {user ? (
                <Link
                  href="/dashboard"
                  className="h-8 px-4 text-sm font-medium rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors inline-flex items-center justify-center"
                >
                  Dashboard
                </Link>
              ) : (
                <Link
                  href={ctaLink}
                  onClick={() => trackCtaSignup()}
                  className="h-8 px-4 text-sm font-medium rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors inline-flex items-center justify-center"
                  suppressHydrationWarning
                >
                  {t('tryFree')}
                </Link>
              )}
              
              {/* Mobile Menu Button */}
              <button
                onClick={toggleDrawer}
                className="md:hidden p-2 rounded-lg hover:bg-accent transition-colors"
                aria-label="Open menu"
              >
                <Menu className="size-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {isDrawerOpen && (
          <>
            <motion.div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm"
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={overlayVariants}
              transition={{ duration: 0.2 }}
              onClick={handleOverlayClick}
            />

            <motion.div
              className="fixed inset-x-0 w-[95%] max-w-md mx-auto bottom-3 bg-background border border-border p-4 rounded-xl shadow-lg z-50"
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={drawerVariants}
            >
              {/* Mobile menu content */}
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <Link href="/" className="flex items-center gap-3" onClick={() => setIsDrawerOpen(false)}>
                    <KortixLogo size={20} variant='logomark' />
                  </Link>
                  <button
                    onClick={toggleDrawer}
                    className="border border-border rounded-lg p-1.5 cursor-pointer hover:bg-accent transition-colors"
                    aria-label="Close menu"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                <motion.ul
                  className="flex flex-col text-sm mb-4 border border-border rounded-md"
                  variants={drawerMenuContainerVariants}
                >
                  <AnimatePresence>
                    {filteredNavLinks.map((item) => (
                      <motion.li
                        key={item.id}
                        className="p-2.5 border-b border-border last:border-b-0"
                        variants={drawerMenuVariants}
                      >
                        <a
                          href={item.href}
                          onClick={(e) => {
                            // If it's an external link (not starting with #), let it navigate normally
                            if (!item.href.startsWith('#')) {
                              setIsDrawerOpen(false);
                              return;
                            }

                            e.preventDefault();

                            // If we're not on the homepage, redirect to homepage with the section
                            if (pathname !== '/') {
                              router.push(`/${item.href}`);
                              setIsDrawerOpen(false);
                              return;
                            }

                            const element = document.getElementById(
                              item.href.substring(1),
                            );
                            element?.scrollIntoView({ behavior: 'smooth' });
                            setIsDrawerOpen(false);
                          }}
                          className={`underline-offset-4 hover:text-primary/80 transition-colors ${(item.href.startsWith('#') && pathname === '/' && activeSection === item.href.substring(1)) || (item.href === pathname)
                            ? 'text-primary font-medium'
                            : 'text-primary/60'
                            }`}
                        >
                          {item.name}
                        </a>
                      </motion.li>
                    ))}
                    {/* Mobile App Link */}
                    <motion.li
                      className="p-2.5"
                      variants={drawerMenuVariants}
                    >
                      <Link
                        href="/app"
                        onClick={() => setIsDrawerOpen(false)}
                        className={`underline-offset-4 hover:text-primary/80 transition-colors ${
                          pathname === '/app'
                            ? 'text-primary font-medium'
                            : 'text-primary/60'
                        }`}
                      >
                        Mobile App
                      </Link>
                    </motion.li>
                  </AnimatePresence>
                </motion.ul>

                {/* Action buttons */}
                <div className="flex flex-col gap-3">
                  {user ? (
                    <Link
                      href="/dashboard"
                      className="w-full h-10 text-sm font-medium rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors inline-flex items-center justify-center"
                      onClick={() => setIsDrawerOpen(false)}
                    >
                      Dashboard
                    </Link>
                  ) : (
                    <Link
                      href={ctaLink}
                      onClick={() => {
                        trackCtaSignup();
                        setIsDrawerOpen(false);
                      }}
                      className="w-full h-10 text-sm font-medium rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors inline-flex items-center justify-center"
                      suppressHydrationWarning
                    >
                      {t('tryFree')}
                    </Link>
                  )}
                  
                  {/* Theme Toggle */}
                  <div className="flex justify-end">
                    <ThemeToggle />
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </header>
  );
}

