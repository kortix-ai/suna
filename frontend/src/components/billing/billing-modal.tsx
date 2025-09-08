'use client';

import { useEffect, useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { PricingSection } from '@/components/home/sections/pricing-section';
import { CreditBalanceDisplay, CreditPurchaseModal } from '@/components/billing/credit-purchase';
import { isLocalMode } from '@/lib/config';
import {
    getSubscription,
    createPortalSession,
    cancelSubscription,
    reactivateSubscription,
    SubscriptionStatus,
} from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { useSubscriptionCommitment } from '@/hooks/react-query/subscriptions/use-subscriptions';
import { useQueryClient } from '@tanstack/react-query';
import { subscriptionKeys } from '@/hooks/react-query/subscriptions/keys';
import { Skeleton } from '@/components/ui/skeleton';
import { 
    X, 
    Zap, 
    AlertTriangle, 
    Shield, 
    CheckCircle, 
    RotateCcw, 
    Clock 
} from 'lucide-react';
import { toast } from 'sonner';

interface BillingModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    returnUrl?: string;
    showUsageLimitAlert?: boolean;
}

export function BillingModal({ open, onOpenChange, returnUrl = typeof window !== 'undefined' ? window?.location?.href || '/' : '/', showUsageLimitAlert = false }: BillingModalProps) {
    const { session, isLoading: authLoading } = useAuth();
    const queryClient = useQueryClient();
    const [subscriptionData, setSubscriptionData] = useState<SubscriptionStatus | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isManaging, setIsManaging] = useState(false);
    const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);
    const [showCancelDialog, setShowCancelDialog] = useState(false);
    const [isCancelling, setIsCancelling] = useState(false);

    const {
        data: commitmentInfo,
        isLoading: commitmentLoading,
        error: commitmentError,
        refetch: refetchCommitment
    } = useSubscriptionCommitment(subscriptionData?.subscription?.id || null);

    const fetchSubscriptionData = async () => {
        if (!session) return;

        try {
            setIsLoading(true);
            const data = await getSubscription();
            setSubscriptionData(data);
            setError(null);
            return data;
        } catch (err) {
            console.error('Failed to get subscription:', err);
            setError(err instanceof Error ? err.message : 'Failed to load subscription data');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (!open || authLoading || !session) return;
        fetchSubscriptionData();
    }, [open, session, authLoading]);

    const formatDate = (timestamp: number) => {
        return new Date(timestamp * 1000).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    };

    const formatEndDate = (dateString: string) => {
        try {
            return new Date(dateString).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        } catch {
            return dateString;
        }
    };

    // Get the effective cancellation date (could be period end or cancel_at for yearly commitments)
    const getEffectiveCancellationDate = () => {
        if (subscriptionData?.subscription?.cancel_at) {
            // Yearly commitment cancellation - use cancel_at timestamp
            return formatDate(subscriptionData.subscription.cancel_at);
        }
        // Regular cancellation - use current period end
        return formatDate(subscriptionData?.subscription?.current_period_end || 0);
    };

    const handleManageSubscription = async () => {
        try {
            setIsManaging(true);
            const { url } = await createPortalSession({ return_url: returnUrl });
            window.location.href = url;
        } catch (err) {
            console.error('Failed to create portal session:', err);
            setError(err instanceof Error ? err.message : 'Failed to create portal session');
        } finally {
            setIsManaging(false);
        }
    };

    const handleCancel = async () => {
        setIsCancelling(true);
        const originalState = subscriptionData;
        
        try {
            console.log('Cancelling subscription...');
            setShowCancelDialog(false);

            // Optimistic update - show cancelled state immediately
            if (subscriptionData?.subscription) {
                const optimisticState = {
                    ...subscriptionData,
                    subscription: {
                        ...subscriptionData.subscription,
                        cancel_at_period_end: true,
                        ...(commitmentInfo?.has_commitment && commitmentInfo.commitment_end_date ? {
                            cancel_at: Math.floor(new Date(commitmentInfo.commitment_end_date).getTime() / 1000)
                        } : {})
                    }
                };
                setSubscriptionData(optimisticState);
            }

            const response = await cancelSubscription();

            if (response.success) {
                toast.success(response.message);
            } else {
                setSubscriptionData(originalState);
                toast.error(response.message);
            }
        } catch (error: any) {
            console.error('Error cancelling subscription:', error);
            setSubscriptionData(originalState);
            toast.error(error.message || 'Failed to cancel subscription');
        } finally {
            setIsCancelling(false);
        }
    };

    const handleReactivate = async () => {
        setIsCancelling(true);
        const originalState = subscriptionData;
        
        try {
            console.log('Reactivating subscription...');

            // Optimistic update - show active state immediately
            if (subscriptionData?.subscription) {
                const optimisticState = {
                    ...subscriptionData,
                    subscription: {
                        ...subscriptionData.subscription,
                        cancel_at_period_end: false,
                        cancel_at: undefined
                    }
                };
                setSubscriptionData(optimisticState);
            }

            const response = await reactivateSubscription();

            if (response.success) {
                toast.success(response.message);
            } else {
                setSubscriptionData(originalState);
                toast.error(response.message);
            }
        } catch (error: any) {
            console.error('Error reactivating subscription:', error);
            setSubscriptionData(originalState);
            toast.error(error.message || 'Failed to reactivate subscription');
        } finally {
            setIsCancelling(false);
        }
    };

    // Local mode content
    if (isLocalMode()) {
        return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Billing & Subscription</DialogTitle>
                    </DialogHeader>
                    <div className="p-4 bg-muted/30 border border-border rounded-lg text-center">
                        <p className="text-sm text-muted-foreground">
                            Running in local development mode - billing features are disabled
                        </p>
                        <p className="text-xs text-muted-foreground mt-2">
                            All premium features are available in this environment
                        </p>
                    </div>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-5xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Upgrade Your Plan</DialogTitle>
                </DialogHeader>

                <>
                    <PricingSection 
                        returnUrl={returnUrl} 
                        showTitleAndTabs={false}
                        onSubscriptionUpdate={() => {
                            setTimeout(() => {
                                fetchSubscriptionData();
                            }, 500);
                        }}
                    />
                    {error ? (
                        <div className="mt-6 pt-4 border-t border-border">
                            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-center">
                                <p className="text-sm text-destructive">Error loading billing status: {error}</p>
                            </div>
                        </div>
                    ) : subscriptionData?.subscription && (
                        <div className="mt-6 pt-4 border-t border-border">
                            <div className="bg-muted/30 border border-border rounded-lg p-3 mb-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-medium">
                                            {subscriptionData.subscription.cancel_at_period_end || subscriptionData.subscription.cancel_at 
                                                ? 'Plan Status' 
                                                : 'Current Plan'}
                                        </span>
                                        {commitmentInfo?.has_commitment && (
                                            <Badge variant="outline" className="text-xs px-1.5 py-0">
                                                {commitmentInfo.months_remaining || 0}mo left
                                            </Badge>
                                        )}
                                    </div>
                                    <Badge variant={
                                        subscriptionData.subscription.cancel_at_period_end || subscriptionData.subscription.cancel_at 
                                            ? 'destructive' 
                                            : 'secondary'
                                    } className="text-xs px-2 py-0.5">
                                        {subscriptionData.subscription.cancel_at_period_end || subscriptionData.subscription.cancel_at
                                            ? 'Ending ' + getEffectiveCancellationDate()
                                            : 'Active'}
                                    </Badge>
                                </div>

                                {/* Cancellation Alert */}
                                {(subscriptionData.subscription.cancel_at_period_end || subscriptionData.subscription.cancel_at) && (
                                    <div className="mt-2 flex items-start gap-2 p-2 bg-destructive/5 border border-destructive/20 rounded">
                                        <AlertTriangle className="h-3 w-3 text-destructive mt-0.5 flex-shrink-0" />
                                        <p className="text-xs text-destructive">
                                            {subscriptionData.subscription.cancel_at ? 
                                                'Your plan is scheduled to end at commitment completion. You can reactivate anytime.' : 
                                                'Your plan is scheduled to end at period completion. You can reactivate anytime.'
                                            }
                                        </p>
                                    </div>
                                )}
                            </div>

                            <div className="flex gap-2 justify-center">
                                {!(subscriptionData.subscription.cancel_at_period_end || subscriptionData.subscription.cancel_at) ? (
                                    <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
                                        <DialogTrigger asChild>
                                            <Button 
                                                variant="outline" 
                                                size="sm" 
                                                className="text-xs"
                                                disabled={isCancelling}
                                            >
                                                {isCancelling ? (
                                                    <div className="flex items-center gap-1">
                                                        <div className="animate-spin h-3 w-3 border border-current border-t-transparent rounded-full" />
                                                        Processing...
                                                    </div>
                                                ) : (
                                                    commitmentInfo?.has_commitment && !commitmentInfo?.can_cancel 
                                                        ? 'Schedule End' 
                                                        : 'Cancel Plan'
                                                )}
                                            </Button>
                                        </DialogTrigger>
                                        <DialogContent className="max-w-md">
                                            <DialogHeader>
                                                <DialogTitle className="text-lg">
                                                    {commitmentInfo?.has_commitment && !commitmentInfo?.can_cancel
                                                        ? 'Schedule Cancellation' 
                                                        : 'Cancel Subscription'}
                                                </DialogTitle>
                                                <DialogDescription className="text-sm">
                                                    {commitmentInfo?.has_commitment && !commitmentInfo?.can_cancel ? (
                                                        <>
                                                            Your subscription will be scheduled to end on{' '}
                                                            {commitmentInfo?.commitment_end_date
                                                                ? formatEndDate(commitmentInfo.commitment_end_date)
                                                                : 'your commitment end date'}
                                                            . You'll keep full access until then.
                                                        </>
                                                    ) : (
                                                        <>
                                                            Your subscription will end on{' '}
                                                            {formatDate(subscriptionData.subscription.current_period_end)}. 
                                                            You'll keep access until then.
                                                        </>
                                                    )}
                                                </DialogDescription>
                                            </DialogHeader>
                                            <DialogFooter>
                                                <Button
                                                    variant="outline"
                                                    onClick={() => setShowCancelDialog(false)}
                                                    disabled={isCancelling}
                                                    size="sm"
                                                >
                                                    Keep Plan
                                                </Button>
                                                <Button
                                                    variant="destructive"
                                                    onClick={handleCancel}
                                                    disabled={isCancelling}
                                                    size="sm"
                                                >
                                                    {isCancelling ? 'Processing...' : 'Confirm'}
                                                </Button>
                                            </DialogFooter>
                                        </DialogContent>
                                    </Dialog>
                                ) : (
                                    <Button
                                        variant="default"
                                        size="sm"
                                        onClick={handleReactivate}
                                        disabled={isCancelling}
                                        className="text-xs bg-green-600 hover:bg-green-700 text-white"
                                    >
                                        {isCancelling ? (
                                            <div className="flex items-center gap-1">
                                                <div className="animate-spin h-3 w-3 border border-white border-t-transparent rounded-full" />
                                                Processing...
                                            </div>
                                        ) : (
                                            'Reactivate Plan'
                                        )}
                                    </Button>
                                )}

                                {/* Manage Subscription Button */}
                                <Button
                                    onClick={handleManageSubscription}
                                    disabled={isManaging}
                                    variant="outline"
                                    size="sm"
                                    className="text-xs"
                                >
                                    {isManaging ? 'Loading...' : 'Dashboard'}
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            </DialogContent>
            
            {/* Credit Purchase Modal */}
            <CreditPurchaseModal
                open={showCreditPurchaseModal}
                onOpenChange={setShowCreditPurchaseModal}
                currentBalance={subscriptionData?.credit_balance || 0}
                canPurchase={subscriptionData?.can_purchase_credits || false}
                onPurchaseComplete={() => {
                    // Refresh subscription data
                    getSubscription().then(setSubscriptionData);
                    setShowCreditPurchaseModal(false);
                }}
            />
        </Dialog>
    );
} 