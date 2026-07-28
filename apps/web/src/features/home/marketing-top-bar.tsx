'use client';

/**
 * The marketing navigation, for signed-out visitors.
 *
 * It lives in a top bar rather than in the sidebar. The sidebar is the
 * product's own navigation and must read identically signed in or out — a
 * "Product" group hanging off the bottom of it existed only when signed out,
 * which is exactly the kind of difference that makes the two look like
 * different apps.
 */

import Link from 'next/link';

import { Button } from '@/components/ui/button';

export interface MarketingLink {
  label: string;
  href: string;
}

export const MARKETING_LINKS: readonly MarketingLink[] = [
  { label: 'Why Kortix', href: '/why' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Enterprise', href: '/enterprise' },
  { label: 'Developers', href: '/developers' },
  { label: 'Docs', href: '/docs' },
];

export function MarketingTopBar({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="border-border flex shrink-0 items-center gap-1 border-b px-4 py-2">
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {MARKETING_LINKS.map((link) => (
          <Button
            key={link.href}
            asChild
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground shrink-0 font-normal"
          >
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ))}
      </nav>
      <Button type="button" size="sm" className="shrink-0" onClick={onSignIn}>
        Sign in
      </Button>
    </div>
  );
}

export default MarketingTopBar;
