'use client';

import { MEGA_MENUS, type MegaMenu, MegaMenuPanel } from '@/components/home/product-menu';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import Link from '@/components/site-link';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { SiteSwitcher } from '@/features/marketing/kit/site-switcher';
import { useAuth } from '@/features/providers/auth-provider';
import { useGitHubStars } from '@/hooks/use-github-stars';
import { SITE_CONFIG_TRANSLATION_KEYS } from '@/i18n/site-config-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@kortix/ui';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@kortix/ui/context-menu';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { Download } from '@kortix/ui/internal/icons/download';
import { Github } from '@kortix/ui/internal/icons/github';
import { PROJECT_LANDING_PATH } from '@kortix/ui/internal/lib/onboarding/landing-destination';
import { latestProjectPath } from '@kortix/ui/internal/lib/onboarding/last-project-cookie';
import Loading from '@kortix/ui/loading';
import { errorToast, successToast } from '@kortix/ui/toast';
import {
  CaretDownIcon,
  CaretUpIcon,
  StackIcon as Layers,
  ListIcon as Menu,
  TextTIcon as Type,
  XIcon as X,
} from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import { usePathname, useRouter } from 'next/navigation';
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const CTA_LINK = '/auth';

/** The bar turns solid once the page has scrolled this far. */
const SOLID_AFTER_PX = 20;
/** Half the 64px bar: a dark band counts as under the bar until it clears this line. */
const BAR_MIDLINE_PX = 32;
/** First hover waits this long, so a pointer crossing the bar opens nothing. */
const HOVER_INTENT_MS = 80;
/** Leaving the bar and panel closes after this grace, so a diagonal exit survives. */
const LEAVE_GRACE_MS = 150;
/** A click this soon after hover opened the menu keeps it open instead of toggling. */
const HOVER_CLICK_GRACE_MS = 400;
/** The mega menu is a desktop surface; below this width the drawer takes over. */
const DESKTOP_QUERY = '(min-width: 1024px)';

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

type MenuId = MegaMenu['id'];

/** Links in the bar that navigate directly, beside the three menus. */
const PLAIN_LINKS = [
  { label: 'Use cases', href: '/use-cases' },
  { label: 'Case studies', href: '/case-studies' },
  { label: 'Pricing', href: '/pricing' },
];

const USE_CASES_ENABLED = process.env.NEXT_PUBLIC_USE_CASES_ENABLED !== 'false';

/** Bar text link: ink at rest, muted on hover (Buio). */
const BAR_LINK =
  'text-foreground hover:text-muted-foreground outline-ring flex h-full items-center rounded-sm text-sm transition-colors duration-moderate focus-visible:outline-2';

/** Nav trigger or link: a quiet row that turns into a muted pill while its menu is open. */
const NAV_ITEM =
  'text-foreground hover:text-muted-foreground outline-ring flex h-8 items-center rounded-md px-3 text-sm transition-colors duration-moderate focus-visible:outline-2';

/** Drawer row: one link per line, the full width, 44px tall to tap. */
const DRAWER_ROW =
  'text-foreground hover:text-muted-foreground outline-ring flex min-h-11 w-full items-center gap-2 rounded-sm text-left text-base transition-colors duration-moderate focus-visible:outline-2';

const firstLink = (panel: HTMLElement | null | undefined) =>
  panel?.querySelector<HTMLElement>('a[href]') ?? null;

