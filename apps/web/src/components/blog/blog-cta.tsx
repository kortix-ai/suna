'use client';

import { Button } from '@/components/ui/marketing/button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { ArrowRightIcon as HiArrowRight } from '@phosphor-icons/react';
import { useCallback } from 'react';
import { latestWorkspacePath } from '@/lib/onboarding/last-workspace-cookie';

/** The standard marketing CTA pair, reused inside blog posts. */
export function BlogCta() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleStart = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? latestWorkspacePath(user?.id) : '/auth';
  }, [user]);

  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
      <Button size="lg" onClick={handleStart}>
        Get started
        <HiArrowRight className="size-4" />
      </Button>
      <Button size="lg" variant="secondary" onClick={() => openDemo()}>
        Request demo
      </Button>
    </div>
  );
}
