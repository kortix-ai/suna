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
import { isMobileDevice } from '@/lib/utils/is-mobile-device';
import { AppDownloadQR } from '@/components/common/app-download-qr';

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
                  <div className="absolute top-0.5 left-1/2 -translate-x-1/2 w-2 h-2 bg-white dark:bg-[#1a1a1a] border-l border-t border-border/60 dark:border-[#2a2a2a] rotate-45" />
                  
                  <div className="relative bg-white dark:bg-[#1a1a1a] rounded-2xl shadow-2xl border border-border/60 dark:border-[#2a2a2a] p-4 min-w-[200px]">
                    <AppDownloadQR size={160} logoSize={24} className="rounded-xl p-3 shadow-md" />
                    <p className="text-xs text-muted-foreground text-center mt-3">
                      Scan to download
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 text-center mt-0.5">
                      iOS & Android
                    </p>
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

