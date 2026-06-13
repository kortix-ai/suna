'use client';

import { RouteErrorFallback } from '@/components/common/route-error';

export default function ShareError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorFallback
      {...props}
      description="We couldn't load this shared page. Try again, or reload if it keeps happening."
    />
  );
}
