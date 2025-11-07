'use client';

import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Settings,
    CreditCard,
    KeyRound,
    X,
    Trash2,
    TrendingDown,
    ExternalLink,
    Info,
    FileText,
    Plug,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { isLocalMode } from '@/lib/config';
import { LocalEnvManager } from '@/components/env-manager/local-env-manager';
import { useIsMobile } from '@/hooks/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { useQueryClient } from '@tanstack/react-query';
import { 
    useAccountDeletionStatus, 
    useRequestAccountDeletion, 
    useCancelAccountDeletion 
} from '@/hooks/account/use-account-deletion';
import { SubscriptionInfo } from '@/lib/api/billing';
import { useAuth } from '@/components/AuthProvider';
import { PlanSelectionModal, PricingSection } from '@/components/billing/pricing';
import { CreditBalanceDisplay, CreditPurchaseModal } from '@/components/billing/credit-purchase';
import { ScheduledDowngradeCard } from '@/components/billing/scheduled-downgrade-card';
import { 
    useSubscription, 
    useSubscriptionCommitment, 
    useCreatePortalSession,
    useCancelSubscription,
    useReactivateSubscription,
    useCreditBalance,
    useScheduledChanges,
    billingKeys
} from '@/hooks/billing';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Zap,
    AlertTriangle,
    Shield,
    CheckCircle,
    RotateCcw,
    Clock,
    Infinity,
    ShoppingCart,
    Lightbulb
} from 'lucide-react';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { getPlanName, getPlanIcon } from '../billing/plan-utils';
import ThreadUsage from '@/components/billing/thread-usage';
import { formatCredits } from '@/lib/utils/credit-formatter';

type TabId = 'general' | 'plan' | 'billing' | 'usage' | 'env-manager' | 'knowledge-base' | 'integrations';

interface Tab {
    id: TabId;
    label: string;
    icon: React.ElementType;
    disabled?: boolean;
}interface UserSettingsModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void; 
    defaultTab?: TabId;
    returnUrl?: string;
}

