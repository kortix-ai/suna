'use client';

import { KortixLoader } from '@/components/ui/kortix-loader';

// This component will be shown while the route is loading
export default function Loading() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <KortixLoader size="large" />
    </div>
  );
}
