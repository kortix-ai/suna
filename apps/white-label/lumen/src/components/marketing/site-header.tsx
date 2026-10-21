'use client';

import { BrandMark } from '@/components/brand-mark';
import { BRAND } from '@/config/brand';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@kortix/ui/dropdown-menu';
import { ArrowRightIcon, CaretDownIcon, ListIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { NAV } from './content';

type MenuKey = 'platform' | 'solutions' | 'resources';
const MENUS: { key: MenuKey; label: string }[] = [
  { key: 'platform', label: 'Platform' },
  { key: 'solutions', label: 'Solutions' },
];
const LINKS = [
  { href: '/customers', label: 'Customers' },
  { href: '/security', label: 'Security' },
  { href: '/pricing', label: 'Pricing' },
];

/** Pages whose first band is the brand surface: the header starts transparent over it. */
const ON_BRAND = new Set(['/', '/security']);
const ANNOUNCE_KEY = 'lumen:announce-1.3';

/**
 * The public header: announcement bar, wordmark, centred nav with mega-menus
 * (two columns of page names in the display serif over a dimmed page), Log in
 * and the pill CTA. Transparent over a brand hero until the page scrolls.
 */
export function SiteHeader() {
  const path = usePathname();
  const [open, setOpen] = useState<MenuKey | null>(null);
  const [mobile, setMobile] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [announce, setAnnounce] = useState(true);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      setAnnounce(sessionStorage.getItem(ANNOUNCE_KEY) !== '0');
    } catch {
      // Storage blocked: show it.
    }
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (setOpen(null), setMobile(false));
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => {
    setOpen(null);
    setMobile(false);
  }, [path]);
  useEffect(() => {
    document.body.style.overflow = mobile ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobile]);

  const clear = (k: MenuKey | null) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(k);
  };
  const leave = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(null), 160);
  };

  const transparent = ON_BRAND.has(path) && !scrolled && !open && !mobile;
  const dismiss = () => {
    setAnnounce(false);
    try {
      sessionStorage.setItem(ANNOUNCE_KEY, '0');
    } catch {
      // Storage blocked: hidden for this page only.
    }
  };

  return (
    <>
      {announce && (
        <div className="relative z-40 flex h-9 items-center justify-center bg-navy px-10 text-[13px] text-white md:text-[14px]">
          <Link href="/blog/lumen-1-3" className="group flex min-w-0 items-center gap-2 truncate">
            <span className="truncate">Lumen 1.3: every firm in one workspace, onboarded in seconds</span>
            <ArrowRightIcon className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss announcement"
            onClick={dismiss}
            className="absolute right-3 text-white/70 hover:bg-white/10 hover:text-white"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}
      <header
        onMouseLeave={leave}
        className={cn(
          'sticky top-0 z-40 transition-colors duration-200',
          transparent ? 'bg-transparent text-white' : 'border-b border-hairline bg-background/95 text-foreground backdrop-blur',
        )}
      >
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center px-6 md:px-10">
          <Link href="/" aria-label={`${BRAND.name} home`} className="shrink-0">
            <BrandMark className={cn('text-[21px]', transparent && 'text-white')} />
          </Link>

          <nav aria-label="Site" className="mx-auto hidden items-center gap-1 lg:flex">
            {MENUS.map((m) => (
              <Button
                key={m.key}
                variant="ghost"
                aria-expanded={open === m.key}
                onMouseEnter={() => clear(m.key)}
                onClick={() => clear(open === m.key ? null : m.key)}
                className={cn(
                  'h-9 gap-1 rounded-full px-3.5 text-[14px] font-medium',
                  transparent ? 'text-white/85 hover:bg-white/10 hover:text-white' : open === m.key ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m.label}
                <CaretDownIcon className={cn('size-3 transition-transform duration-200', open === m.key && 'rotate-180')} />
              </Button>
            ))}
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onMouseEnter={() => clear(null)}
                className={cn(
                  'flex h-9 items-center rounded-full px-3.5 text-[14px] font-medium transition-colors',
                  transparent ? 'text-white/85 hover:text-white' : path.startsWith(l.href) ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {l.label}
              </Link>
            ))}
            <Button
              variant="ghost"
              aria-expanded={open === 'resources'}
              onMouseEnter={() => clear('resources')}
              onClick={() => clear(open === 'resources' ? null : 'resources')}
              className={cn(
                'h-9 gap-1 rounded-full px-3.5 text-[14px] font-medium',
                transparent ? 'text-white/85 hover:bg-white/10 hover:text-white' : open === 'resources' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Resources
              <CaretDownIcon className={cn('size-3 transition-transform duration-200', open === 'resources' && 'rotate-180')} />
            </Button>
          </nav>

          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className={cn('hidden h-9 gap-1 rounded-full px-3 text-[14px] font-medium sm:flex', transparent ? 'text-white hover:bg-white/10' : '')}
                >
                  Log in <CaretDownIcon className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem asChild>
                  <Link href="/sign-in">Log in to Lumen</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/sign-up">Start a free trial</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Link
              href="/demo"
              className={cn(
                'inline-flex h-8 items-center rounded-full px-4 text-[14px] font-medium transition-colors',
                transparent ? 'bg-white text-navy hover:bg-[#F5F3EF]' : 'bg-navy text-white hover:bg-navy-700 dark:bg-[#F5F3EF] dark:text-navy',
              )}
            >
              Request demo
            </Link>
            <Button
              variant="ghost"
              size="icon"
              aria-label={mobile ? 'Close menu' : 'Open menu'}
              aria-expanded={mobile}
              onClick={() => setMobile((m) => !m)}
              className={cn('size-9 lg:hidden', transparent && 'text-white hover:bg-white/10')}
            >
              {mobile ? <XIcon className="size-5" /> : <ListIcon className="size-5" />}
            </Button>
          </div>
        </div>

        {/* Mega-menu: page names in the display serif, two columns. */}
        <div
          onMouseEnter={() => closeTimer.current && clearTimeout(closeTimer.current)}
          className={cn(
            'absolute inset-x-0 top-full hidden border-b border-hairline bg-background text-foreground transition-[opacity,transform] duration-200 lg:block',
            open ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-1 opacity-0',
          )}
        >
          {open && (
            <div className="mx-auto grid max-w-[1440px] grid-cols-[1fr_1fr_1.2fr] gap-x-10 px-20 pt-14 pb-16">
              {halves(NAV[open]).map((col, i) => (
                <ul key={i} className="space-y-1">
                  {col.map((l) => (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className="display-xs block py-0.5 text-[40px]! leading-[1.25]! tracking-[-0.045em]! transition-colors hover:text-muted-foreground"
                      >
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              ))}
              <MenuNote k={open} />
            </div>
          )}
        </div>
      </header>
      {/* The page behind an open menu dims. */}
      <div
        aria-hidden
        onClick={() => setOpen(null)}
        className={cn(
          'fixed inset-0 z-30 hidden bg-black/30 transition-opacity duration-200 lg:block',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      {mobile && (
        <div className="fixed inset-x-0 top-[72px] bottom-0 z-40 overflow-y-auto bg-background px-6 pt-6 pb-10 lg:hidden">
          {(
            [
              ['Platform', NAV.platform],
              ['Solutions', NAV.solutions],
              ['Company', [...LINKS, ...NAV.resources]],
            ] as const
          ).map(([label, links]) => (
            <div key={label} className="mb-8">
              <p className="mb-2 text-[13px] text-muted-foreground">{label}</p>
              {links.map((l) => (
                <Link key={l.href} href={l.href} className="display-xs block py-1 text-[30px]!">
                  {l.label}
                </Link>
              ))}
            </div>
          ))}
          <div className="flex flex-col gap-2 border-t border-hairline pt-6">
            <Link href="/demo" className="flex h-11 items-center justify-center rounded-full bg-navy text-[15px] font-medium text-white dark:bg-[#F5F3EF] dark:text-navy">
              Request demo
            </Link>
            <Link href="/sign-in" className="flex h-11 items-center justify-center rounded-full border border-border text-[15px] font-medium">
              Log in
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

function MenuNote({ k }: { k: MenuKey }) {
  const notes: Record<MenuKey, { title: string; body: string; href: string; cta: string }> = {
    platform: { title: 'Built for real legal work', body: 'One workspace for review, research and drafting. Every answer points to its source.', href: '/platform', cta: 'Platform overview' },
    solutions: { title: 'For the way your team works', body: 'Firms, in-house teams, disputes and deals: the same platform, set up for your practice.', href: '/customers', cta: 'Customer stories' },
    resources: { title: 'How Lumen checks a citation', body: 'Every quote is matched against the source before you see it.', href: '/blog/how-lumen-checks-a-citation', cta: 'Read the post' },
  };
  const n = notes[k];
  return (
    <Link href={n.href} className="group self-start rounded-[4px] bg-paper p-6 transition-colors hover:bg-paper-deep">
      <p className="text-[13px] text-muted-foreground">{n.cta}</p>
      <p className="display-xs mt-6">{n.title}</p>
      <p className="mt-2 text-[15px] text-muted-foreground">{n.body}</p>
      <ArrowRightIcon className="mt-6 size-4 transition-transform group-hover:translate-x-1" />
    </Link>
  );
}

function halves<T>(items: T[]): [T[], T[]] {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}
