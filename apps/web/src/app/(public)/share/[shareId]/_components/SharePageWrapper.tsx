'use client';

import { AppProviders } from '@/features/layout/app-providers';
import { createClient } from '@/lib/supabase/client';
import { useParams } from 'next/navigation';
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { MobileAppBanner } from './MobileAppBanner';

const PresentationViewerWrapper = lazy(() =>
  import('@/stores/presentation-viewer-store').then((mod) => ({
    default: mod.PresentationViewerWrapper,
  })),
);

export function SharePageWrapper({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const shareId = params?.shareId as string;
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        setIsLoggedIn(!!session);
      } catch {
        setIsLoggedIn(false);
      } finally {
        setIsChecking(false);
      }
    };
    checkAuth();
  }, []);

  // Don't block render — show content immediately for anon users
  if (isChecking) {
    return <div className="flex-1">{children}</div>;
  }

  // Logged-in: keep shared providers, but do not mount legacy dashboard sidebars
  // or global instance/settings modals on the repo-first v1 surface.
  if (isLoggedIn) {
    return (
      <AppProviders
        showSidebar={false}
        showRightSidebar={false}
        showGlobalNewInstanceModal={false}
        showGlobalUserSettingsModal={false}
      >
        {children}
        <Suspense fallback={null}>
          <PresentationViewerWrapper />
        </Suspense>
        {shareId && <MobileAppBanner shareId={shareId} />}
      </AppProviders>
    );
  }

  // Anonymous: render without sidebar or auth providers
  return (
    <div className="flex-1">
      {children}
      <Suspense fallback={null}>
        <PresentationViewerWrapper />
      </Suspense>
      {shareId && <MobileAppBanner shareId={shareId} />}
    </div>
  );
}
