'use client';

import { RouteErrorFallback } from '@/components/common/route-error';

export default function AdminError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorFallback {...props} />;
}
