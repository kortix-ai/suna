'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/marketing/button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { Icon } from '@/features/icon/icon';
import { companyMenu, flatLinks, productMenu } from '@/features/landing/nav-content';
import { useAuth } from '@/features/providers/auth-provider';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { Menu, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tembo-style marketing nav: two hover mega menus (Product, Company) plus flat
 * links. Scoped to /landing while the rebuild is staged — the site-wide navbar
 * in components/home/navbar.tsx is untouched.
 *
 * Hover opens the panel; a short close delay lets the pointer travel from the
 * trigger into the panel without it snapping shut.
 */

type MenuId = 'product' | 'company';

export function LandingNav() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();
  const [open, setOpen] = useState<MenuId | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(null), 140);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  // Escape closes whatever is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(null);
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleStart = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <div className="bg-background/80 border-border/60 border-b backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
          <Link href="/landing" className="flex shrink-0 items-center gap-2">
            <KortixWordmark />
          </Link>

          <nav
            className="hidden items-center gap-1 md:flex"
            onMouseLeave={scheduleClose}
            aria-label="Main"
          >
            <MenuTrigger
              id="product"
              label="Product"
              open={open === 'product'}
              onOpen={() => {
                cancelClose();
                setOpen('product');
              }}
            />
            <FlatLink href="/use-cases" label="Use Cases" onHover={scheduleClose} />
            <MenuTrigger
              id="company"
              label="Company"
              open={open === 'company'}
              onOpen={() => {
                cancelClose();
                setOpen('company');
              }}
            />
            <FlatLink href="/pricing" label="Pricing" onHover={scheduleClose} />
            <FlatLink href="/docs" label="Docs" onHover={scheduleClose} />
          </nav>

          <div className="flex shrink-0 items-center gap-4">
            <GitHubStars />
            <button
              type="button"
              onClick={() => openDemo()}
              className="text-foreground/70 hover:text-foreground hidden cursor-pointer text-sm transition-colors lg:block"
            >
              Request demo
            </button>
            {user ? (
              <Button size="sm" asChild>
                <Link href="/projects">Projects</Link>
              </Button>
            ) : (
              <Button size="sm" onClick={handleStart}>
                Get started
              </Button>
            )}
            <button
              type="button"
              className="text-foreground/70 hover:text-foreground -mr-1 cursor-pointer p-1 transition-colors md:hidden"
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMobileOpen((v) => !v)}
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {/* Desktop mega panels */}
        <AnimatePresence>
          {open ? (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ type: 'spring', duration: 0.28, bounce: 0 }}
              className="absolute inset-x-0 top-16 hidden md:block"
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              <div className="mx-auto max-w-6xl px-6">
                <div className="bg-popover border-border w-fit min-w-[22rem] overflow-hidden rounded-lg border shadow-lg">
                  {open === 'product' ? <ProductPanel /> : <CompanyPanel />}
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {mobileOpen ? <MobileMenu onClose={() => setMobileOpen(false)} /> : null}
      </AnimatePresence>
    </header>
  );
}

function MenuTrigger({
  id,
  label,
  open,
  onOpen,
}: {
  id: MenuId;
  label: string;
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onOpen}
      onFocus={onOpen}
      onClick={onOpen}
      aria-expanded={open}
      aria-controls={`${id}-menu`}
      className={cn(
        'cursor-pointer px-3 py-2 text-sm transition-colors',
        open ? 'text-foreground' : 'text-foreground/70 hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

function FlatLink({
  href,
  label,
  onHover,
}: {
  href: string;
  label: string;
  onHover: () => void;
}) {
  return (
    <Link
      href={href}
      onMouseEnter={onHover}
      className="text-foreground/70 hover:text-foreground px-3 py-2 text-sm transition-colors"
    >
      {label}
    </Link>
  );
}

/**
 * Repo star count. Renders nothing until the fetch resolves so the nav never
 * shows a placeholder dash or reflows once the number lands.
 */
function GitHubStars() {
  const { formattedStars, loading } = useGitHubStars('kortix-ai', 'kortix');
  if (loading || !formattedStars) return null;

  return (
    <Link
      href="https://github.com/kortix-ai/suna"
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground/70 hover:text-foreground hidden items-center gap-1.5 text-sm transition-colors sm:flex"
    >
      <Icon.Github className="size-3.5" />
      <span className="tabular-nums">{formattedStars}</span>
    </Link>
  );
}

function ProductPanel() {
  return (
    <div id="product-menu">
      <div className="grid grid-cols-2 gap-x-10 gap-y-1 p-6">
        {productMenu.groups.map((group) => (
          <div key={group.heading} className="min-w-[16rem]">
            <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide">
              {group.heading}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.label}>
                  <PanelLink {...item} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-border bg-muted/40 flex items-center justify-between gap-6 border-t px-6 py-4">
        <p className="text-sm">
          <span className="text-foreground font-medium">{productMenu.footer.label}</span>
          <span className="text-muted-foreground">: {productMenu.footer.description}</span>
        </p>
        <Link
          href={productMenu.footer.href}
          className="text-foreground hover:text-muted-foreground shrink-0 text-sm font-medium transition-colors"
        >
          {productMenu.footer.linkLabel} →
        </Link>
      </div>
    </div>
  );
}

function CompanyPanel() {
  return (
    <ul id="company-menu" className="space-y-0.5 p-4">
      {companyMenu.items.map((item) => (
        <li key={item.label}>
          <PanelLink {...item} />
        </li>
      ))}
    </ul>
  );
}

function PanelLink({
  label,
  description,
  href,
}: {
  label: string;
  description: string;
  href: string;
}) {
  return (
    <Link href={href} className="hover:bg-muted block rounded-md px-3 py-2.5 transition-colors">
      <span className="text-foreground block text-sm font-medium">{label}</span>
      <span className="text-muted-foreground block text-sm">{description}</span>
    </Link>
  );
}

function MobileMenu({ onClose }: { onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="bg-background fixed inset-0 top-16 z-40 overflow-y-auto px-6 pt-6 pb-24 md:hidden"
    >
      {productMenu.groups.map((group) => (
        <div key={group.heading} className="mb-8">
          <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide">
            {group.heading}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.label}>
                <Link
                  href={item.href}
                  onClick={onClose}
                  className="hover:bg-muted -mx-3 block rounded-md px-3 py-2.5"
                >
                  <span className="text-foreground block text-sm font-medium">{item.label}</span>
                  <span className="text-muted-foreground block text-sm">{item.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="mb-8">
        <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide">Company</p>
        <ul className="space-y-0.5">
          {companyMenu.items.map((item) => (
            <li key={item.label}>
              <Link
                href={item.href}
                onClick={onClose}
                className="hover:bg-muted -mx-3 block rounded-md px-3 py-2.5"
              >
                <span className="text-foreground block text-sm font-medium">{item.label}</span>
                <span className="text-muted-foreground block text-sm">{item.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <ul className="border-border space-y-0.5 border-t pt-6">
        {flatLinks.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              onClick={onClose}
              className="text-foreground -mx-3 block rounded-md px-3 py-2.5 text-sm font-medium"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

function KortixWordmark() {
  return <KortixLogo size={18} variant="logomark" />;
}
