'use client';

import { ProductMenu } from '@/components/home/product-menu';
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
import { ChatGPT } from '@/features/icon/icons/chat-gpt';
import { Claude } from '@/features/icon/icons/claude';
import { Github } from '@/features/icon/icons/github';
import { OpenClaw } from '@/features/icon/icons/open-claw';
import { Viktor } from '@/features/icon/icons/viktor';
import { Zapier } from '@/features/icon/icons/zapier';
import { useAuth } from '@/features/providers/auth-provider';
import { useIsMobile } from '@/hooks/utils';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { type NavLink, type NavSubLink, siteConfig } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import {
  CaretDownIcon,
  StackIcon as Layers,
  ListIcon as Menu,
  TextTIcon as Type,
  XIcon as X,
} from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent, useCallback, useEffect, useState } from 'react';

const SCROLL_THRESHOLD_DOWN = 50;
const SCROLL_THRESHOLD_UP = 20;

const CTA_LINK = '/auth';

/**
 * Scroll compaction — height only.
 *
 * At the top of the page the bar breathes. Once the reader scrolls it tucks in:
 * the outer padding drops from 14.72px to 5.52px and the row from 52px to 40px,
 * taking the bar from 66.7px to 51.0px (-23.5%).
 *
 * Nothing moves horizontally. The measure, the logo/nav gap, and every button
 * size are identical in both states, so the only thing that animates is the
 * vertical rhythm — the bar tightens around its contents instead of rearranging
 * them.
 */
const BAR_TOP_PAD = { rest: 'pt-4', compact: 'pt-1.5' } as const;
const BAR_ROW_HEIGHT = { rest: 'h-[52px]', compact: 'h-[40px]' } as const;

/**
 * The marketing sections all sit on `mx-auto max-w-7xl px-6`. The bar's surface
 * still spans the viewport, but its contents ride the exact same measure, so the
 * logo's left edge and the CTA's right edge line up with the section text below.
 */
const CONTENT_MEASURE = 'mx-auto w-full max-w-7xl px-6';

/**
 * The scrolled surface is a blur veil, not a bar with an edge. It extends 22px
 * past the header and its mask fades the blur out over that overhang, so the
 * frosted panel dissolves into the page instead of ending on a line. The row
 * content sits in the fully-opaque top of the mask, so nothing behind the logo
 * or the buttons is ever half-blurred.
 */
const BAR_VEIL_MASK = '[mask-image:linear-gradient(to_bottom,#000_0%,#000_72%,transparent_100%)]';