export function UserSettingsModal({
    open,
    onOpenChange,
    defaultTab = 'general',
    returnUrl = typeof window !== 'undefined' ? window?.location?.href || '/' : '/',
}: UserSettingsModalProps) {
    const isMobile = useIsMobile();
    const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
    const [showPlanModal, setShowPlanModal] = useState(false);
    const isLocal = isLocalMode();
    const tabs: Tab[] = [
        { id: 'general', label: 'General', icon: Settings },
        { id: 'plan', label: 'Plan', icon: Zap },
        { id: 'billing', label: 'Billing', icon: CreditCard },
        { id: 'usage', label: 'Usage', icon: TrendingDown },
        { id: 'knowledge-base', label: 'Knowledge Base', icon: FileText },
        { id: 'integrations', label: 'Integrations', icon: Plug },
        ...(isLocal ? [{ id: 'env-manager' as TabId, label: 'Env Manager', icon: KeyRound }] : []),
    ];
    
    useEffect(() => {
        setActiveTab(defaultTab);
    }, [defaultTab]);

    const handleTabClick = (tabId: TabId) => {
        if (tabId === 'plan') {
            setShowPlanModal(true);
        } else if (tabId === 'knowledge-base') {
            window.open('/knowledge', '_blank');
        } else if (tabId === 'integrations') {
            window.open('/settings/credentials', '_blank');
        } else {
            setActiveTab(tabId);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    "p-0 gap-0 overflow-hidden",
                    isMobile ? "w-full h-full max-w-full rounded-none" : "max-w-6xl max-h-[90vh]"
                )}
                hideCloseButton={true}
            >
                <DialogTitle className="sr-only">Settings</DialogTitle>
                {isMobile && (
                    <DialogHeader className="p-4 border-b border-border">
                        <div className="flex items-center justify-between">
                            <div className="text-lg font-semibold">Settings</div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => onOpenChange(false)}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    </DialogHeader>
                )}                
                <div className={cn("flex", isMobile ? "flex-col h-full" : "flex-row  h-[700px]")}>
                    <div className={cn(
                        "bg-background",
                        isMobile ? "p-2" : "w-56 p-4"
                    )}>
                        {!isMobile && (
                            <div className="flex justify-start mb-3">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={() => onOpenChange(false)}
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        )}
                        <div className={cn(
                            "flex gap-2",
                            isMobile ? "flex-row overflow-x-auto" : "flex-col"
                        )}>
                            {tabs.map((tab) => {
                                const Icon = tab.icon;
                                const isActive = activeTab === tab.id;

                                return (
                                    <SpotlightCard
                                        key={tab.id}
                                        className={cn(
                                            "transition-colors cursor-pointer",
                                            isActive ? "bg-muted" : "bg-transparent"
                                        )}
                                    >
                                        <button
                                            onClick={() => handleTabClick(tab.id)}
                                            disabled={tab.disabled}
                                            className={cn(
                                                "w-full flex items-center gap-3 px-4 py-3 text-sm",
                                                isActive
                                                    ? "text-foreground"
                                                    : "text-muted-foreground"
                                            )}
                                        >
                                            <Icon className="h-4 w-4" />
                                            {tab.label}
                                        </button>
                                    </SpotlightCard>
                                );
                            })}
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {activeTab === 'general' && <GeneralTab onClose={() => onOpenChange(false)} />}
                        {activeTab === 'billing' && <BillingTab returnUrl={returnUrl} onOpenPlanModal={() => setShowPlanModal(true)} isActive={activeTab === 'billing'} />}
                        {activeTab === 'usage' && <UsageTab />}
                        {activeTab === 'env-manager' && isLocal && <EnvManagerTab />}
                        {activeTab === 'knowledge-base' && <KnowledgeBaseTab />}
                        {activeTab === 'integrations' && <IntegrationsTab />}
                    </div>
                </div>

                {/* Full-screen Plan Selection Modal */}
                <PlanSelectionModal
                    open={showPlanModal}
                    onOpenChange={setShowPlanModal}
                    returnUrl={returnUrl}
                />
            </DialogContent>
        </Dialog>
    );
}

