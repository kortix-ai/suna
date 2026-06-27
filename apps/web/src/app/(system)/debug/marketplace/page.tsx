'use client';

import { useEffect, useState } from 'react';

import { MarketplaceBrowser } from '@/components/marketplace/marketplace-browser';
import { MarketplaceInstalledPanel } from '@/components/marketplace/marketplace-installed-panel';
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
    <main className="bg-background text-foreground min-h-screen p-8">
      <div className="mx-auto grid max-w-6xl gap-8">
        <section data-testid="marketplace-explore">
          <h1 className="mb-4 text-lg font-semibold">Marketplace Explore</h1>
          <MarketplaceBrowser installedNames={new Set(['pdf'])} onAdd={() => undefined} />
        </section>

        <section data-testid="marketplace-installed">
          <h2 className="mb-4 text-lg font-semibold">Marketplace Installed</h2>
          <MarketplaceInstalledPanel
            projectId="debug-marketplace-project"
            onBrowse={() => undefined}
          />
        </section>
      </div>
    </main>
  );
}
