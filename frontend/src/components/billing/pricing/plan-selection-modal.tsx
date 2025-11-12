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
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { usePricingModalStore } from '@/stores/pricing-modal-store';

interface PlanSelectionModalProps {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    returnUrl?: string;
    creditsExhausted?: boolean;
    upgradeReason?: string;
}

export function PlanSelectionModal({
    open: controlledOpen,
    onOpenChange: controlledOnOpenChange,
    returnUrl: controlledReturnUrl,
    creditsExhausted = false,
    upgradeReason: controlledUpgradeReason,
}: PlanSelectionModalProps) {
    const defaultReturnUrl = typeof window !== 'undefined' ? window.location.href : '/';
    const queryClient = useQueryClient();
    const router = useRouter();
    
    const { isOpen: storeIsOpen, customTitle: storeCustomTitle, returnUrl: storeReturnUrl, closePricingModal, isAlert: storeIsAlert, alertTitle: storeAlertTitle } = usePricingModalStore();
    
    const isOpen = controlledOpen !== undefined ? controlledOpen : storeIsOpen;
    const onOpenChange = controlledOnOpenChange || ((open: boolean) => !open && closePricingModal());
    const returnUrl = controlledReturnUrl || storeReturnUrl || defaultReturnUrl;
    const displayReason = controlledUpgradeReason || storeCustomTitle;

    useEffect(() => {
        if (isOpen && typeof window !== 'undefined') {
            // Use URLSearchParams directly from window.location instead of useSearchParams()
            // This avoids the Suspense boundary requirement
            const searchParams = new URLSearchParams(window.location.search);
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
    }, [isOpen, queryClient, router]);

    const handleSubscriptionUpdate = () => {
        // Invalidate all billing queries
        queryClient.invalidateQueries({ queryKey: billingKeys.all });
        // Close modal after successful upgrade
        setTimeout(() => {
            onOpenChange(false);
        }, 500);
    };

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent 
                className={cn(
                    "max-w-[100vw] w-full h-full max-h-[100vh] p-0 gap-0 overflow-hidden",
                    "rounded-none border-0",
                    "!top-0 !left-0 !translate-x-0 !translate-y-0 !max-w-none"
                )}
                hideCloseButton={true}
            >
                <DialogTitle className="sr-only">
                    {displayReason || (creditsExhausted ? 'You\'re out of credits' : 'Select a Plan')}
                </DialogTitle>
                <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-5 pointer-events-none bg-transparent">
                    <div className="flex-1" />
                    
                    <div className="absolute -translate-y-1/2 top-1/2 left-1/2 -translate-x-1/2 pointer-events-none">
                        <KortixLogo size={20} variant="logomark" />
                    </div>
                    
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
                <div className="w-full h-full flex items-center justify-center overflow-hidden bg-background pt-[67px]">
                    <div className="xl:scale-90 2xl:scale-100 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-center">
                        <PricingSection
                            returnUrl={returnUrl || defaultReturnUrl}
                            showTitleAndTabs={true}
                            insideDialog={false}
                            noPadding={true}
                            customTitle={displayReason || (creditsExhausted ? "You ran out of credits. Upgrade now." : undefined)}
                            isAlert={storeIsAlert}
                            alertTitle={storeAlertTitle}
                            onSubscriptionUpdate={handleSubscriptionUpdate}
                        />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