function GeneralTab({ onClose }: { onClose: () => void }) {
    const [userName, setUserName] = useState('');
    const [userEmail, setUserEmail] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [showCancelDialog, setShowCancelDialog] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const supabase = createClient();

    const { data: deletionStatus, isLoading: isCheckingStatus } = useAccountDeletionStatus();
    const requestDeletion = useRequestAccountDeletion();
    const cancelDeletion = useCancelAccountDeletion();

    useEffect(() => {
        const fetchUserData = async () => {
            setIsLoading(true);
            const { data } = await supabase.auth.getUser();
            if (data.user) {
                setUserName(data.user.user_metadata?.name || data.user.email?.split('@')[0] || '');
                setUserEmail(data.user.email || '');
            }
            setIsLoading(false);
        };

        fetchUserData();
    }, []);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const { data, error } = await supabase.auth.updateUser({
                data: { name: userName }
            });

            if (error) throw error;

            toast.success('Profile updated successfully');

            setTimeout(() => {
                window.location.reload();
            }, 500);
        } catch (error) {
            console.error('Error updating profile:', error);
            toast.error('Failed to update profile');
        } finally {
            setIsSaving(false);
        }
    };

    const handleRequestDeletion = async () => {
        await requestDeletion.mutateAsync('User requested deletion');
        setShowDeleteDialog(false);
        setDeleteConfirmText('');
    };

    const handleCancelDeletion = async () => {
        await cancelDeletion.mutateAsync();
        setShowCancelDialog(false);
    };

    const formatDate = (dateString: string | null) => {
        if (!dateString) return '';
        return new Date(dateString).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    };

    if (isLoading) {
        return (
            <div className="p-6 space-y-6">
                <Skeleton className="h-8 w-32" />
                <div className="space-y-4">
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-20 w-full" />
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 space-y-6">
            <div>
                <h3 className="text-lg font-semibold mb-1">Profile Settings</h3>
                <p className="text-sm text-muted-foreground">
                    Manage your account information
                </p>
            </div>

            <div className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                        id="name"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                        placeholder="Enter your name"
                        className="shadow-none"
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                        id="email"
                        value={userEmail}
                        disabled
                        className="bg-muted/50 cursor-not-allowed shadow-none"
                    />
                    <p className="text-xs text-muted-foreground">
                        Email cannot be changed from here
                    </p>
                </div>
            </div>

            <div className="flex justify-end gap-2 pt-4">
                <Button
                    variant="outline"
                    onClick={onClose}
                >
                    Cancel
                </Button>
                <Button
                    onClick={handleSave}
                    disabled={isSaving}
                >
                    {isSaving ? 'Saving...' : 'Save Changes'}
                </Button>
            </div>

            {!isLocalMode() && (
                <>
                    <div className="pt-8 space-y-4">
                        <div>
                            <h3 className="text-base font-medium mb-1">Delete Account</h3>
                            <p className="text-sm text-muted-foreground">
                                Permanently remove your account and all associated data
                            </p>
                        </div>

                        {deletionStatus?.has_pending_deletion ? (
                            <Alert className="shadow-none border-amber-500/30 bg-amber-500/5">
                                <Clock className="h-4 w-4 text-amber-600" />
                                <AlertDescription>
                                    <div className="text-sm">
                                        <strong className="text-foreground">Deletion Scheduled</strong>
                                        <p className="mt-1 text-muted-foreground">
                                            Your account will be permanently deleted on{' '}
                                            <strong className="text-foreground">{formatDate(deletionStatus.deletion_scheduled_for)}</strong>.
                                        </p>
                                        <p className="mt-2 text-muted-foreground">
                                            You can cancel this request anytime before the deletion date.
                                        </p>
                                    </div>
                                </AlertDescription>
                                <div className="mt-3">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setShowCancelDialog(true)}
                                        disabled={cancelDeletion.isPending}
                                    >
                                        Cancel Deletion Request
                                    </Button>
                                </div>
                            </Alert>
                        ) : (
                            <Button
                                variant="outline"
                                onClick={() => setShowDeleteDialog(true)}
                                className="text-muted-foreground hover:text-foreground"
                            >
                                Delete Account
                            </Button>
                        )}
                    </div>

                    <Dialog open={showDeleteDialog} onOpenChange={(open) => {
                        setShowDeleteDialog(open);
                        if (!open) setDeleteConfirmText('');
                    }}>
                        <DialogContent className="max-w-md">
                            <DialogHeader>
                                <DialogTitle>Delete Account</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4">
                                <Alert className="shadow-none border-amber-500/30 bg-amber-500/5">
                                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                                    <AlertDescription>
                                        <strong className="text-foreground">This action cannot be undone after 30 days</strong>
                                    </AlertDescription>
                                </Alert>
                                <div>
                                    <p className="text-sm font-medium mb-2">
                                        When you delete your account:
                                    </p>
                                    <ul className="text-sm text-muted-foreground space-y-1.5 pl-5 list-disc">
                                        <li>All your agents and agent versions will be deleted</li>
                                        <li>All your threads and conversations will be deleted</li>
                                        <li>All your credentials and integrations will be removed</li>
                                        <li>Your subscription will be cancelled</li>
                                        <li>All billing data will be removed</li>
                                        <li>Your account will be scheduled for deletion in 30 days</li>
                                    </ul>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    You can cancel this request anytime within the 30-day grace period.
                                    After 30 days, all your data will be permanently deleted and cannot be recovered.
                                </p>
                                
                                <div className="space-y-2">
                                    <Label htmlFor="delete-confirm">
                                        Type <strong>delete</strong> to confirm
                                    </Label>
                                    <Input
                                        id="delete-confirm"
                                        value={deleteConfirmText}
                                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                                        placeholder="delete"
                                        className="shadow-none"
                                        autoComplete="off"
                                    />
                                </div>
                                
                                <div className="flex gap-2 justify-end">
                                    <Button variant="outline" onClick={() => {
                                        setShowDeleteDialog(false);
                                        setDeleteConfirmText('');
                                    }}>
                                        Keep Account
                                    </Button>
                                    <Button 
                                        variant="destructive" 
                                        onClick={handleRequestDeletion} 
                                        disabled={requestDeletion.isPending || deleteConfirmText !== 'delete'}
                                    >
                                        {requestDeletion.isPending ? 'Processing...' : 'Delete Account'}
                                    </Button>
                                </div>
                            </div>
                        </DialogContent>
                    </Dialog>

                    <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
                        <AlertDialogContent className="max-w-md">
                            <AlertDialogHeader>
                                <AlertDialogTitle>Cancel Account Deletion</AlertDialogTitle>
                            </AlertDialogHeader>
                            <div className="space-y-4">
                                <p className="text-sm text-muted-foreground">
                                    Are you sure you want to cancel the deletion of your account?
                                    Your account and all data will be preserved.
                                </p>
                                <div className="flex gap-2 justify-end">
                                    <Button variant="outline" onClick={() => setShowCancelDialog(false)}>
                                        Back
                                    </Button>
                                    <Button 
                                        onClick={handleCancelDeletion} 
                                        disabled={cancelDeletion.isPending}
                                    >
                                        {cancelDeletion.isPending ? 'Processing...' : 'Cancel Deletion'}
                                    </Button>
                                </div>
                            </div>
                        </AlertDialogContent>
                    </AlertDialog>
                </>
            )}
        </div>
    );
}

