'use client';

import { ProductMenu } from '@/components/home/product-menu';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Button, marketingButtonVariants } from '@/components/ui/marketing/button';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import { errorToast, successToast } from '@/components/ui/toast';
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
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { type NavLink, type NavSubLink, siteConfig } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import {
  ArrowRightIcon,
  DiscordLogoIcon,
  DownloadSimpleIcon as Download,
  GithubLogoIcon,
  StackIcon as Layers,
  LinkedinLogoIcon,
  ListIcon as Menu,
  TextTIcon as Type,
  XIcon as X,
  XLogoIcon,
} from '@phosphor-icons/react';
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

/**
 * The drawer is deliberately static: tapping the menu button swaps it in the
 * same frame, with no enter motion, no level pushes, no stagger. Rows keep a
 * `py` tall enough for a 40px+ hit area at this type size.
 */
const DRAWER_ROW = 'flex items-center py-2 text-lg font-medium transition-colors';

const DRAWER_SOCIALS = [
  { label: 'X', href: 'https://x.com/kortix', icon: XLogoIcon },
  { label: 'LinkedIn', href: 'https://linkedin.com/company/kortix', icon: LinkedinLogoIcon },
  { label: 'Discord', href: 'https://discord.com/invite/RvFhXUdZ9H', icon: DiscordLogoIcon },
  { label: 'GitHub', href: 'https://github.com/kortix-ai/suna', icon: GithubLogoIcon },
] as const;

interface NavbarProps {
  isAbsolute?: boolean;
}

