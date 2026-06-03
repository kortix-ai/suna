'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { siteConfig } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import { X, Menu, Type, Layers, Gem } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useRouter, usePathname } from 'next/navigation';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { useTranslations } from 'next-intl';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { Button } from '@/components/ui/button';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from '@/components/ui/context-menu';

// Scroll threshold with hysteresis to prevent flickering
const SCROLL_THRESHOLD_DOWN = 50;
const SCROLL_THRESHOLD_UP = 20;

const drawerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      duration: 0.2,
      staggerChildren: 0.05,
      delayChildren: 0.1,
    },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.15 },
  },
};

const drawerMenuContainerVariants = {
  hidden: { opacity: 0 },
  visible: { 
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
    },
  },
};

const drawerMenuVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: { 
    opacity: 1, 
    x: 0,
    transition: {
      duration: 0.3,
      ease: "easeOut" as const,
    },
  },
};

interface NavbarProps {
  isAbsolute?: boolean;
}

export function Navbar({ isAbsolute = false }: NavbarProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [hasScrolled, setHasScrolled] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const lastScrollY = useRef(0);

  const filteredNavLinks = siteConfig.nav.links;
  const { formattedStars, loading: starsLoading } = useGitHubStars('kortix-ai', 'kortix');

  const ctaLink = '/auth';

  // Highlight the nav item for the current route. '/' must match exactly;
  // every other route also matches its sub-paths (e.g. /docs/foo → Docs).
  const isNavActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');

  // Single unified scroll handler with hysteresis
  const handleScroll = useCallback(() => {
    const currentScrollY = window.scrollY;
    
    // Hysteresis: different thresholds for scrolling up vs down
    if (!hasScrolled && currentScrollY > SCROLL_THRESHOLD_DOWN) {
      setHasScrolled(true);
    } else if (hasScrolled && currentScrollY < SCROLL_THRESHOLD_UP) {
      setHasScrolled(false);
    }

    lastScrollY.current = currentScrollY;
  }, [hasScrolled]);

  useEffect(() => {
    // Use passive listener for better scroll performance
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // Initial check
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const toggleDrawer = () => setIsDrawerOpen((prev) => !prev);

  return (
    <header className={cn(
      "w-full px-5 pt-4 transition-colors duration-300",
      isAbsolute ? "" : "sticky top-0 z-50",
      hasScrolled && "bg-background/80 backdrop-blur-xl pb-2"
    )}>
      <div className="flex items-center justify-between h-[52px]">
        {/* Left — Logo (right-click for brand assets) */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Link href="/" className="flex items-center shrink-0">
              <KortixLogo size={18} variant='logomark' />
            </Link>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuSub>
              <ContextMenuSubTrigger className="gap-2 text-sm">
                <Gem className="size-3.5 shrink-0" />{tHardcodedUi.raw('componentsHomeNavbar.line221JsxTextDownloadSymbol')}</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-40">
                {[
                  { label: 'Black · SVG', href: '/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg', file: 'kortix-symbol-black.svg' },
                  { label: 'Black · PNG', href: '/brandkit/Logo/Brandmark/PNG/Brandmark Black.png', file: 'kortix-symbol-black.png' },
                  { label: 'White · SVG', href: '/brandkit/Logo/Brandmark/SVG/Brandmark White.svg', file: 'kortix-symbol-white.svg' },
                  { label: 'White · PNG', href: '/brandkit/Logo/Brandmark/PNG/Brandmark White.png', file: 'kortix-symbol-white.png' },
                ].map((d) => (
                  <ContextMenuItem key={d.file} onClick={() => { const a = document.createElement('a'); a.href = d.href; a.download = d.file; a.click(); }} className="text-sm cursor-pointer">
                    {d.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger className="gap-2 text-sm">
                <Type className="size-3.5 shrink-0" />{tHardcodedUi.raw('componentsHomeNavbar.line239JsxTextDownloadWordmark')}</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-40">
                {[
                  { label: 'Black · SVG', href: '/brandkit/Logo/Logomark/SVG/Logomark Black.svg', file: 'kortix-logo-black.svg' },
                  { label: 'Black · PNG', href: '/brandkit/Logo/Logomark/PNG/Logomark Black.png', file: 'kortix-logo-black.png' },
                  { label: 'White · SVG', href: '/brandkit/Logo/Logomark/SVG/Logomark White.svg', file: 'kortix-logo-white.svg' },
                  { label: 'White · PNG', href: '/brandkit/Logo/Logomark/PNG/Logomark White.png', file: 'kortix-logo-white.png' },
                ].map((d) => (
                  <ContextMenuItem key={d.file} onClick={() => { const a = document.createElement('a'); a.href = d.href; a.download = d.file; a.click(); }} className="text-sm cursor-pointer">
                    {d.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem
              onClick={() => router.push('/design-system')}
              className="gap-2 text-sm cursor-pointer"
            >
              <Layers className="size-3.5 shrink-0" />{tHardcodedUi.raw('componentsHomeNavbar.line259JsxTextDesignSystem')}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Center — Nav Links (desktop only) */}
        <nav className="hidden md:flex items-center justify-center gap-1 absolute left-1/2 -translate-x-1/2">
          {filteredNavLinks.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap",
                isNavActive(item.href)
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {item.name}
            </Link>
          ))}
        </nav>

        {/* Right — Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* GitHub stars (hidden on mobile) */}
          <a
            href="https://github.com/kortix-ai/suna"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            <span className={cn("font-medium tabular-nums", starsLoading && "opacity-50")}>
              {formattedStars}
            </span>
          </a>

          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/contact">{tHardcodedUi.raw('componentsHomeNavbar.line301JsxTextRequestDemo')}</Link>
          </Button>
          {user ? (
            <Button asChild size="sm">
              <Link href="/projects">Projects</Link>
            </Button>
          ) : (
            <Button
              onClick={() => { trackCtaSignup(); router.push(ctaLink); }}
              size="sm"
            >Launch Kortix</Button>
          )}

          {/* Mobile Menu Button */}
          <Button
            onClick={toggleDrawer}
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={tHardcodedUi.raw('componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu')}
          >
            <Menu className="size-5" />
          </Button>
        </div>
      </div>

      {/* Mobile Drawer - Full Screen */}
      <AnimatePresence>
        {isDrawerOpen && (
          <motion.div
            className="fixed inset-0 bg-background z-50 flex flex-col pt-4"
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={drawerVariants}
          >
            {/* Header - matches navbar positioning */}
            <div className="flex h-[56px] items-center justify-between px-6 py-2">
              <Link href="/" className="flex items-center gap-3" onClick={() => setIsDrawerOpen(false)}>
                <KortixLogo size={18} variant='logomark' />
              </Link>
              <Button
                onClick={toggleDrawer}
                variant="outline"
                size="icon"
                aria-label={tHardcodedUi.raw('componentsHomeNavbar.line348JsxAttrAriaLabelCloseMenu')}
              >
                <X className="size-5" />
              </Button>
            </div>

            {/* Navigation Links - Big Typography, Left Aligned */}
            <motion.nav
              className="flex-1 px-6 pt-8"
              variants={drawerMenuContainerVariants}
            >
              <ul className="flex flex-col gap-1">
                {filteredNavLinks.map((item) => (
                  <motion.li
                    key={item.id}
                    variants={drawerMenuVariants}
                  >
                    <Link
                      href={item.href}
                      onClick={() => setIsDrawerOpen(false)}
                      className={cn('block py-3 text-4xl font-medium tracking-tight transition-colors',
                        isNavActive(item.href)
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {item.name}
                    </Link>
                  </motion.li>
                ))}
              </ul>
            </motion.nav>

            {/* Footer Actions */}
            <div className="px-6 pb-8 mt-auto">
              <motion.div 
                className="flex flex-col gap-4"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.3 }}
              >
                {user ? (
                  <Button asChild size="lg" className="w-full h-14 text-lg">
                    <Link
                      href="/projects"
                      onClick={() => setIsDrawerOpen(false)}
                    >
                      Projects
                    </Link>
                  </Button>
                ) : (
                  <Button asChild size="lg" className="w-full h-14 text-lg">
                    <Link
                      href={ctaLink}
                      onClick={() => {
                        trackCtaSignup();
                        setIsDrawerOpen(false);
                      }}
                      suppressHydrationWarning
                    >
                      Launch Kortix
                    </Link>
                  </Button>
                )}
                
                {/* Theme Toggle */}
                <div className="flex items-center justify-between">
                  <ThemeToggle />
                </div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
