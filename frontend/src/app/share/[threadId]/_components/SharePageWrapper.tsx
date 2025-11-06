'use client';

import React, { useEffect, useState } from 'react';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { SidebarLeft } from '@/components/sidebar/sidebar-left';
import { createClient } from '@/lib/supabase/client';
import { useDeleteOperationEffects } from '@/stores/delete-operation-store';
import { SubscriptionStoreSync } from '@/stores/subscription-store';

// Wrapper component to handle delete operation side effects
function DeleteOperationEffectsWrapper({ children }: { children: React.ReactNode }) {
    useDeleteOperationEffects();
    return <>{children}</>;
}

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
            <DeleteOperationEffectsWrapper>
                <SubscriptionStoreSync>
                    <SidebarProvider>
                        <SidebarLeft />
                        <SidebarInset>
                            {children}
                        </SidebarInset>
                    </SidebarProvider>
                </SubscriptionStoreSync>
            </DeleteOperationEffectsWrapper>
        );
    }

    // Anon user: render children without sidebar or subscription sync (no auth required)
    return <div className="flex-1">{children}</div>;
}