export function Navbar({ isAbsolute = false }: NavbarProps) {
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

  // "Brandmark" is the symbol, "Logomark" is the wordmark (the brandkit's own
  // naming). The copied color follows the active theme so pasting into a
  // matching canvas is legible immediately.
  const copyBrandSvg = async (kind: 'symbol' | 'wordmark') => {
    const color = document.documentElement.classList.contains('dark') ? 'White' : 'Black';
    const path =
      kind === 'symbol'
        ? `/brandkit/Logo/Brandmark/SVG/Brandmark ${color}.svg`
        : `/brandkit/Logo/Logomark/SVG/Logomark ${color}.svg`;
    try {
      const svg = await (await fetch(path)).text();
      await navigator.clipboard.writeText(svg);
      successToast(tHardcodedUi.raw('componentsHomeNavbar.svgCopied'));
    } catch {
      errorToast(tHardcodedUi.raw('componentsHomeNavbar.copyFailed'));
    }
  };

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

  const toggleDrawer = () => setIsDrawerOpen((prev) => !prev);

  // Anchor links scroll in place on the home page; everything else navigates.
  // Either way the sheet closes.
  const handleDrawerNavClick = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
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

  // One flat drawer: links that navigate directly, then one labelled group per
  // menu (Product, Company) — no second level to push into.
  const directDrawerLinks = filteredNavLinks.filter(
    (item): item is Extract<NavLink, { href: string }> =>
      !('menu' in item) && typeof item.href === 'string',
  );
  const groupedDrawerLinks = filteredNavLinks.filter((item) => drawerSubLinks(item).length > 0);

  return (
    <>
      <header
        className={cn(
          'border-border-default bg-background fixed relative inset-x-0 top-0 z-50 flex h-16 w-full flex-col items-center justify-between border-b transition-all duration-300 ease-out motion-reduce:transition-none',
        )}
      >
        <div
          className={cn(
            CONTENT_MEASURE,
            'relative flex h-full w-full items-center justify-between',
            'transition-[height] duration-300 ease-out motion-reduce:transition-none',
          )}
        >
          <div className="flex flex-1 items-center gap-8">
            <ContextMenu>
              <ContextMenuTrigger asChild className="group/kortix-logo">
                <Link
                  href="/"
                  aria-label="Kortix home"
                  className="hit-area-4 group-data-[state=open]/kortix-logo:bg-secondary group-data-[state=open]/kortix-logo:text-foreground flex shrink-0 items-center"
                >
                  <KortixLogo size={15} variant="logomark" />
                </Link>
              </ContextMenuTrigger>
              {/* Interfere-style brand menu: three flat actions, no submenus.
                  Copy puts the theme-matching SVG source on the clipboard;
                  download hands over the whole brandkit as one zip. */}
              <ContextMenuContent className="w-56">
                <ContextMenuItem
                  onClick={() => copyBrandSvg('symbol')}
                  className="cursor-pointer gap-2 text-sm"
                >
                  <KortixLogo size={14} variant="symbol" className="text-foreground" />
                  {tHardcodedUi.raw('componentsHomeNavbar.copySymbolSvg')}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => copyBrandSvg('wordmark')}
                  className="cursor-pointer gap-2 text-sm"
                >
                  <Type className="size-3.5 shrink-0" />
                  {tHardcodedUi.raw('componentsHomeNavbar.copyWordmarkSvg')}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = '/brandkit/kortix-brand-assets.zip';
                    a.download = 'kortix-brand-assets.zip';
                    a.click();
                  }}
                  className="cursor-pointer gap-2 text-sm"
                >
                  <Download className="size-3.5 shrink-0" />
                  {tHardcodedUi.raw('componentsHomeNavbar.downloadBrandAssets')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => router.push('/design-system')}
                  className="cursor-pointer gap-2 text-sm"
                >
                  <Layers className="size-3.5 shrink-0" />
                  {tHardcodedUi.raw('componentsHomeNavbar.line259JsxTextDesignSystem')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            <nav className="hidden items-center justify-center gap-1 md:flex">
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
                      'h-8 px-3 font-medium [&>svg]:hidden',
                      'data-[state=open]:bg-secondary data-[state=open]:text-foreground data-[state=open]:hover:bg-secondary text-md',
                      isNavActive(item.href)
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
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
                            'h-8 px-3 font-medium [&>svg]:hidden',
                            'data-[state=open]:bg-secondary data-[state=open]:text-foreground data-[state=open]:hover:bg-secondary text-md',
                            item.href.some((link) => isNavActive(link.href))
                              ? 'bg-secondary text-foreground'
                              : 'text-muted-foreground hover:text-foreground',
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

          <div className="flex shrink-0 items-center gap-2">
            {/* `stars`, not `formattedStars`: the formatter returns an en dash
                for a missing count, so keying on it printed a GitHub chip
                reading "–" whenever /api/github-stars failed. No number, no
                chip. */}
            {stars !== null && !starsLoading && (
              <Button variant="ghost" size="sm" asChild className="hidden sm:flex">
                <Link
                  href="https://github.com/kortix-ai/suna"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Github className="size-4 text-foreground" />
                  <span className={cn('font-medium text-foreground tabular-nums', starsLoading && 'opacity-50')}>
                    {formattedStars}
                  </span>
                </Link>
              </Button>
            )}

            {user ? (
              <Button size="sm" onClick={() => router.push(latestProjectPath(user.id))}>
                Projects
              </Button>
            ) : (
              <Button
                size="sm"
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
              size="icon-sm"
              className="md:hidden"
              aria-label={tHardcodedUi.raw('componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu')}
            >
              <Menu className="size-5" />
            </Button>
          </div>
        </div>
      </header>
      {/* Static full-screen drawer: appears and disappears in the same frame
          as the tap — no scrim, no card inset, no motion. */}
      {isDrawerOpen && isMobile && (
        <div className="bg-background fixed inset-0 z-50 flex flex-col md:hidden">
          {/* Header mirrors the bar: logo left, close where the menu button was. */}
          <div
            className={cn(CONTENT_MEASURE, 'flex h-16 shrink-0 items-center justify-between pr-4')}
          >
            <Link
              href="/"
              aria-label="Kortix home"
              onClick={() => setIsDrawerOpen(false)}
              className="flex items-center"
            >
              <KortixLogo size={15} variant="logomark" />
            </Link>
            <Button
              onClick={toggleDrawer}
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label={tHardcodedUi.raw('componentsHomeNavbar.line348JsxAttrAriaLabelCloseMenu')}
            >
              <X className="size-5" />
            </Button>
          </div>

          {/* One flat list: direct links first, then a labelled group per menu. */}
          <nav className="min-h-0 flex-1 overflow-y-auto px-6">
            <ul className="flex flex-col">
              <li>
                <Link
                  href="/"
                  onClick={handleDrawerNavClick('/')}
                  className={cn(
                    DRAWER_ROW,
                    isNavActive('/')
                      ? 'text-foreground'
                      : 'text-muted-foreground active:text-foreground',
                  )}
                >
                  {tHardcodedUi.raw('componentsHomeNavbar.home')}
                </Link>
              </li>
              {directDrawerLinks.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    onClick={handleDrawerNavClick(item.href)}
                    className={cn(
                      DRAWER_ROW,
                      isNavActive(item.href)
                        ? 'text-foreground'
                        : 'text-muted-foreground active:text-foreground',
                    )}
                  >
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
            {groupedDrawerLinks.map((item) => (
              <div key={item.id} className="mt-6">
                <p className="text-muted-foreground/70 text-xs font-medium tracking-wider uppercase">
                  {item.name}
                </p>
                <ul className="mt-1 flex flex-col">
                  {drawerSubLinks(item).map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        onClick={handleDrawerNavClick(link.href)}
                        {...(link.external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
                        className={cn(
                          DRAWER_ROW,
                          isNavActive(link.href)
                            ? 'text-foreground'
                            : 'text-muted-foreground active:text-foreground',
                        )}
                      >
                        {link.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          {/* Footer: demo pill, hairline, socials, login. */}
          <div className="shrink-0 space-y-3 px-6 pb-6">
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={() => {
                setIsDrawerOpen(false);
                openDemo();
              }}
            >
              {tHardcodedUi.raw('componentsHomeNavbar.line301JsxTextRequestDemo')}
            </Button>

            {user ? (
              <button
                type="button"
                onClick={() => {
                  setIsDrawerOpen(false);
                  router.push(latestProjectPath(user.id));
                }}
                className="text-muted-foreground active:text-foreground flex items-center gap-1.5 text-base transition-colors"
              >
                Projects
                <ArrowRightIcon className="size-4" />
              </button>
            ) : (
              <Button size="lg" className="w-full" asChild>
                <Link
                  href={CTA_LINK}
                  onClick={() => {
                    trackCtaSignup();
                    setIsDrawerOpen(false);
                  }}
                  className="w-full"
                >
                  {tHardcodedUi.raw('componentsHomeNavbar.logIn')}
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
