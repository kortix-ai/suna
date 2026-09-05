'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/marketing/button';
import { useAuth } from '@/features/providers/auth-provider';
import { PublicTemplateInstallDialog } from './public-install-dialog';
import type { MarketplaceTemplate } from './templates-catalog';

/**
 * The action button on `/marketplace/<slug>` — split out from
 * `PublicTemplateDetail` for exactly one reason: it is the only piece that
 * needs `useSearchParams()` (to notice `?install=1` on return from `/auth`),
 * and that hook forces whatever renders it into dynamic rendering unless it
 * sits behind a `<Suspense>` boundary. The rest of the detail page is a
 * `revalidate = 3600` ISR page a crawler reads — this component is the ONE
 * thing allowed to opt out of that, and `PublicTemplateDetail` wraps it in
 * Suspense with the plain pre-auth link as the fallback, so a crawler (or a
 * client mid-hydration) still sees a real, working CTA either way.
 *
 * Behavior:
 *  - signed OUT: `Start free to install`, to `/auth?redirect=<this
 *    page>?install=1`. `/marketplace` is a signup-safe return prefix
 *    (`return-url.ts`), so this survives a brand-new signup — `install=1` is
 *    what lets THIS component resume the install once the visitor is back,
 *    instead of the intent that sent them to sign up just evaporating.
 *  - signed IN: `Install`, opening `PublicTemplateInstallDialog` — the same
 *    `createMarketplaceInstallSession` call the in-project install modal
 *    makes, after a project-picker step that modal never needs (it already
 *    knows `projectId`).
 */
export function TemplateInstallCta({ template }: { template: MarketplaceTemplate }) {
  const { user, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [installOpen, setInstallOpen] = useState(false);

  useEffect(() => {
    if (authLoading || !user) return;
    if (searchParams.get('install') !== '1') return;
    setInstallOpen(true);
    router.replace(pathname, { scroll: false });
  }, [authLoading, user, searchParams, pathname, router]);

  if (authLoading) {
    // Avoids a `/auth` link flashing for a visitor who turns out to already be
    // signed in — `useAuth` resolves in one tick locally, but a cold load over
    // the network can take longer.
    return (
      <Button size="lg" disabled>
        Start free to install
      </Button>
    );
  }

  if (!user) {
    const installHref = `/auth?redirect=${encodeURIComponent(`${pathname}?install=1`)}`;
    return (
      <Button asChild size="lg">
        <Link href={installHref}>Start free to install</Link>
      </Button>
    );
  }

  return (
    <>
      <Button size="lg" onClick={() => setInstallOpen(true)}>
        Install
      </Button>
      <PublicTemplateInstallDialog
        template={template}
        open={installOpen}
        onOpenChange={setInstallOpen}
      />
    </>
  );
}
