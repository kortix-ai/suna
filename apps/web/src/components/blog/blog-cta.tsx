'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/marketing/button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { ArrowRightIcon as HiArrowRight } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useEffect, useState } from 'react';

/** The standard marketing CTA pair, reused inside blog posts. */
export function BlogCta() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  // `latestProjectPath` reads document.cookie, which the server pass cannot
  // see. Seeding with `/auth` keeps both passes identical and lets this be a
  // real anchor: hydration adopts the remembered project afterwards. The CTA at
  // the foot of every post therefore supports middle-click, cmd-click and "copy
  // link address", which a button does not.
  //
  // `HoverPrefetchLink`, so an anonymous reader scrolling past does not prefetch
  // an authed route. No dependency array: the remembered project can change in
  // another tab, and a frozen href is visible in the status bar, not just wrong
  // on click. The setter is guarded, so it cannot loop.
  const [startHref, setStartHref] = useState('/auth');
  useEffect(() => {
    if (!user) return;
    const href = latestProjectPath(user.id);
    setStartHref((prev) => (prev === href ? prev : href));
  });

  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
      <Button size="lg" asChild>
        <HoverPrefetchLink href={startHref} prefetch onClick={trackCtaSignup}>
          {tI18nComplete.raw('text61e8d44ad423')}
          <HiArrowRight className="size-4" />
        </HoverPrefetchLink>
      </Button>
      <Button size="lg" variant="secondary" onClick={() => openDemo()}>
        {tI18nComplete.raw('text915b64b69378')}
      </Button>
    </div>
  );
}
