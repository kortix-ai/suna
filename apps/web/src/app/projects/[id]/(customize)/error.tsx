'use client';

import { RouteErrorFallback } from '@/components/common/route-error';

export default function CustomizeError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorFallback {...props} />;
}