// Billing Tab Component - Usage, credits, subscription management
function BillingTab({ returnUrl, onOpenPlanModal, isActive }: { returnUrl: string; onOpenPlanModal: () => void; isActive: boolean }) {
    const { session, isLoading: authLoading } = useAuth();
    const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);
    const [showCancelDialog, setShowCancelDialog] = useState(false);
    const queryClient = useQueryClient();

    const isLocal = isLocalMode();

    // Use React Query hooks for subscription data
    const {
        data: subscriptionData,
        isLoading: isLoadingSubscription,
        error: subscriptionError,
        refetch: refetchSubscription
    } = useSubscription({
        enabled: !!session && !authLoading,
    });

    const {
        data: commitmentInfo,
        isLoading: commitmentLoading,
        error: commitmentError,
        refetch: refetchCommitment
    } = useSubscriptionCommitment(subscriptionData?.subscription?.id, !!subscriptionData?.subscription?.id);

    const {
        data: creditBalance,
        isLoading: isLoadingBalance,
        refetch: refetchBalance
    } = useCreditBalance(!!session && !authLoading);

    const {
        data: scheduledChangesData,
        refetch: refetchScheduledChanges
    } = useScheduledChanges(!!session && !authLoading);

    const createPortalSessionMutation = useCreatePortalSession();
    const cancelSubscriptionMutation = useCancelSubscription();
    const reactivateSubscriptionMutation = useReactivateSubscription();

    const planName = getPlanName(subscriptionData, isLocal);
    const planIcon = getPlanIcon(planName, isLocal);

    // Calculate days until refresh
    const getDaysUntilRefresh = () => {
        if (!creditBalance?.next_credit_grant) return null;
        const nextGrant = new Date(creditBalance.next_credit_grant);
        const now = new Date();
        const diffTime = nextGrant.getTime() - now.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays > 0 ? diffDays : null;
    };

    const daysUntilRefresh = getDaysUntilRefresh();
    const expiringCredits = creditBalance?.expiring_credits || 0;
    const nonExpiringCredits = creditBalance?.non_expiring_credits || 0;
    const totalCredits = creditBalance?.balance || 0;

    // Refetch billing info whenever the billing tab becomes active (only once per activation)
    const prevIsActiveRef = useRef(false);
    useEffect(() => {
        // Only refetch if tab just became active (not on every render)
        if (isActive && !prevIsActiveRef.current && session && !authLoading) {
            console.log('🔄 Billing tab activated, refetching billing info...');
            // Use queryClient to invalidate instead of individual refetches to avoid cascading
            // This will trigger refetches but React Query will dedupe concurrent requests
            queryClient.invalidateQueries({ queryKey: billingKeys.all });
        }
        prevIsActiveRef.current = isActive;
        // Only depend on isActive, session, and authLoading - not the refetch functions
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive, session, authLoading]);

    const formatDate = (dateString: string) => {
        return new Date(dateString).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    };

    const formatDateFromTimestamp = (timestamp: number) => {
        return new Date(timestamp * 1000).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    };

    const formatDateFlexible = (dateValue: string | number) => {
        if (typeof dateValue === 'number') {
            // If it's a number, treat it as Unix timestamp (seconds)
            return formatDateFromTimestamp(dateValue);
        }
        // Otherwise treat it as ISO string
        return formatDate(dateValue);
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

    const getEffectiveCancellationDate = () => {
        if (subscriptionData?.subscription?.cancel_at) {
            const cancelAt = subscriptionData.subscription.cancel_at;
            if (typeof cancelAt === 'number') {
                return formatDateFromTimestamp(cancelAt);
            }
            return formatDate(cancelAt);
        }
        if (subscriptionData?.subscription?.current_period_end) {
            return formatDateFlexible(subscriptionData.subscription.current_period_end);
        }
        return 'N/A';
    };

    const handleManageSubscription = () => {
        createPortalSessionMutation.mutate({ return_url: returnUrl });
    };

    const handleCancel = () => {
        setShowCancelDialog(false);
        cancelSubscriptionMutation.mutate(undefined);
    };

    const handleReactivate = () => {
        reactivateSubscriptionMutation.mutate();
    };

    const isLoading = isLoadingSubscription || isLoadingBalance || authLoading;
    const error = subscriptionError ? (subscriptionError instanceof Error ? subscriptionError.message : 'Failed to load subscription data') : null;

    if (isLoading) {
        return (
            <div className="p-6 space-y-6">
                <Skeleton className="h-8 w-32" />
                <div className="space-y-4">
                    <Skeleton className="h-32 w-full" />
                    <Skeleton className="h-32 w-full" />
                </div>
            </div>
        );
    }

    if (isLocalMode()) {
        return (
            <div className="p-6">
                <Alert className="border-blue-500/50 bg-blue-500/10">
                    <Shield className="h-4 w-4 text-blue-500" />
                    <AlertDescription>
                        <div className="font-medium mb-1">Local Mode Active</div>
                        <div className="text-sm text-muted-foreground">
                            All premium features are available in this environment
                        </div>
                    </AlertDescription>
                </Alert>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-6">
                <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            </div>
        );
    }

    const isSubscribed = subscriptionData?.subscription?.status === 'active' || subscriptionData?.subscription?.status === 'trialing';
    const isFreeTier = subscriptionData?.tier?.name === 'free';
    const subscription = subscriptionData?.subscription;
    const isCancelled = subscription?.cancel_at_period_end || subscription?.cancel_at || subscription?.canceled_at;
    const canPurchaseCredits = subscriptionData?.credits?.can_purchase_credits || false;

    return (
        <div className="p-6 space-y-8">
            {/* Header with Plan Badge on Right */}
            <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                    <h1 className="text-2xl font-medium tracking-tight">Billing Status</h1>
                    <p className="text-sm text-muted-foreground">Manage your credits and subscription</p>
                </div>

                {/* Plan Badge with Renewal Info - Right aligned */}
                {!isFreeTier && planName && (
                    <div className="flex items-center gap-2 text-right">
                        {planIcon && (
                            <>
                                <div className="rounded-full py-0.5 flex items-center justify-center">
                                    <img src={planIcon} alt={planName} className="h-6 w-auto" />
                                </div>
                            </>
                        )}
                        {subscription?.current_period_end && (
                            <span className="text-xs text-muted-foreground">
                                Renews {formatDateFlexible(subscription.current_period_end)}
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* Credit Breakdown - 3 Boxes Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Total Available Credits */}
                <div className="relative overflow-hidden rounded-[18px] border border-border bg-card p-6">
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <CreditCard className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">Total Available Credits</span>
                        </div>
                        <div>
                            <div className="text-2xl leading-none font-medium mb-1">{formatCredits(totalCredits)}</div>
                            <p className="text-xs text-muted-foreground">All credits</p>
                        </div>
                    </div>
                </div>

                {/* Monthly Credits */}
                <div className="relative overflow-hidden rounded-[18px] border border-orange-500/20 bg-gradient-to-br from-orange-500/5 to-transparent p-6">
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-orange-500" />
                            <span className="text-sm text-muted-foreground">Monthly Credits</span>
                        </div>
                        <div>
                            <div className="text-2xl leading-none font-medium mb-1">{formatCredits(expiringCredits)}</div>
                            <p className="text-xs text-muted-foreground">
                                {daysUntilRefresh !== null 
                                    ? `Renewal in ${daysUntilRefresh} ${daysUntilRefresh === 1 ? 'day' : 'days'}`
                                    : 'No renewal scheduled'
                                }
                            </p>
                        </div>
                    </div>
                </div>

                {/* Extra Credits */}
                <div className="relative overflow-hidden rounded-[18px] border border-border bg-card p-6">
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <Infinity className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">Extra Credits</span>
                        </div>
                        <div>
                            <div className="text-2xl leading-none font-medium mb-1">{formatCredits(nonExpiringCredits)}</div>
                            <p className="text-xs text-muted-foreground">Non-expiring</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Buttons - Clean Layout */}
            <div className="flex items-center gap-3">
                <Button
                    onClick={handleManageSubscription}
                    disabled={createPortalSessionMutation.isPending}
                    className="h-10"
                >
                    {createPortalSessionMutation.isPending ? 'Loading...' : 'Manage Subscription'}
                </Button>
                {canPurchaseCredits && (
                    <Button
                        onClick={() => setShowCreditPurchaseModal(true)}
                        variant="outline"
                        className="h-10"
                    >
                        <ShoppingCart className="h-4 w-4 mr-2" />
                        Get Additional Credits
                    </Button>
                )}
                {!isFreeTier && planName && (
                    <Button
                        onClick={onOpenPlanModal}
                        variant="outline"
                        className="h-10"
                    >
                        Change Plan
                    </Button>
                )}
            </div>

            {/* Commitment or Cancellation Alerts */}
            {commitmentInfo?.has_commitment && (
                <Alert className="border-blue-500/20 bg-blue-500/5 rounded-[18px]">
                    <Shield className="h-4 w-4 text-blue-500" />
                    <AlertDescription>
                        <strong className="text-sm">Annual Commitment</strong>
                        <p className="text-sm text-muted-foreground mt-1">
                            Active until {formatEndDate(commitmentInfo.commitment_end_date || '')}
                        </p>
                    </AlertDescription>
                </Alert>
            )}

            {scheduledChangesData?.has_scheduled_change && scheduledChangesData.scheduled_change && (
                <ScheduledDowngradeCard
                    scheduledChange={scheduledChangesData.scheduled_change}
                    onCancel={() => {
                        refetchSubscription();
                        refetchScheduledChanges();
                    }}
                />
            )}

            {isCancelled && (
                <Alert variant="destructive" className="rounded-[18px]">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                        Your subscription will be cancelled on {getEffectiveCancellationDate()}
                        {!isCancelled && (
                            <Button
                                onClick={handleReactivate}
                                variant="outline"
                                size="sm"
                                className="ml-4"
                            >
                                Reactivate
                            </Button>
                        )}
                    </AlertDescription>
                </Alert>
            )}

            {/* Help Link - Subtle */}
            <div className="flex items-center justify-center pt-6 border-t border-border/50">
                <Button
                    variant="link"
                    onClick={() => window.open('/credits-explained', '_blank')}
                    className="text-muted-foreground hover:text-foreground h-auto p-0"
                >
                    <Lightbulb className="h-3.5 w-3.5 mr-2" />
                    <span className="text-sm">Credits explained</span>
                </Button>
            </div>

            {/* Cancel Plan Button - Subtle Placement */}
            {!isFreeTier && !isCancelled && (
                <div className="flex justify-center">
                    <Button
                        onClick={() => setShowCancelDialog(true)}
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive h-auto p-2 text-xs"
                    >
                        Cancel Plan
                    </Button>
                </div>
            )}

            {isCancelled && (
                <div className="flex justify-center">
                    <Button
                        onClick={handleReactivate}
                        disabled={reactivateSubscriptionMutation.isPending}
                        variant="outline"
                        size="sm"
                    >
                        <RotateCcw className="h-3.5 w-3.5 mr-2" />
                        {reactivateSubscriptionMutation.isPending ? 'Reactivating...' : 'Reactivate Subscription'}
                    </Button>
                </div>
            )}
            <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Cancel Subscription</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            Are you sure you want to cancel your subscription? You'll continue to have access until{' '}
                            {subscription?.current_period_end && formatDateFlexible(subscription.current_period_end)}.
                        </p>
                        <div className="flex gap-2 justify-end">
                            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>
                                Keep Subscription
                            </Button>
                            <Button 
                                variant="destructive" 
                                onClick={handleCancel} 
                                disabled={cancelSubscriptionMutation.isPending}
                            >
                                {cancelSubscriptionMutation.isPending ? 'Cancelling...' : 'Cancel Plan'}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
            <CreditPurchaseModal
                open={showCreditPurchaseModal}
                onOpenChange={setShowCreditPurchaseModal}
                currentBalance={totalCredits / 100}
                canPurchase={canPurchaseCredits}
                onPurchaseComplete={() => {
                    refetchSubscription();
                    refetchBalance();
                }}
            />
        </div>
    );
}

function CreditsHelpAlert() {
  return (
    <Alert>
      <AlertDescription>
        <div className="flex items-center">
          <Info className="h-4 w-4" />
          <Button
            variant="link"
            size="sm"
            className="h-7 text-muted-foreground"
            onClick={() => window.open('/help/credits', '_blank')}
          >
            Learn More about Credits
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function UsageTab() {
  return (
      <div className="p-6 space-y-6">
        <ThreadUsage />
      </div>
  );
}

function EnvManagerTab() {
    return (
        <div className="p-6">
            <LocalEnvManager />
        </div>
    );
}

function KnowledgeBaseTab() {
    useEffect(() => {
        window.open('/knowledge', '_blank');
    }, []);
    
    return (
        <div className="p-6 space-y-4">
            <div className="text-center py-8">
                <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-lg font-semibold mb-2">Opening Knowledge Base</h3>
                <p className="text-sm text-muted-foreground">
                    Redirecting to Knowledge Base page...
                </p>
            </div>
        </div>
    );
}

function IntegrationsTab() {
    useEffect(() => {
        window.open('/settings/credentials', '_blank');
    }, []);
    
    return (
        <div className="p-6 space-y-4">
            <div className="text-center py-8">
                <Plug className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-lg font-semibold mb-2">Opening Integrations</h3>
                <p className="text-sm text-muted-foreground">
                    Redirecting to Integrations page...
                </p>
            </div>
        </div>
    );
}
