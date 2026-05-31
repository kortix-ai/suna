'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { siteConfig } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import { X, Menu, Type, Layers, Gem, ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useRouter, usePathname } from 'next/navigation';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { useTranslations } from 'next-intl';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { AppDownloadQR } from '@/components/common/app-download-qr';
import { Button } from '@/components/ui/marketing/button';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { ProductMegaMenu, PRODUCT_ITEMS } from '@/components/home/product-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { Icon } from '@/features/icon/icon';
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import { useIsMobile } from '@/hooks/utils';

const SCROLL_THRESHOLD_DOWN = 50;
const SCROLL_THRESHOLD_UP = 20;

const CTA_LINK = '/auth';

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
  hidden: { opacity: 0, x: -10 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0,
      ease: 'easeOut' as const,
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
  const [activeSection, setActiveSection] = useState('hero');
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');
  const lastScrollY = useRef(0);
  const isMobile = useIsMobile();

  const filteredNavLinks = siteConfig.nav.links;
  const { formattedStars, loading: starsLoading } = useGitHubStars(
    'kortix-ai',
    'kortix',
  );

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
    <header
      className={cn(
        'w-full px-5 pt-4 transition-colors duration-300',
        isAbsolute ? '' : 'sticky top-0 z-50',
        hasScrolled && 'bg-background/80 backdrop-blur-xl pb-2',
      )}
    >
      <div className="flex items-center max-w-6xl mx-auto justify-between h-[52px]">
        <div className="flex items-center gap-12 flex-1">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <Link href="/" className="flex items-center shrink-0">
                <KortixLogo
                  size={isMobile ? 24 : 18}
                  variant={isMobile ? 'symbol' : 'logomark'}
                />
              </Link>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-64">
              <ContextMenuSub>
                <ContextMenuSubTrigger className="gap-2 text-sm">
                  <KortixLogo size={14} variant="symbol" />
                  {tHardcodedUi.raw(
                    'componentsHomeNavbar.line221JsxTextDownloadSymbol',
                  )}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-40">
                  {[
                    {
                      label: 'Black · SVG',
                      href: '/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg',
                      file: 'kortix-symbol-black.svg',
                    },
                    {
                      label: 'Black · PNG',
                      href: '/brandkit/Logo/Brandmark/PNG/Brandmark Black.png',
                      file: 'kortix-symbol-black.png',
                    },
                    {
                      label: 'White · SVG',
                      href: '/brandkit/Logo/Brandmark/SVG/Brandmark White.svg',
                      file: 'kortix-symbol-white.svg',
                    },
                    {
                      label: 'White · PNG',
                      href: '/brandkit/Logo/Brandmark/PNG/Brandmark White.png',
                      file: 'kortix-symbol-white.png',
                    },
                  ].map((d) => (
                    <ContextMenuItem
                      key={d.file}
                      onClick={() => {
                        const a = document.createElement('a');
                        a.href = d.href;
                        a.download = d.file;
                        a.click();
                      }}
                      className="text-sm cursor-pointer"
                    >
                      {d.label}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSub>
                <ContextMenuSubTrigger className="gap-2 text-sm">
                  <Type className="size-3.5 shrink-0" />
                  {tHardcodedUi.raw(
                    'componentsHomeNavbar.line239JsxTextDownloadWordmark',
                  )}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-40">
                  {[
                    {
                      label: 'Black · SVG',
                      href: '/brandkit/Logo/Logomark/SVG/Logomark Black.svg',
                      file: 'kortix-logo-black.svg',
                    },
                    {
                      label: 'Black · PNG',
                      href: '/brandkit/Logo/Logomark/PNG/Logomark Black.png',
                      file: 'kortix-logo-black.png',
                    },
                    {
                      label: 'White · SVG',
                      href: '/brandkit/Logo/Logomark/SVG/Logomark White.svg',
                      file: 'kortix-logo-white.svg',
                    },
                    {
                      label: 'White · PNG',
                      href: '/brandkit/Logo/Logomark/PNG/Logomark White.png',
                      file: 'kortix-logo-white.png',
                    },
                  ].map((d) => (
                    <ContextMenuItem
                      key={d.file}
                      onClick={() => {
                        const a = document.createElement('a');
                        a.href = d.href;
                        a.download = d.file;
                        a.click();
                      }}
                      className="text-sm cursor-pointer"
                    >
                      {d.label}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuItem
                onClick={() => router.push('/design-system')}
                className="gap-2 text-sm cursor-pointer"
              >
                <Layers className="size-3.5 shrink-0" />
                {tHardcodedUi.raw(
                  'componentsHomeNavbar.line259JsxTextDesignSystem',
                )}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          <nav className="hidden md:flex items-center justify-center gap-2  ">
            <ProductMegaMenu />
            {filteredNavLinks.map((item) => (
              <Button
                variant="ghost"
                size="sm"
                asChild
                className={cn(
                  pathname === item.href
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Link key={item.id} href={item.href}>
                  {item.name}
                </Link>
              </Button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button variant="ghost" asChild className="hidden sm:flex">
            <Link
              href="https://github.com/kortix-ai/suna"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon.Github className="size-3.5" />
              <span
                className={cn(
                  'font-medium tabular-nums',
                  starsLoading && 'opacity-50',
                )}
              >
                {formattedStars}
              </span>
            </Link>
          </Button>

          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <Link href="/enterprise">
              {tHardcodedUi.raw(
                'componentsHomeNavbar.line301JsxTextRequestDemo',
              )}
            </Link>
          </Button>
          {user ? (
            <Button asChild>
              <Link href="/projects">Projects</Link>
            </Button>
          ) : (
            <Button
              onClick={() => {
                trackCtaSignup();
                router.push(CTA_LINK);
              }}
            >
              {tHardcodedUi.raw(
                'componentsHomeNavbar.line312JsxTextGetStarted',
              )}
            </Button>
          )}

          <Button
            onClick={toggleDrawer}
            variant="ghost"
            size="icon"
            className="md:hidden rounded-full"
            aria-label={tHardcodedUi.raw(
              'componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu',
            )}
          >
            <Menu className="size-5" />
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {isDrawerOpen && isMobile && (
          <motion.div
            className="fixed inset-0 bg-background z-50 flex flex-col pt-4 pb-5 px-5 md:hidden"
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={drawerVariants}
          >
            <div className="flex h-[56px] items-center justify-end">
              <Button
                onClick={toggleDrawer}
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={tHardcodedUi.raw(
                  'componentsHomeNavbar.line348JsxAttrAriaLabelCloseMenu',
                )}
              >
                <X className="size-5" />
              </Button>
            </div>

            <motion.nav
              className="flex-1 p-2 space-y-6"
              variants={drawerMenuContainerVariants}
            >
              <ul className="flex flex-col gap-6">
                {filteredNavLinks.map((item) => (
                  <motion.li key={item.id} variants={drawerMenuVariants}>
                    <Link
                      href={item.href}
                      onClick={(e) => {
                        if (!item.href.startsWith('#')) {
                          setIsDrawerOpen(false);
                          return;
                        }
                        e.preventDefault();
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
                      className={cn(
                        // 'block py-3 text-4xl font-medium tracking-tight transition-colors',
                        'group text-2xl flex items-center justify-between',
                        (item.href.startsWith('#') &&
                          pathname === '/' &&
                          activeSection === item.href.substring(1)) ||
                          item.href === pathname
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {item.name}

                      <ChevronRight className="size-8  shrink-0 transition-transform  opacity-0 group-hover:opacity-100 " />
                    </Link>
                  </motion.li>
                ))}
              </ul>

              <motion.div variants={drawerMenuVariants}>
                <Disclosure className="group">
                  <DisclosureTrigger>
                    <button
                      type="button"
                      className="group text-2xl flex items-center  w-full justify-between  text-muted-foreground group-data-[state=open]:text-foreground"
                    >
                      Product
                      <ChevronRight className="size-8 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                    </button>
                  </DisclosureTrigger>
                  <DisclosureContent>
                    <ul className="flex flex-col pt-2">
                      {PRODUCT_ITEMS.map((item) => {
                        const Icon = item.icon;
                        return (
                          <li key={item.title}>
                            <Link
                              href={item.href}
                              onClick={() => setIsDrawerOpen(false)}
                              className="flex items-center gap-3 py-2.5 text-xl font-medium text-muted-foreground transition-colors hover:text-foreground"
                            >
                              <Icon className="size-5 shrink-0" />
                              {item.title}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </DisclosureContent>
                </Disclosure>
              </motion.div>
            </motion.nav>

            <motion.div
              className="flex flex-col gap-4  mt-auto"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.3 }}
            >
              <ThemeToggle />

              {user ? (
                <Button asChild size="xl" className="w-full text-lg">
                  <Link href="/projects" onClick={() => setIsDrawerOpen(false)}>
                    Projects
                  </Link>
                </Button>
              ) : (
                <Button asChild size="xl" className="w-full text-lg">
                  <Link
                    href={CTA_LINK}
                    onClick={() => {
                      trackCtaSignup();
                      setIsDrawerOpen(false);
                    }}
                    suppressHydrationWarning
                  >
                    {t('tryFree')}
                  </Link>
                </Button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
