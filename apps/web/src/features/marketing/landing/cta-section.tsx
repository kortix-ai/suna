'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { cta } from '@/features/marketing/landing/content';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { latestWorkspacePath } from '@/lib/onboarding/last-workspace-cookie';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { useCallback } from 'react';

/**
 * The closing CTA, kept in the shape it has always had: copy on the left, the
 * Kortix letter grid on the right. Copy now lives in content.ts rather than the
 * i18n bundle, matching the rest of the rebuilt page.
 */
export function CtaSection() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? latestWorkspacePath(user.id) : '/auth';
  }, [user]);

  return (
    <section id="cta" className="relative mx-auto max-w-7xl px-6 py-16 sm:py-24 lg:px-0">
      <Reveal>
        <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
          <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
            <div className="col-span-4 flex flex-col items-start justify-start space-y-4 p-6 *:text-left">
              <div className="space-y-2">
                <Badge variant="kortix" className="rounded">
                  {cta.badge}
                </Badge>
                <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                  {cta.title}
                </h2>
                <p className="text-muted-foreground mt-4 text-sm leading-relaxed">{cta.sub}</p>
              </div>

              <p className="text-muted-foreground text-xs tracking-wider">{cta.trust}</p>

              <div className="mt-auto grid w-full grid-cols-1 gap-2">
                <Button size="lg" className="w-full" onClick={handleLaunch}>
                  {cta.ctaPrimary}
                  <ArrowRightIcon className="size-4" />
                </Button>
                <Button size="lg" className="w-full" variant="accent" onClick={() => openDemo()}>
                  {cta.ctaSecondary}
                </Button>
              </div>
            </div>
            <div className="col-span-1 hidden md:block" />
            <div className="col-span-7 mask-y-from-90% mask-x-from-90%">
              <KortixGrid count={58} seed={4228} />
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