export function Navbar() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const openDemo = useRequestDemo();
  const { stars, formattedStars, loading: starsLoading } = useGitHubStars('kortix-ai', 'kortix');

  const [scrolled, setScrolled] = useState(false);
  // True while a page's dark top band (`data-hero-band`) is under the bar.
  const [overBand, setOverBand] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  // Keyboard opens and Escape closes skip the reveal: a keyboard action is
  // never animated (animations-dev).
  const [instant, setInstant] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  // Drawer navigation closes the drawer when it commits, not on tap
  // (KRTX-1591): an instant close left the old page frozen for ~2 s at mobile
  // width with no feedback. `pendingHref` is the pathname the tapped link is
  // navigating to; the tapped row runs the spinner until `pathname` lands on
  // it.
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const triggerRefs = useRef<Partial<Record<MenuId, HTMLButtonElement | null>>>({});
  const panelRefs = useRef<Partial<Record<MenuId, HTMLDivElement | null>>>({});
  const timerRef = useRef<number | undefined>(undefined);
  const hoverOpenedAtRef = useRef(0);
  const focusPanelRef = useRef(false);

  // `latestProjectPath` reads document.cookie, which the server pass cannot see.
  // Seed the state with the landing door and adopt the remembered project after
  // mount, so the "Projects" href is identical on both passes. No dependency
  // array on purpose: a project opened in another tab must update this href
  // (an anchor's href is also what middle-click and "copy link" use). The
  // setter is guarded so it cannot loop.
  const [projectsHref, setProjectsHref] = useState(PROJECT_LANDING_PATH);
  useEffect(() => {
    if (!user) return;
    const next = latestProjectPath(user.id);
    setProjectsHref((prev) => (prev === next ? prev : next));
  });

  const menus = localizeUiCatalog(MEGA_MENUS, tI18nComplete, SITE_CONFIG_TRANSLATION_KEYS).map(
    (menu) => ({
      ...menu,
      groups: menu.groups.map((group) => ({
        ...group,
        links: group.links.filter((link) => USE_CASES_ENABLED || link.href !== '/use-cases'),
      })),
    }),
  );
  const plainLinks = localizeUiCatalog(
    PLAIN_LINKS,
    tI18nComplete,
    SITE_CONFIG_TRANSLATION_KEYS,
  ).filter((link) => USE_CASES_ENABLED || link.href !== '/use-cases');

  const solid = scrolled || openMenu !== null || isDrawerOpen;

  const clearTimer = () => window.clearTimeout(timerRef.current);

  const setMenu = useCallback((id: MenuId | null, opts?: { instant?: boolean }) => {
    window.clearTimeout(timerRef.current);
    setInstant(opts?.instant ?? false);
    setOpenMenu(id);
  }, []);

  // A page may open on a dark band (the home hero marks its band with
  // `data-hero-band`). While the band is under the bar's midline, the bar and
  // its panels take the band's dark scope, solid or not, so the bar never
  // flips to a light surface on top of the dark band. Re-run on navigation:
  // the band comes and goes with the page.
  useEffect(() => {
    const band = document.querySelector<HTMLElement>('[data-hero-band]');
    const onScroll = () => {
      setScrolled(window.scrollY > SOLID_AFTER_PX);
      setOverBand(band !== null && band.getBoundingClientRect().bottom > BAR_MIDLINE_PX);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [pathname]);

  // An open menu closes on Escape wherever focus is: after a hover open it is
  // still on the page, outside the bar. The bar's own handler below also
  // returns focus to the trigger when focus is inside.
  useEffect(() => {
    if (!openMenu) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null, { instant: true });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openMenu, setMenu]);

  // Crossing into the desktop width closes the drawer; leaving it closes the menu.
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => (query.matches ? setIsDrawerOpen(false) : setMenu(null));
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [setMenu]);

  // A committed navigation closes the menu (Next keeps this component mounted).
  const [menuPathname, setMenuPathname] = useState(pathname);
  if (menuPathname !== pathname) {
    setMenuPathname(pathname);
    setOpenMenu(null);
    setInstant(true);
  }

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  // A keyboard open moves focus to the panel's first link once it is no longer inert.
  useEffect(() => {
    if (!openMenu || !focusPanelRef.current) return;
    focusPanelRef.current = false;
    firstLink(panelRefs.current[openMenu])?.focus();
  }, [openMenu]);

  // The drawer is a modal dialog: it locks the page scroll, takes focus on
  // open and gives it back to the menu button on close.
  useEffect(() => {
    if (!isDrawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    drawerCloseRef.current?.focus();
    const trigger = drawerTriggerRef.current;
    return () => {
      document.body.style.overflow = prev;
      trigger?.focus();
    };
  }, [isDrawerOpen]);

  // Escape closes the drawer; Tab wraps inside it, so focus never reaches the
  // page behind.
  const onDrawerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setIsDrawerOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // The navigation commit is the close: the drawer stays up (spinner on the
  // tapped row) until the router lands on the target.
  useEffect(() => {
    if (pendingHref !== null && pathname === pendingHref) setIsDrawerOpen(false);
  }, [pathname, pendingHref]);

  // A drawer closed by hand must not leave a row marked pending; this is also
  // what clears the pending mark after the commit close above.
  useEffect(() => {
    if (!isDrawerOpen) setPendingHref(null);
  }, [isDrawerOpen]);

  // ---- Mega menu: hover, click, keyboard -------------------------------------

  const onTriggerEnter = (id: MenuId) => (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimer();
    if (openMenu === id) return;
    // Switching between open menus is instant; only the first open waits.
    if (openMenu) {
      hoverOpenedAtRef.current = Date.now();
      setMenu(id);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      hoverOpenedAtRef.current = Date.now();
      setMenu(id);
    }, HOVER_INTENT_MS);
  };

  const onTriggerLeave = () => {
    // Leaving before the intent delay fires cancels the open.
    if (!openMenu) clearTimer();
  };

  const onTriggerClick = (id: MenuId) => (event: MouseEvent) => {
    // Enter and Space fire a click with `detail === 0`: open at once and move focus in.
    if (event.detail === 0) {
      focusPanelRef.current = openMenu !== id;
      setMenu(openMenu === id ? null : id, { instant: true });
      return;
    }
    const justHovered = Date.now() - hoverOpenedAtRef.current < HOVER_CLICK_GRACE_MS;
    setMenu(openMenu === id && !justHovered ? null : id);
  };

  const onTriggerKeyDown = (id: MenuId) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const panelLink = firstLink(panelRefs.current[id]);
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey && openMenu === id)) {
      event.preventDefault();
      if (openMenu === id) {
        panelLink?.focus();
        return;
      }
      focusPanelRef.current = true;
      setMenu(id, { instant: true });
    }
  };

  // Tab off either end of an open panel returns to the bar: Shift+Tab on the
  // first link to its trigger, Tab on the last link to the next trigger.
  const onPanelKeyDown = (id: MenuId) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const links = panelRefs.current[id]?.querySelectorAll<HTMLElement>('a[href]');
    if (!links?.length) return;
    const index = MEGA_MENUS.findIndex((menu) => menu.id === id);
    if (event.shiftKey && document.activeElement === links[0]) {
      event.preventDefault();
      triggerRefs.current[id]?.focus();
    } else if (!event.shiftKey && document.activeElement === links[links.length - 1]) {
      event.preventDefault();
      const next = MEGA_MENUS[index + 1];
      setMenu(null, { instant: true });
      if (next) triggerRefs.current[next.id]?.focus();
      else wrapperRef.current?.querySelector<HTMLElement>('[data-after-menus]')?.focus();
    }
  };

  const onWrapperKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !openMenu) return;
    const trigger = triggerRefs.current[openMenu];
    setMenu(null, { instant: true });
    trigger?.focus();
  };

  // The logo, the plain links and the actions close the menu as soon as the
  // pointer reaches them (Buio `data-mega-close`).
  const closeOnEnter = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && openMenu) setMenu(null);
  };

  // ---- Drawer ----------------------------------------------------------------

  // Page links commit first: the drawer stays up (spinner on the tapped row)
  // until the new page renders, then the effect above closes it. Same-page
  // anchors scroll in place and close at once.
  const handleDrawerNavClick = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    const anchor = href.startsWith('#')
      ? href.slice(1)
      : href.startsWith('/#')
        ? href.slice(2)
        : null;
    if (!anchor) {
      // Off-site rows open a new tab; this page never commits.
      if (href.startsWith('http')) return setIsDrawerOpen(false);
      const target = href.split('#')[0];
      // The page is already committed: close now, no navigation is in flight.
      if (pathname === target) return setIsDrawerOpen(false);
      setPendingHref(target);
      return;
    }
    e.preventDefault();
    setIsDrawerOpen(false);
    if (pathname !== '/') return router.push(`/#${anchor}`);
    document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' });
    window.history.replaceState(null, '', `/#${anchor}`);
  };

  // A row is pending when its target is the navigation in flight.
  const isPending = (href: string) => href.split('#')[0] === pendingHref;

  // "Brandmark" is the symbol, "Logomark" is the wordmark (the brandkit's own
  // naming). The copied color follows the active theme.
  const copyBrandSvg = async (kind: 'symbol' | 'wordmark') => {
    const color = document.documentElement.classList.contains('dark') ? 'White' : 'Black';
    const path =
      kind === 'symbol'
        ? `/brandkit/Logo/Brandmark/SVG/Brandmark ${color}.svg`
        : `/brandkit/Logo/Logomark/SVG/Logomark ${color}.svg`;
    try {
      const svg = await (await fetch(path)).text();
      await navigator.clipboard.writeText(svg);
      successToast(tHardcodedUi.raw('i18nComplete.textc46a054cc5d2'));
    } catch {
      errorToast(tHardcodedUi.raw('i18nComplete.text5d9940f7d30f'));
    }
  };

  const signInLabel = tHardcodedUi.raw('componentsHomeNavbar.logIn');
  const getStartedLabel = tHardcodedUi.raw('componentsHomeNavbar.line312JsxTextGetStarted');
  const projectsLabel = tHardcodedUi.raw('i18nComplete.text04e2a9728af7');
  const homeLabel = tHardcodedUi.raw('i18nComplete.text7ecec93ed268');

  const panelTransition = {
    duration: instant || reduceMotion ? 0 : openMenu ? 0.24 : 0.18,
    ease: EASE_OUT,
  };

  return (
    <>
      {/* Dims the page under an open menu; a click on it closes. */}
      <div
        aria-hidden
        onClick={() => setMenu(null)}
        className={cn(
          'bg-background/70 duration-moderate fixed inset-0 hidden backdrop-blur-sm transition-[opacity,visibility] ease-out lg:block',
          openMenu ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0',
          instant && 'transition-none',
        )}
      />
      <div
        ref={wrapperRef}
        className="relative"
        onPointerEnter={clearTimer}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'mouse' || !openMenu) return;
          timerRef.current = window.setTimeout(() => setMenu(null), LEAVE_GRACE_MS);
        }}
        onBlur={(event) => {
          // Focus that leaves for another element closes; a click on panel
          // whitespace (no `relatedTarget`) does not.
          const next = event.relatedTarget as Node | null;
          if (openMenu && next && !event.currentTarget.contains(next)) {
            setMenu(null, { instant: true });
          }
        }}
        onKeyDown={onWrapperKeyDown}
      >
        <header
          data-solid={solid || undefined}
          className={cn(
            // Below `lg` the bar is always in its scrolled state (background,
            // blur, hairline): the compact bar has no menus to separate it from
            // the page, so it needs its own surface and edge from the start.
            'max-lg:border-border max-lg:bg-background/90 duration-slow relative w-full border-b border-transparent transition-[background-color,backdrop-filter,border-color] ease-out max-lg:backdrop-blur-md',
            solid && 'bg-background/90 backdrop-blur-md',
            scrolled && 'border-border',
            overBand && 'dark',
          )}
        >
          <div className={cn(MARKETING_CONTAINER, 'flex h-16 items-center justify-between')}>
            <ContextMenu>
              <ContextMenuTrigger asChild className="group/kortix-logo">
                <Link
                  href="/"
                  aria-label={homeLabel}
                  onPointerEnter={closeOnEnter}
                  className="text-foreground outline-ring flex h-16 w-fit shrink-0 items-center rounded-sm focus-visible:outline-2"
                >
                  <KortixLogo size={15} variant="logomark" />
                </Link>
              </ContextMenuTrigger>
              {/* Brand menu: copy the theme-matching SVG, download the brandkit, open the design system. */}
              <ContextMenuContent className="w-56">
                <ContextMenuItem onClick={() => copyBrandSvg('symbol')} className="gap-2 text-sm">
                  <KortixLogo size={14} variant="symbol" className="text-foreground" />
                  {tHardcodedUi.raw('componentsHomeNavbar.copySymbolSvg')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => copyBrandSvg('wordmark')} className="gap-2 text-sm">
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
                  className="gap-2 text-sm"
                >
                  <Download className="size-3.5 shrink-0" />
                  {tHardcodedUi.raw('componentsHomeNavbar.downloadBrandAssets')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem asChild className="gap-2 text-sm">
                  <Link href="/design-system" prefetch>
                    <Layers className="size-3.5 shrink-0" />
                    {tHardcodedUi.raw('componentsHomeNavbar.line259JsxTextDesignSystem')}
                  </Link>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            <SiteSwitcher className="mr-auto ml-4 lg:mr-0" />

            {/* The links sit right after the logo; `mr-auto` pushes the actions to the end. */}
            <nav className="hidden items-center gap-1 lg:mr-auto lg:ml-8 lg:flex">
              {menus.map((menu) => (
                <button
                  key={menu.id}
                  ref={(node) => {
                    triggerRefs.current[menu.id] = node;
                  }}
                  type="button"
                  aria-expanded={openMenu === menu.id}
                  aria-controls={`mega-${menu.id}`}
                  onPointerEnter={onTriggerEnter(menu.id)}
                  onPointerLeave={onTriggerLeave}
                  onClick={onTriggerClick(menu.id)}
                  onKeyDown={onTriggerKeyDown(menu.id)}
                  className={cn(
                    NAV_ITEM,
                    'aria-expanded:bg-muted aria-expanded:text-foreground gap-1.5',
                  )}
                >
                  {menu.label}
                  {openMenu === menu.id ? (
                    <CaretUpIcon className="size-3" />
                  ) : (
                    <CaretDownIcon className="size-3" />
                  )}
                </button>
              ))}
              {plainLinks.map((link, i) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onPointerEnter={closeOnEnter}
                  data-after-menus={i === 0 ? '' : undefined}
                  className={NAV_ITEM}
                >
                  {link.label}
                </Link>
              ))}
            </nav>

            <div className="flex items-center justify-end gap-1" onPointerEnter={closeOnEnter}>
              {/* `stars`, not `formattedStars`: the formatter returns an en dash
                  for a missing count. No number, no chip. */}
              {stars !== null && !starsLoading && (
                <Link
                  href="https://github.com/kortix-ai/suna"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(BAR_LINK, 'mr-4 hidden gap-2 xl:flex')}
                >
                  <Github className="size-4" />
                  <span className="tabular-nums">{formattedStars}</span>
                </Link>
              )}
              {user ? (
                <MarketingButton asChild className="hit-area-y-3">
                  <Link href={projectsHref} prefetch>
                    {projectsLabel}
                  </Link>
                </MarketingButton>
              ) : (
                <>
                  <MarketingButton variant="secondary" asChild className="hidden lg:inline-flex">
                    <Link href={CTA_LINK}>{signInLabel}</Link>
                  </MarketingButton>
                  <MarketingButton asChild className="hit-area-y-3">
                    <Link href={CTA_LINK} onClick={trackCtaSignup}>
                      {getStartedLabel}
                    </Link>
                  </MarketingButton>
                </>
              )}
              <button
                ref={drawerTriggerRef}
                type="button"
                onClick={() => setIsDrawerOpen(true)}
                aria-label={tHardcodedUi.raw(
                  'componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu',
                )}
                aria-expanded={isDrawerOpen}
                className="text-foreground outline-ring -mr-3 flex size-12 items-center justify-center rounded-md focus-visible:outline-2 lg:hidden"
              >
                <Menu className="size-5" />
              </button>
            </div>
          </div>
        </header>

        {/* The panel reveal: height from 0 to the tallest panel, ease-out.
            All panels share one grid cell, so the height never changes while
            switching menus; only the content cross-fades. */}
        <m.div
          initial={false}
          animate={{ height: openMenu ? 'auto' : 0 }}
          transition={panelTransition}
          className={cn(
            'absolute inset-x-0 top-full hidden overflow-hidden lg:block',
            openMenu && 'shadow-md',
            overBand && 'dark',
          )}
        >
          <div className="bg-background grid border-b">
            {menus.map((menu) => (
              <MegaMenuPanel
                key={menu.id}
                ref={(node) => {
                  panelRefs.current[menu.id] = node;
                }}
                menu={menu}
                open={openMenu === menu.id}
                onNavigate={() => setMenu(null, { instant: true })}
                onKeyDown={onPanelKeyDown(menu.id)}
                stars={stars !== null && !starsLoading ? formattedStars : null}
              />
            ))}
          </div>
        </m.div>
      </div>

      {/* Static full-screen drawer: appears and disappears in the same frame
          as the tap. Below lg only; the bar's resize listener closes it above. */}
      {isDrawerOpen && (
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label={tHardcodedUi.raw('componentsHomeNavbar.line322JsxAttrAriaLabelOpenMenu')}
          onKeyDown={onDrawerKeyDown}
          data-lenis-prevent
          className="bg-background fixed inset-0 z-50 flex flex-col lg:hidden"
        >
          <div
            className={cn(MARKETING_CONTAINER, 'flex h-16 shrink-0 items-center justify-between')}
          >
            <Link
              href="/"
              aria-label={homeLabel}
              onClick={handleDrawerNavClick('/')}
              className="text-foreground flex h-16 items-center gap-2"
            >
              <KortixLogo size={15} variant="logomark" />
              {isPending('/') && <Loading variant="spokes" />}
            </Link>
            <button
              ref={drawerCloseRef}
              type="button"
              onClick={() => setIsDrawerOpen(false)}
              aria-label={tHardcodedUi.raw('componentsHomeNavbar.line348JsxAttrAriaLabelCloseMenu')}
              className="text-foreground outline-ring -mr-3 flex size-12 items-center justify-center rounded-md focus-visible:outline-2"
            >
              <X className="size-5" />
            </button>
          </div>

          {/* One column: each group is a small muted label over its links.
              Simple on a phone, no side-by-side lists to squeeze. */}
          <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className={cn(MARKETING_CONTAINER, 'flex flex-col gap-8 py-6')}>
              {[
                ...menus.map((menu) => ({
                  id: menu.id,
                  label: menu.label,
                  links: menu.groups.flatMap((group) => group.links),
                })),
                {
                  id: 'kortix',
                  label: 'Kortix',
                  links: [
                    { label: tHardcodedUi.raw('componentsHomeNavbar.home'), href: '/' },
                    ...plainLinks,
                    { label: 'X', href: 'https://x.com/kortix', external: true },
                  ],
                },
              ].map((section) => (
                <div key={section.id}>
                  <p className="text-muted-foreground text-sm">{section.label}</p>
                  <ul className="mt-1">
                    {section.links.map((link) => (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          onClick={handleDrawerNavClick(link.href)}
                          {...('external' in link && link.external
                            ? { target: '_blank', rel: 'noreferrer noopener' }
                            : {})}
                          className={DRAWER_ROW}
                        >
                          {link.label}
                          {isPending(link.href) && <Loading variant="spokes" />}
                        </Link>
                      </li>
                    ))}
                    {section.id === 'kortix' ? (
                      <li>
                        <button
                          type="button"
                          className={cn(DRAWER_ROW, 'w-full')}
                          onClick={() => {
                            setIsDrawerOpen(false);
                            openDemo();
                          }}
                        >
                          {tHardcodedUi.raw('componentsHomeNavbar.line301JsxTextRequestDemo')}
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </div>
              ))}
            </div>
          </nav>

          <div
            className={cn(
              MARKETING_CONTAINER,
              'grid shrink-0 grid-cols-2 gap-2 border-t pt-4 pb-6',
            )}
          >
            {user ? (
              <MarketingButton size="md" asChild className="col-span-2">
                <Link href={projectsHref} prefetch onClick={handleDrawerNavClick(projectsHref)}>
                  {projectsLabel}
                  {isPending(projectsHref) && <Loading variant="spokes" />}
                </Link>
              </MarketingButton>
            ) : (
              <>
                <MarketingButton size="md" variant="secondary" asChild>
                  <Link href={CTA_LINK} onClick={handleDrawerNavClick(CTA_LINK)}>
                    {signInLabel}
                    {isPending(CTA_LINK) && <Loading variant="spokes" />}
                  </Link>
                </MarketingButton>
                <MarketingButton size="md" asChild>
                  <Link
                    href={CTA_LINK}
                    onClick={(e) => {
                      trackCtaSignup();
                      handleDrawerNavClick(CTA_LINK)(e);
                    }}
                  >
                    {getStartedLabel}
                  </Link>
                </MarketingButton>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
