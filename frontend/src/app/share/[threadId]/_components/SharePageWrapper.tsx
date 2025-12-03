'use client';

import React, { useEffect, useState, Suspense, lazy } from 'react';
import { createClient } from '@/lib/supabase/client';
import { AppProviders } from '@/components/layout/app-providers';

// Lazy load presentation modal (only needed when presentations are opened)
const PresentationViewerWrapper = lazy(() =>
  import('@/stores/presentation-viewer-store').then(mod => ({ default: mod.PresentationViewerWrapper }))
);

export function SharePageWrapper({ children }: { children: React.ReactNode }) {
    const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
    const [isChecking, setIsChecking] = useState(true);

    useEffect(() => {
        const checkAuth = async () => {
            try {
                const supabase = createClient();
                const { data: { session } } = await supabase.auth.getSession();
                setIsLoggedIn(!!session);
            } catch (error) {
                console.error('Auth check failed:', error);
                setIsLoggedIn(false);
            } finally {
                setIsChecking(false);
            }
        };
        checkAuth();
    }, []);

    // Don't block render - show content immediately for anon users
    if (isChecking) {
        return <div className="flex-1">{children}</div>;
    }

    // If user is logged in, wrap with all necessary providers and show sidebar
    if (isLoggedIn) {
        return (
            <AppProviders showSidebar={true}>
                {children}
                <Suspense fallback={null}>
                    <PresentationViewerWrapper />
                </Suspense>
            </AppProviders>
        );
    }

    // Anon user: render children without sidebar or subscription sync (no auth required)
    return (
        <div className="flex-1">
            {children}
            <Suspense fallback={null}>
                <PresentationViewerWrapper />
            </Suspense>
        </div>
    );
}
