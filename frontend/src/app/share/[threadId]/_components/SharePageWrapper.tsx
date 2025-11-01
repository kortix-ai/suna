'use client';

import React, { useEffect, useState } from 'react';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { SidebarLeft } from '@/components/sidebar/sidebar-left';
import { createClient } from '@/lib/supabase/client';
import { DeleteOperationProvider } from '@/contexts/DeleteOperationContext';
import { SubscriptionProvider } from '@/contexts/SubscriptionContext';

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

    // Still loading auth state - don't render children yet
    if (isChecking) {
        return null;
    }

    // If user is logged in, wrap with all necessary providers and show sidebar
    if (isLoggedIn) {
        return (
            <DeleteOperationProvider>
                <SubscriptionProvider>
                    <SidebarProvider>
                        <SidebarLeft />
                        <SidebarInset>
                            {children}
                        </SidebarInset>
                    </SidebarProvider>
                </SubscriptionProvider>
            </DeleteOperationProvider>
        );
    }

    // If not logged in, just render children without sidebar but centered
    return <div className="flex-1">{children}</div>;
}