/** The links a drawer row expands to; empty for a row that simply navigates. */
function drawerSubLinks(item: NavLink): NavSubLink[] {
  if ('menu' in item) return item.menu.columns.flatMap((column) => column.links);
  return typeof item.href === 'string' ? [] : item.href;
}

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
  const [openDrawerMenu, setOpenDrawerMenu] = useState<number | null>(null);
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');
  const isMobile = useIsMobile();

  const filteredNavLinks = siteConfig.nav.links;
  const { stars, formattedStars, loading: starsLoading } = useGitHubStars('kortix-ai', 'kortix');
  const openDemo = useRequestDemo();

  const isNavActive = useCallback(
    (href: string) =>
      href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`),
    [pathname],
  );

  const compareIcon = (slug: string) => {
    switch (slug) {
      case 'zapier':
        return <Zapier />;
      case 'openclaw':
        return <OpenClaw />;
      case 'viktor':
        return <Viktor />;
      case 'chatgpt':
        return <ChatGPT />;
      case 'claude':
        return <Claude />;
      default:
        return null;
    }
  };

  // Asymmetric thresholds: the bar compacts at 50px and only expands again below
  // 20px, so a reader hovering around the trigger point never sees it flicker.
  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      setHasScrolled((wasScrolled) =>
        wasScrolled
          ? currentScrollY >= SCROLL_THRESHOLD_UP
          : currentScrollY > SCROLL_THRESHOLD_DOWN,
      );
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!isDrawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isDrawerOpen]);

  // The drawer expands one section at a time, seeded with the one holding the
  // current page. An accordion is what keeps it from outgrowing a phone screen:
  // every menu open at once is three groups of up to nine links.
  useEffect(() => {
    if (!isDrawerOpen) return;
    const active = filteredNavLinks.find((item) =>
      drawerSubLinks(item).some((link) => isNavActive(link.href)),
    );
    setOpenDrawerMenu(active ? active.id : null);
  }, [isDrawerOpen, filteredNavLinks, isNavActive]);

  const toggleDrawer = () => setIsDrawerOpen((prev) => !prev);

  const barTopPad = hasScrolled ? BAR_TOP_PAD.compact : BAR_TOP_PAD.rest;
  const barRowHeight = hasScrolled ? BAR_ROW_HEIGHT.compact : BAR_ROW_HEIGHT.rest;

  return (
    <>
      <header
        className={cn(
          'relative w-full',
          'transition-[padding] duration-300 ease-out motion-reduce:transition-none',
          isAbsolute ? '' : 'sticky top-0 z-50',
          barTopPad,
          hasScrolled && 'pb-1.5',
        )}
      >
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 -bottom-6',
            'bg-background/55 backdrop-blur-xl',
            BAR_VEIL_MASK,
            'transition-opacity duration-500 ease-out motion-reduce:transition-none',
            hasScrolled ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          className={cn(
            CONTENT_MEASURE,
            'relative flex items-center justify-between',
            'transition-[height] duration-300 ease-out motion-reduce:transition-none',
            barRowHeight,
          )}
        >
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
                    <KortixLogo size={14} variant="symbol" className="text-foreground" />
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
              {filteredNavLinks.map((item) => {
                if ('menu' in item) {
                  return (
                    <ProductMenu
                      key={item.id}
                      name={item.name}
                      menu={item.menu}
                      isNavActive={isNavActive}
                    />
                  );
                }

                return typeof item.href === 'string' ? (
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
                );
              })}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {/* `stars`, not `formattedStars`: the formatter returns an en dash
                for a missing count, so keying on it printed a GitHub chip
                reading "–" whenever /api/github-stars failed. No number, no
                chip. */}
            {stars !== null && !starsLoading && (
              <Button variant="ghost" asChild className="hidden rounded-md sm:flex">
                <Link
                  href="https://github.com/kortix-ai/suna"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Github className="size-3.5" />
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
            {/* The drawer reuses the bar's live measure, padding and row height,
                so the close button opens exactly on top of the menu button it
                replaces — whether the bar is at rest or compacted. */}
            <div
              className={cn('bg-background flex min-h-dvh flex-1 flex-col px-6 pb-5', barTopPad)}
            >
              <div className={cn('flex items-center justify-end', barRowHeight)}>
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

              {/* A scroll region, not a growing column: with three menus open-
                  able the link list can exceed a phone screen, and the CTA below
                  must stay reachable. */}
              <motion.nav
                className="min-h-0 flex-1 space-y-6 overflow-y-auto p-2"
                variants={drawerMenuContainerVariants}
              >
                <ul className="flex flex-col gap-6">
                  {filteredNavLinks.map((item) => {
                    const handleDrawerNavClick =
                      (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
                        const anchor = href.startsWith('#')
                          ? href.slice(1)
                          : href.startsWith('/#')
                            ? href.slice(2)
                            : null;

                        if (!anchor) {
                          setIsDrawerOpen(false);
                          return;
                        }
                        e.preventDefault();
                        if (pathname !== '/') {
                          router.push(`/#${anchor}`);
                          setIsDrawerOpen(false);
                          return;
                        }
                        const element = document.getElementById(anchor);
                        element?.scrollIntoView({ behavior: 'smooth' });
                        window.history.replaceState(null, '', `/#${anchor}`);
                        setIsDrawerOpen(false);
                      };

                    const staticHref =
                      'menu' in item ? null : typeof item.href === 'string' ? item.href : null;

                    if (staticHref) {
                      return (
                        <motion.li key={item.id} variants={drawerMenuVariants}>
                          {/* A row that navigates carries no glyph. Only the
                              rows that expand get an affordance, so the caret
                              always means "opens here". */}
                          <Link
                            href={staticHref}
                            onClick={handleDrawerNavClick(staticHref)}
                            className={cn(
                              'flex items-center text-2xl',
                              isNavActive(staticHref)
                                ? 'text-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {item.name}
                          </Link>
                        </motion.li>
                      );
                    }

                    const subLinks: NavSubLink[] = drawerSubLinks(item);

                    return (
                      <motion.li key={item.id} variants={drawerMenuVariants}>
                        <Disclosure
                          className="group w-full"
                          open={openDrawerMenu === item.id}
                          onOpenChange={(next) => setOpenDrawerMenu(next ? item.id : null)}
                        >
                          <DisclosureTrigger>
                            <button
                              type="button"
                              className={cn(
                                'group/trigger flex w-full items-center justify-between text-2xl',
                                subLinks.some((link) => isNavActive(link.href))
                                  ? 'text-foreground'
                                  : 'text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {item.name}
                              {/* One caret, and it points down: this row opens
                                  in place, it does not go anywhere. */}
                              <CaretDownIcon className="text-muted-foreground size-5 shrink-0 transition-transform duration-200 group-aria-expanded/trigger:rotate-180 motion-reduce:transition-none" />
                            </button>
                          </DisclosureTrigger>
                          <DisclosureContent>
                            <DisclosureBody className="p-0 pt-4">
                              <ul className="flex flex-col gap-4">
                                {subLinks.map((link) => (
                                  <li key={link.href}>
                                    <Link
                                      href={link.href}
                                      onClick={handleDrawerNavClick(link.href)}
                                      className={cn(
                                        'flex items-center text-xl',
                                        isNavActive(link.href)
                                          ? 'text-foreground'
                                          : 'text-muted-foreground hover:text-foreground',
                                      )}
                                    >
                                      {link.name}
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
