'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/marketing/button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import {
  type MenuColumn,
  type MenuFooter,
  NAV,
  type NavEntry,
} from '@/features/marketing/v2/content';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Menu, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NavigationMenu as Nav } from 'radix-ui';
import { useCallback, useEffect, useState } from 'react';

const SCROLL_ON = 24;

function hasMenu(entry: NavEntry): entry is Extract<NavEntry, { columns: MenuColumn[] }> {
  return 'columns' in entry;
}

/* ── the dropdown panel ──────────────────────────────────────────────────── */

function MenuPanel({ columns, footer }: { columns: MenuColumn[]; footer?: MenuFooter }) {
  return (
    <div className="border-border bg-popover w-[min(38rem,calc(100vw-2.5rem))] overflow-hidden rounded-sm border shadow-lg">
      <div className="grid gap-x-8 gap-y-6 p-6 sm:grid-cols-2">
        {columns.map((column) => (
          <div key={column.title} className="space-y-4">
            <p className="text-muted-foreground text-xs tracking-wider">{column.title}</p>
            <ul className="space-y-4">
              {column.items.map((item) => (
                <li key={item.name}>
                  <Nav.Link asChild>
                    <Link
                      href={item.href}
                      className="group/item focus-visible:ring-ring block rounded-sm outline-none focus-visible:ring-1"
                    >
                      <span className="text-foreground group-hover/item:text-kortix-blue block text-sm font-medium transition-colors">
                        {item.name}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-sm leading-snug">
                        {item.description}
                      </span>
                    </Link>
                  </Nav.Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {footer && (
        <div className="border-border bg-muted/40 flex items-center justify-between gap-4 border-t px-6 py-4">
          <p className="text-sm">
            <span className="text-foreground font-medium">{footer.label}</span>
            <span className="text-muted-foreground">: {footer.description}</span>
          </p>
          <Nav.Link asChild>
            <Link
              href={footer.href}
              className="text-kortix-blue flex shrink-0 items-center gap-1 text-sm font-medium hover:underline"
            >
              {footer.cta}
              <ChevronRight className="size-3.5" />
            </Link>
          </Nav.Link>
        </div>
      )}
    </div>
  );
}

/* ── the bar ─────────────────────────────────────────────────────────────── */

export function MarketingNav() {
  const { user } = useAuth();
  const router = useRouter();
  const openDemo = useRequestDemo();
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_ON);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const handleGetStarted = useCallback(() => {
    trackCtaSignup();
    router.push(user ? '/projects' : '/auth');
  }, [router, user]);

  // Only the landing page opens on the blue field; every other page starts on
  // white, so the bar must be solid from the first pixel there.
  const pathname = usePathname();
  const hasField = pathname === '/v2';
  const onField = hasField && !scrolled;

  const linkClass = cn(
    'flex h-9 items-center rounded-full px-3.5 text-[0.9375rem] font-medium transition-colors',
    onField
      ? 'text-white/90 hover:bg-white/15 hover:text-white'
      : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground',
  );

  return (
    <>
      <header
        className={cn(
          'fixed inset-x-0 top-0 z-50 transition-colors duration-200',
          scrolled && 'border-border bg-background/90 border-b backdrop-blur-xl',
        )}
      >
        <div className="mx-auto flex h-[4.5rem] w-full max-w-[68rem] items-center gap-6 px-6">
          <Link
            href="/"
            aria-label="Kortix home"
            className={cn('shrink-0', onField && 'text-white [&_svg]:fill-current')}
          >
            <KortixLogo size={19} variant="logomark" />
          </Link>

          <Nav.Root
            delayDuration={80}
            className="relative z-10 hidden flex-1 justify-center md:flex"
          >
            <Nav.List className="flex list-none items-center gap-1">
              {NAV.map((entry) =>
                hasMenu(entry) ? (
                  <Nav.Item key={entry.name}>
                    <Nav.Trigger
                      className={cn(
                        linkClass,
                        'group cursor-pointer gap-1',
                        onField
                          ? 'data-[state=open]:bg-white/15 data-[state=open]:text-white'
                          : 'data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground',
                      )}
                    >
                      {entry.name}
                      <ChevronDown
                        aria-hidden
                        className="size-3 opacity-60 transition-transform duration-200 group-data-[state=open]:rotate-180"
                      />
                    </Nav.Trigger>
                    <Nav.Content className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 absolute top-full left-0 pt-3">
                      <MenuPanel columns={entry.columns} footer={entry.footer} />
                    </Nav.Content>
                  </Nav.Item>
                ) : (
                  <Nav.Item key={entry.name}>
                    <Nav.Link asChild>
                      <Link href={entry.href} className={linkClass}>
                        {entry.name}
                      </Link>
                    </Nav.Link>
                  </Nav.Item>
                ),
              )}
            </Nav.List>
          </Nav.Root>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Link href={user ? '/projects' : '/auth'} className={cn(linkClass, 'hidden sm:flex')}>
              {user ? 'Projects' : 'Log In'}
            </Link>
            <button
              type="button"
              onClick={handleGetStarted}
              className={cn(
                'flex h-10 cursor-pointer items-center rounded-full px-5 text-[0.9375rem] font-medium transition-colors',
                onField
                  ? 'bg-white/20 text-white hover:bg-white/30'
                  : 'bg-foreground text-background hover:bg-foreground/90',
              )}
            >
              Get Started
            </button>

            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className={cn(
                'flex size-9 cursor-pointer items-center justify-center rounded-full md:hidden',
                onField ? 'text-white hover:bg-white/15' : 'text-foreground hover:bg-foreground/5',
              )}
            >
              <Menu className="size-5" />
            </button>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {drawerOpen && (
          <motion.div
            className="bg-background fixed inset-0 z-50 flex flex-col overflow-y-auto md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="flex h-16 shrink-0 items-center justify-between px-6">
              <KortixLogo size={18} variant="logomark" />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
              >
                <X className="size-5" />
              </Button>
            </div>

            <nav className="flex-1 px-6 pb-10">
              <ul className="divide-border divide-y">
                {NAV.map((entry) => (
                  <li key={entry.name} className="py-1">
                    {hasMenu(entry) ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setOpenSection((s) => (s === entry.name ? null : entry.name))
                          }
                          className="text-foreground flex w-full cursor-pointer items-center justify-between py-3 text-left text-base font-medium"
                          aria-expanded={openSection === entry.name}
                        >
                          {entry.name}
                          <ChevronDown
                            className={cn(
                              'size-4 transition-transform',
                              openSection === entry.name && 'rotate-180',
                            )}
                          />
                        </button>
                        {openSection === entry.name && (
                          <ul className="space-y-3 pb-4">
                            {entry.columns
                              .flatMap((c) => c.items)
                              .map((item) => (
                                <li key={`${entry.name}-${item.name}`}>
                                  <Link
                                    href={item.href}
                                    onClick={() => setDrawerOpen(false)}
                                    className="block"
                                  >
                                    <span className="text-foreground block text-sm font-medium">
                                      {item.name}
                                    </span>
                                    <span className="text-muted-foreground block text-sm">
                                      {item.description}
                                    </span>
                                  </Link>
                                </li>
                              ))}
                          </ul>
                        )}
                      </>
                    ) : (
                      <Link
                        href={entry.href}
                        onClick={() => setDrawerOpen(false)}
                        className="text-foreground block py-3 text-base font-medium"
                      >
                        {entry.name}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
