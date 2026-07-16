'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Disclosure,
  DisclosureBody,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import { Button, marketingButtonVariants } from '@/components/ui/marketing/button';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { Icon } from '@/features/icon/icon';
import { useAuth } from '@/features/providers/auth-provider';
import { useIsMobile } from '@/hooks/utils';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { siteConfig } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import { ChevronRight, Layers, Menu, Type, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';

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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [hasScrolled, setHasScrolled] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');
  const lastScrollY = useRef(0);
  const isMobile = useIsMobile();

  // Use-cases section is on by default; hide it by setting NEXT_PUBLIC_USE_CASES_ENABLED=false.
  const filteredNavLinks = siteConfig.nav.links.filter(
    (link) =>
      process.env.NEXT_PUBLIC_USE_CASES_ENABLED !== 'false' || link.href !== '/use-cases',
  );
  const { formattedStars, loading: starsLoading } = useGitHubStars('kortix-ai', 'kortix');
  const openDemo = useRequestDemo();

  const isNavActive = useCallback(
    (href: string) =>
      href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`),
    [pathname],
  );

  const compareIcon = (slug: string) => {
    switch (slug) {
      case 'zapier':
        return <Icon.Zapier />;
      case 'openclaw':
        return <Icon.OpenClaw />;
      case 'viktor':
        return <Icon.Viktor />;
      case 'chatgpt':
        return <Icon.ChatGPT />;
      case 'claude':
        return <Icon.Claude />;
      default:
        return null;
    }
  };

  const handleScroll = useCallback(() => {
    const currentScrollY = window.scrollY;

    if (!hasScrolled && currentScrollY > SCROLL_THRESHOLD_DOWN) {
      setHasScrolled(true);
    } else if (hasScrolled && currentScrollY < SCROLL_THRESHOLD_UP) {
      setHasScrolled(false);
    }

    lastScrollY.current = currentScrollY;
  }, [hasScrolled]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (!isDrawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isDrawerOpen]);

  const toggleDrawer = () => setIsDrawerOpen((prev) => !prev);

  return (
    <>
      <header
        className={cn(
          'w-full px-5 pt-4 transition-colors duration-300',
          isAbsolute ? '' : 'sticky top-0 z-50',
          hasScrolled && 'bg-background/80 pb-2 backdrop-blur-xl',
        )}
      >
        <div className="mx-auto flex h-[52px] max-w-6xl items-center justify-between">
          <div className="flex flex-1 items-center gap-8">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <Link
                  href="/"
                  aria-label="Kortix home"
                  className="hit-area-4 flex shrink-0 items-center"
                >
                  <KortixLogo size={18} variant="logomark" />
                </Link>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-64">
                <ContextMenuSub>
                  <ContextMenuSubTrigger className="gap-2 text-sm">
                    <KortixLogo size={14} variant="symbol" />
                    {tHardcodedUi.raw('componentsHomeNavbar.line221JsxTextDownloadSymbol')}
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
                        className="cursor-pointer text-sm"
                      >
                        {d.label}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSub>
                  <ContextMenuSubTrigger className="gap-2 text-sm">
                    <Type className="size-3.5 shrink-0" />
                    {tHardcodedUi.raw('componentsHomeNavbar.line239JsxTextDownloadWordmark')}
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
                        className="cursor-pointer text-sm"
                      >
                        {d.label}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuItem
                  onClick={() => router.push('/design-system')}
                  className="cursor-pointer gap-2 text-sm"
                >
                  <Layers className="size-3.5 shrink-0" />
                  {tHardcodedUi.raw('componentsHomeNavbar.line259JsxTextDesignSystem')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            <nav className="hidden items-center justify-center gap-2 md:flex">
              {filteredNavLinks.map((item) =>
                typeof item.href === 'string' ? (
                  <Button
                    key={item.id}
                    variant="ghost"
                    size="sm"
                    asChild
                    className={cn(
                      'font-medium',
                      isNavActive(item.href)
                        ? 'text-foreground'
                        : 'text-foreground/90 hover:text-foreground',
                    )}
                  >
                    <Link href={item.href}>{item.name}</Link>
                  </Button>
                ) : (
                  <NavigationMenu key={item.id} viewport={false} className="max-w-none flex-none">
                    <NavigationMenuList>
                      <NavigationMenuItem>
                        <NavigationMenuTrigger
                          className={cn(
                            marketingButtonVariants({ variant: 'ghost', size: 'sm' }),
                            'font-medium',
                            item.href.some((link) => isNavActive(link.href))
                              ? 'text-foreground'
                              : 'text-foreground/90 hover:text-foreground data-[state=open]:text-foreground',
                          )}
                        >
                          {item.name}
                        </NavigationMenuTrigger>
                        <NavigationMenuContent className="min-w-56">
                          {item.href.map((link) => (
                            <NavigationMenuLink key={link.href} asChild>
                              <Link
                                href={link.href}
                                className={cn(
                                  'flex flex-row items-center justify-start gap-2',
                                  isNavActive(link.href) && 'bg-accent/50 text-accent-foreground',
                                )}
                              >
                                {item.name === 'Compare' &&
                                  compareIcon(link.href.split('/').pop() || '')}
                                {link.name}
                              </Link>
                            </NavigationMenuLink>
                          ))}
                        </NavigationMenuContent>
                      </NavigationMenuItem>
                    </NavigationMenuList>
                  </NavigationMenu>
                ),
              )}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {formattedStars && !starsLoading && (
              <Button variant="ghost" asChild className="hidden sm:flex">
                <Link
                  href="https://github.com/kortix-ai/suna"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon.Github className="size-3.5" />
                  <span className={cn('font-medium tabular-nums', starsLoading && 'opacity-50')}>
                    {formattedStars}
                  </span>
                </Link>
              </Button>
            )}

            <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => openDemo()}>
              {tHardcodedUi.raw('componentsHomeNavbar.line301JsxTextRequestDemo')}
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
                {tHardcodedUi.raw('componentsHomeNavbar.line312JsxTextGetStarted')}
              </Button>
            )}

            <Button
              onClick={toggleDrawer}
              variant="ghost"
              size="icon"
              className="rounded-full md:hidden"
              aria-label={tHardcodedUi.raw('componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu')}
            >
              <Menu className="size-5" />
            </Button>
          </div>
        </div>
      </header>
      <AnimatePresence>
        {isDrawerOpen && isMobile && (
          <motion.div
            className="bg-background fixed inset-0 z-50 flex flex-col md:hidden"
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={drawerVariants}
          >
            <div className="bg-background flex min-h-dvh flex-1 flex-col px-5 pt-4 pb-5">
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

              <motion.nav className="flex-1 space-y-6 p-2" variants={drawerMenuContainerVariants}>
                <ul className="flex flex-col gap-6">
                  {filteredNavLinks.map((item) => {
                    const handleDrawerNavClick =
                      (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
                        if (!href.startsWith('#')) {
                          setIsDrawerOpen(false);
                          return;
                        }
                        e.preventDefault();
                        if (pathname !== '/') {
                          router.push(`/${href}`);
                          setIsDrawerOpen(false);
                          return;
                        }
                        const element = document.getElementById(href.substring(1));
                        element?.scrollIntoView({ behavior: 'smooth' });
                        setIsDrawerOpen(false);
                      };

                    if (typeof item.href === 'string') {
                      return (
                        <motion.li key={item.id} variants={drawerMenuVariants}>
                          <Link
                            href={item.href}
                            onClick={handleDrawerNavClick(item.href)}
                            className={cn(
                              'group flex items-center justify-between text-2xl',
                              isNavActive(item.href)
                                ? 'text-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {item.name}

                            <ChevronRight className="size-8 shrink-0 opacity-0 transition-transform group-hover:opacity-100" />
                          </Link>
                        </motion.li>
                      );
                    }

                    return (
                      <motion.li key={item.id} variants={drawerMenuVariants}>
                        <Disclosure
                          className="group w-full"
                          open={item.href.some((link) => isNavActive(link.href))}
                        >
                          <DisclosureTrigger>
                            <button
                              type="button"
                              className={cn(
                                'group/trigger flex w-full items-center justify-between text-2xl',
                                item.href.some((link) => isNavActive(link.href))
                                  ? 'text-foreground'
                                  : 'text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {item.name}
                              <ChevronRight className="size-8 shrink-0 transition-transform group-aria-expanded/trigger:rotate-90" />
                            </button>
                          </DisclosureTrigger>
                          <DisclosureContent>
                            <DisclosureBody className="p-0 pt-4">
                              <ul className="flex flex-col gap-4">
                                {item.href.map((link) => (
                                  <li key={link.href}>
                                    <Link
                                      href={link.href}
                                      onClick={handleDrawerNavClick(link.href)}
                                      className={cn(
                                        'group flex items-center justify-between text-xl',
                                        isNavActive(link.href)
                                          ? 'text-foreground'
                                          : 'text-muted-foreground hover:text-foreground',
                                      )}
                                    >
                                      {link.name}
                                      <ChevronRight className="size-6 shrink-0 opacity-0 transition-transform group-hover:opacity-100" />
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            </DisclosureBody>
                          </DisclosureContent>
                        </Disclosure>
                      </motion.li>
                    );
                  })}
                </ul>
              </motion.nav>

              <motion.div
                className="mt-auto flex flex-col gap-4"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.3 }}
              >
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
                      {tI18nHardcoded.raw('autoComponentsHomeNavbarJsxTextLaunchKortix5c2db556')}
                    </Link>
                  </Button>
                )}
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
