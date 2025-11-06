'use client';

import * as React from 'react';
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from '@/components/ui/dialog';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PricingSection } from './pricing-section';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/hooks/billing/use-subscription';
import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

interface PlanSelectionModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    returnUrl?: string;
    creditsExhausted?: boolean;
}

export function PlanSelectionModal({
    open,
    onOpenChange,
    returnUrl,
    creditsExhausted = false,
}: PlanSelectionModalProps) {
    const defaultReturnUrl = typeof window !== 'undefined' ? window.location.href : '/';
    const queryClient = useQueryClient();
    const searchParams = useSearchParams();
    const router = useRouter();

    // Check for checkout success when modal opens and invalidate queries
    useEffect(() => {
        if (open) {
            const checkoutSuccess = searchParams.get('checkout');
            const sessionId = searchParams.get('session_id');
            const clientSecret = searchParams.get('client_secret');
            
            // If we have checkout success indicators, invalidate billing queries
            if (checkoutSuccess === 'success' || sessionId || clientSecret) {
                console.log('🔄 Checkout success detected in modal, invalidating billing queries...');
                queryClient.invalidateQueries({ queryKey: billingKeys.all });
                
                // Clean up URL params
                const url = new URL(window.location.href);
                url.searchParams.delete('checkout');
                url.searchParams.delete('session_id');
                url.searchParams.delete('client_secret');
                router.replace(url.pathname + url.search, { scroll: false });
            }
        }
    }, [open, searchParams, queryClient, router]);

    const handleSubscriptionUpdate = () => {
        // Invalidate all billing queries
        queryClient.invalidateQueries({ queryKey: billingKeys.all });
        // Close modal after successful upgrade
        setTimeout(() => {
            onOpenChange(false);
        }, 500);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent 
                className={cn(
                    "max-w-[100vw] w-full h-full max-h-[100vh] p-0 gap-0 overflow-hidden",
                    "rounded-none border-0",
                    "!top-0 !left-0 !translate-x-0 !translate-y-0 !max-w-none"
                )}
                hideCloseButton={true}
            >
                {/* Visually hidden title for accessibility */}
                <DialogTitle className="sr-only">
                    {creditsExhausted ? 'You\'re out of credits' : 'Select a Plan'}
                </DialogTitle>
                
                {/* Header with Logo and Close Button */}
                <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-5 pointer-events-none bg-background/95 backdrop-blur-sm border-b border-border/50">
                    {/* Spacer for centering */}
                    <div className="flex-1" />
                    
                    {/* Kortix Logo - Dead Center */}
                    <div className="absolute left-1/2 -translate-x-1/2 pointer-events-none">
                        <KortixLogo size={20} variant="logomark" />
                    </div>
                    
                    {/* Close button - Right aligned */}
                    <div className="flex-1 flex justify-end pointer-events-auto">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onOpenChange(false)}
                            className="h-9 w-9 rounded-full bg-background/80 backdrop-blur-sm hover:bg-background/90 border border-border/50 transition-all"
                        >
                            <X className="h-4 w-4" />
                            <span className="sr-only">Close</span>
                        </Button>
                    </div>
                </div>

                {/* Full-screen pricing content - Single viewport, centered */}
                <div className="w-full h-full flex items-center justify-center overflow-hidden bg-background pt-[67px]">
                    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-center">
                        <PricingSection
                            returnUrl={returnUrl || defaultReturnUrl}
                            showTitleAndTabs={true}
                            insideDialog={false}
                            noPadding={true}
                            customTitle={creditsExhausted ? "You ran out of credits. Upgrade now." : undefined}
                            onSubscriptionUpdate={handleSubscriptionUpdate}
                        />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

