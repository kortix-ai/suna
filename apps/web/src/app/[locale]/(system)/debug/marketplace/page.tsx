'use client';

import { useEffect, useState } from 'react';

import { MarketplaceView } from '@/features/marketplace/marketplace-view';
import { setBootstrapAuthToken } from '@/lib/auth-token';

export default function DebugMarketplacePage() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setBootstrapAuthToken('debug-marketplace-token');
    setReady(true);
    return () => {
      setBootstrapAuthToken(null);
    };
  }, []);

  if (!ready) return null;

  return (
    <main className="bg-background text-foreground h-screen" data-testid="marketplace-view">
      <MarketplaceView projectId="debug-marketplace-project" />
    </main>
  );
}
