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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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
    Bell,
    Mail,
    Smartphone,
    AppWindow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { isLocalMode } from '@/lib/config';
import { backendApi } from '@/lib/api-client';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Switch } from '@/components/ui/switch';
import { LocalEnvManager } from '@/components/env-manager/local-env-manager';
import { useIsMobile } from '@/hooks/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { useQueryClient } from '@tanstack/react-query';
import { 
    useAccountDeletionStatus, 
    useRequestAccountDeletion, 
    useCancelAccountDeletion,
    useDeleteAccountImmediately
} from '@/hooks/account/use-account-deletion';
import { AccountState } from '@/lib/api/billing';
import { useAuth } from '@/components/AuthProvider';
import { PlanSelectionModal, PricingSection } from '@/components/billing/pricing';
import { CreditBalanceDisplay, CreditPurchaseModal } from '@/components/billing/credit-purchase';
import { ScheduledDowngradeCard } from '@/components/billing/scheduled-downgrade-card';
import { 
    useAccountState,
    accountStateSelectors,
    useCreatePortalSession,
    useCancelSubscription,
    useReactivateSubscription,
    invalidateAccountState,
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
    Lightbulb,
    CalendarClock,
    ArrowRight
} from 'lucide-react';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { getPlanName, getPlanIcon } from '../billing/plan-utils';
import { TierBadge } from '../billing/tier-badge';
import { siteConfig } from '@/lib/home';
import ThreadUsage from '@/components/billing/thread-usage';
import { formatCredits } from '@/lib/utils/credit-formatter';
import { LanguageSwitcher } from './language-switcher';
import { useTranslations } from 'next-intl';

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

interface NotificationSettings {
    email_enabled: boolean;
    push_enabled: boolean;
    in_app_enabled: boolean;
}

function GeneralTab({ onClose }: { onClose: () => void }) {
    const t = useTranslations('settings.general');
    const tNotifications = useTranslations('notifications');
    const tCommon = useTranslations('common');
    const [userName, setUserName] = useState('');
    const [userEmail, setUserEmail] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [showCancelDialog, setShowCancelDialog] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const [deletionType, setDeletionType] = useState<'grace-period' | 'immediate'>('grace-period');
    const supabase = createClient();
    const queryClient = useQueryClient();
    const [localSettings, setLocalSettings] = useState<NotificationSettings | null>(null);

    const { data: deletionStatus, isLoading: isCheckingStatus } = useAccountDeletionStatus();
    const requestDeletion = useRequestAccountDeletion();
    const cancelDeletion = useCancelAccountDeletion();
    const deleteImmediately = useDeleteAccountImmediately();

    const { data: notificationSettings } = useQuery({
        queryKey: ['notification-settings'],
        queryFn: async () => {
            const response = await backendApi.get<{ settings: NotificationSettings }>('/notifications/settings');
            if (!response.success || !response.data) {
                throw new Error('Failed to fetch notification settings');
            }
            return response.data.settings;
        },
    });

    useEffect(() => {
        if (notificationSettings) {
            setLocalSettings(notificationSettings);
        }
    }, [notificationSettings]);

    const updateNotificationsMutation = useMutation({
        mutationFn: async (updates: Partial<NotificationSettings>) => {
            const response = await backendApi.put('/notifications/settings', updates);
            if (!response.success) {
                throw new Error('Failed to update notification settings');
            }
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
            toast.success(tNotifications('settingsUpdated'));
        },
        onError: () => {
            toast.error(tNotifications('settingsFailed'));
            if (notificationSettings) {
                setLocalSettings(notificationSettings);
            }
        },
    });

    const handleNotificationToggle = (key: keyof NotificationSettings, value: boolean) => {
        setLocalSettings(prev => prev ? { ...prev, [key]: value } : null);
        updateNotificationsMutation.mutate({ [key]: value });
    };

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

            toast.success(t('profileUpdated'));

            setTimeout(() => {
                window.location.reload();
            }, 500);
        } catch (error) {
            console.error('Error updating profile:', error);
            toast.error(t('profileUpdateFailed'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleRequestDeletion = async () => {
        if (deletionType === 'immediate') {
            await deleteImmediately.mutateAsync();
        } else {
            await requestDeletion.mutateAsync('User requested deletion');
        }
        setShowDeleteDialog(false);
        setDeleteConfirmText('');
        setDeletionType('grace-period'); // Reset to default
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
                <h3 className="text-lg font-semibold mb-1">{t('title')}</h3>
                <p className="text-sm text-muted-foreground">
                    {t('description')}
                </p>
            </div>

            <div className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="name">{t('name')}</Label>
                    <Input
                        id="name"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                        placeholder={t('namePlaceholder')}
                        className="shadow-none"
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="email">{t('email')}</Label>
                    <Input
                        id="email"
                        value={userEmail}
                        disabled
                        className="bg-muted/50 cursor-not-allowed shadow-none"
                    />
                    <p className="text-xs text-muted-foreground">
                        {t('emailCannotChange')}
                    </p>
                </div>

                <div className="space-y-2 pt-4">
                    <LanguageSwitcher />
                </div>
            </div>

            {localSettings && (
                <div className="space-y-4 pt-6 border-t">
                    <div>
                        <div className="flex items-center gap-2 mb-2">
                            <Bell className="h-4 w-4 text-muted-foreground" />
                            <h4 className="text-sm font-medium">{tNotifications('title')}</h4>
                        </div>
                        <p className="text-xs text-muted-foreground mb-4">
                            {tNotifications('description')}
                        </p>
                    </div>
                    
                    <div className="space-y-4">
                        <NotificationToggle
                            icon={Mail}
                            label={tNotifications('emailNotifications')}
                            description={tNotifications('emailDescription')}
                            enabled={localSettings.email_enabled}
                            onToggle={(value) => handleNotificationToggle('email_enabled', value)}
                        />
                        <NotificationToggle
                            icon={Smartphone}
                            label={tNotifications('pushNotifications')}
                            description={tNotifications('pushDescription')}
                            enabled={localSettings.push_enabled}
                            onToggle={(value) => handleNotificationToggle('push_enabled', value)}
                        />
                        <NotificationToggle
                            icon={AppWindow}
                            label={tNotifications('inAppNotifications')}
                            description={tNotifications('inAppDescription')}
                            enabled={localSettings.in_app_enabled}
                            onToggle={(value) => handleNotificationToggle('in_app_enabled', value)}
                        />
                    </div>
                </div>
            )}

            <div className="flex justify-end gap-2 pt-4">
                <Button
                    variant="outline"
                    onClick={onClose}
                >
                    {tCommon('cancel')}
                </Button>
                <Button
                    onClick={handleSave}
                    disabled={isSaving}
                >
                    {isSaving ? tCommon('saving') : t('saveChanges')}
                </Button>
            </div>

            {!isLocalMode() && (
                <>
                    <div className="pt-8 space-y-4">
                        <div>
                            <h3 className="text-base font-medium mb-1">{t('deleteAccount.title')}</h3>
                            <p className="text-sm text-muted-foreground">
                                {t('deleteAccount.description')}
                            </p>
                        </div>

                        {deletionStatus?.has_pending_deletion ? (
                            <Alert className="shadow-none border-amber-500/30 bg-amber-500/5">
                                <Clock className="h-4 w-4 text-amber-600" />
                                <AlertDescription>
                                    <div className="text-sm">
                                        <strong className="text-foreground">{t('deleteAccount.scheduled')}</strong>
                                        <p className="mt-1 text-muted-foreground">
                                            {t('deleteAccount.scheduledDescription', {
                                                date: formatDate(deletionStatus.deletion_scheduled_for)
                                            })}
                                        </p>
                                        <p className="mt-2 text-muted-foreground">
                                            {t('deleteAccount.canCancel')}
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
                                        {t('deleteAccount.cancelButton')}
                                    </Button>
                                </div>
                            </Alert>
                        ) : (
                            <Button
                                variant="outline"
                                onClick={() => setShowDeleteDialog(true)}
                                className="text-muted-foreground hover:text-foreground"
                            >
                                {t('deleteAccount.button')}
                            </Button>
                        )}
                    </div>

                    <Dialog open={showDeleteDialog} onOpenChange={(open) => {
                        setShowDeleteDialog(open);
                        if (!open) {
                            setDeleteConfirmText('');
                            setDeletionType('grace-period');
                        }
                    }}>
                        <DialogContent className="max-w-md">
                            <DialogHeader>
                                <DialogTitle>{t('deleteAccount.dialogTitle')}</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4">
                                <Alert className={cn(
                                    "shadow-none",
                                    deletionType === 'immediate' 
                                        ? "border-red-500/30 bg-red-500/5" 
                                        : "border-amber-500/30 bg-amber-500/5"
                                )}>
                                    <AlertTriangle className={cn(
                                        "h-4 w-4",
                                        deletionType === 'immediate' ? "text-red-600" : "text-amber-600"
                                    )} />
                                    <AlertDescription>
                                        <strong className="text-foreground">
                                            {deletionType === 'immediate' 
                                                ? t('deleteAccount.warningImmediate')
                                                : t('deleteAccount.warningGracePeriod')}
                                        </strong>
                                    </AlertDescription>
                                </Alert>
                                
                                <div>
                                    <p className="text-sm font-medium mb-2">
                                        {t('deleteAccount.whenDelete')}
                                    </p>
                                    <ul className="text-sm text-muted-foreground space-y-1.5 pl-5 list-disc">
                                        <li>{t('deleteAccount.agentsDeleted')}</li>
                                        <li>{t('deleteAccount.threadsDeleted')}</li>
                                        <li>{t('deleteAccount.credentialsRemoved')}</li>
                                        <li>{t('deleteAccount.subscriptionCancelled')}</li>
                                        <li>{t('deleteAccount.billingRemoved')}</li>
                                        {deletionType === 'grace-period' && (
                                            <li>{t('deleteAccount.scheduled30Days')}</li>
                                        )}
                                    </ul>
                                </div>

                                <div className="space-y-3">
                                    <Label>{t('deleteAccount.chooseDeletionType')}</Label>
                                    <RadioGroup value={deletionType} onValueChange={(value) => setDeletionType(value as 'grace-period' | 'immediate')}>
                                        <div className="flex items-start space-x-2 space-y-0 rounded-md border p-4">
                                            <RadioGroupItem value="grace-period" id="grace-period" className="mt-0.5" />
                                            <div className="space-y-1 flex-1">
                                                <Label htmlFor="grace-period" className="font-medium cursor-pointer">
                                                    {t('deleteAccount.gracePeriodOption')}
                                                </Label>
                                                <p className="text-sm text-muted-foreground">
                                                    {t('deleteAccount.gracePeriodDescription')}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-start space-x-2 space-y-0 rounded-md border border-red-500/30 p-4">
                                            <RadioGroupItem value="immediate" id="immediate" className="mt-0.5" />
                                            <div className="space-y-1 flex-1">
                                                <Label htmlFor="immediate" className="font-medium cursor-pointer text-red-600">
                                                    {t('deleteAccount.immediateOption')}
                                                </Label>
                                                <p className="text-sm text-muted-foreground">
                                                    {t('deleteAccount.immediateDescription')}
                                                </p>
                                            </div>
                                        </div>
                                    </RadioGroup>
                                </div>
                                
                                <div className="space-y-2">
                                    <Label htmlFor="delete-confirm">
                                        {t('deleteAccount.confirmText')}
                                    </Label>
                                    <Input
                                        id="delete-confirm"
                                        value={deleteConfirmText}
                                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                                        placeholder={t('deleteAccount.confirmPlaceholder')}
                                        className="shadow-none"
                                        autoComplete="off"
                                    />
                                </div>
                                
                                <div className="flex gap-2 justify-end">
                                    <Button variant="outline" onClick={() => {
                                        setShowDeleteDialog(false);
                                        setDeleteConfirmText('');
                                        setDeletionType('grace-period');
                                    }}>
                                        {t('deleteAccount.keepAccount')}
                                    </Button>
                                    <Button 
                                        variant="destructive" 
                                        onClick={handleRequestDeletion} 
                                        disabled={
                                            (requestDeletion.isPending || deleteImmediately.isPending) || 
                                            deleteConfirmText !== 'delete'
                                        }
                                    >
                                        {(requestDeletion.isPending || deleteImmediately.isPending) 
                                            ? tCommon('processing') 
                                            : t('deleteAccount.button')}
                                    </Button>
                                </div>
                            </div>
                        </DialogContent>
                    </Dialog>

                    <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
                        <AlertDialogContent className="max-w-md">
                            <AlertDialogHeader>
                                <AlertDialogTitle>{t('deleteAccount.cancelDeletionTitle')}</AlertDialogTitle>
                            </AlertDialogHeader>
                            <div className="space-y-4">
                                <p className="text-sm text-muted-foreground">
                                    {t('deleteAccount.cancelDeletionDescription')}
                                </p>
                                <div className="flex gap-2 justify-end">
                                    <Button variant="outline" onClick={() => setShowCancelDialog(false)}>
                                        {tCommon('back')}
                                    </Button>
                                    <Button 
                                        onClick={handleCancelDeletion} 
                                        disabled={cancelDeletion.isPending}
                                    >
                                        {cancelDeletion.isPending ? tCommon('processing') : t('deleteAccount.cancelDeletion')}
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

interface NotificationToggleProps {
    icon: React.ElementType;
    label: string;
    description: string;
    enabled: boolean;
    onToggle: (value: boolean) => void;
}

function NotificationToggle({ icon: Icon, label, description, enabled, onToggle }: NotificationToggleProps) {
    return (
        <div className="flex items-start justify-between gap-4 py-3 border-b last:border-0">
            <div className="flex items-start gap-3 flex-1">
                <Icon className="w-4 h-4 text-muted-foreground mt-0.5" />
                <div className="space-y-0.5 flex-1">
                    <Label htmlFor={label} className="text-sm font-medium cursor-pointer">
                        {label}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        {description}
                    </p>
                </div>
            </div>
            <Switch
                id={label}
                checked={enabled}
                onCheckedChange={onToggle}
            />
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

    // Use unified account state hook
    const {
        data: accountState,
        isLoading: isLoadingSubscription,
        error: subscriptionError,
        refetch: refetchSubscription
    } = useAccountState({
        enabled: !!session && !authLoading,
    });
    
    // Get commitment info from account state
    const commitmentInfo = accountState?.subscription.commitment;

    const createPortalSessionMutation = useCreatePortalSession();
    const cancelSubscriptionMutation = useCancelSubscription();
    const reactivateSubscriptionMutation = useReactivateSubscription();

    const planName = accountStateSelectors.planName(accountState);
    const planIcon = getPlanIcon(planName, isLocal);
    
    // Get scheduled change from account state
    const hasScheduledChange = accountState?.subscription.has_scheduled_change && accountState?.subscription.scheduled_change;
    const scheduledChange = accountState?.subscription.scheduled_change;
    
    const getFrontendTierName = (tierKey: string) => {
        const tier = siteConfig.cloudPricingItems.find(p => p.tierKey === tierKey);
        return tier?.name || tierKey || 'Basic';
    };

    // Calculate hours until daily refresh
    const getHoursUntilDailyRefresh = () => {
        const dailyInfo = accountState?.credits.daily_refresh;
        if (!dailyInfo?.enabled) return null;
        
        if (dailyInfo.seconds_until_refresh) {
            const hours = Math.ceil(dailyInfo.seconds_until_refresh / 3600);
            return hours > 0 ? hours : null;
        }
        
        if (dailyInfo.next_refresh_at) {
            const nextRefresh = new Date(dailyInfo.next_refresh_at);
            const now = new Date();
            const diffMs = nextRefresh.getTime() - now.getTime();
            const hours = Math.ceil(diffMs / (1000 * 60 * 60));
            return hours > 0 ? hours : null;
        }
        
        return null;
    };

    const hoursUntilDailyRefresh = getHoursUntilDailyRefresh();
    const dailyCreditsInfo = accountState?.credits.daily_refresh;
    
    // Use the clean credits breakdown from API
    const dailyCredits = accountState?.credits.daily ?? 0;
    const monthlyCredits = accountState?.credits.monthly ?? 0;
    const nonExpiringCredits = accountState?.credits.extra ?? 0;
    const totalCredits = accountState?.credits.total ?? 0;
    
    console.log('[BillingTab] Credit breakdown:', { 
        accountState: accountState?.credits,
        dailyCreditsInfo, 
        dailyCredits, 
        monthlyCredits, 
        nonExpiringCredits, 
        totalCredits
    });

    // Refetch billing info whenever the billing tab becomes active (only once per activation)
    const prevIsActiveRef = useRef(false);
    useEffect(() => {
        // Only refetch if tab just became active (not on every render)
        if (isActive && !prevIsActiveRef.current && session && !authLoading) {
            console.log('🔄 Billing tab activated, refetching billing info...');
            // Use centralized invalidation which includes deduplication
            invalidateAccountState(queryClient, true);
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
        if (accountState?.subscription.cancellation_effective_date) {
            return formatDate(accountState.subscription.cancellation_effective_date);
        }
        if (accountState?.subscription.current_period_end) {
            return formatDateFlexible(accountState.subscription.current_period_end);
        }
        return 'N/A';
    };

    const handleManageSubscription = () => {
        console.log('[BillingTab] Creating portal session with return_url:', returnUrl);
        createPortalSessionMutation.mutate({ return_url: returnUrl });
    };

    const handleCancel = () => {
        setShowCancelDialog(false);
        cancelSubscriptionMutation.mutate(undefined);
    };

    const handleReactivate = () => {
        reactivateSubscriptionMutation.mutate();
    };

    const isLoading = isLoadingSubscription || authLoading;
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

    const subStatus = accountState?.subscription.status;
    const isSubscribed = subStatus === 'active' || subStatus === 'trialing';
    const isFreeTier = accountState?.subscription.tier_key === 'free' || accountState?.subscription.tier_key === 'none';
    const isCancelled = accountState?.subscription.is_cancelled || accountState?.subscription.cancel_at_period_end;
    const canPurchaseCredits = accountState?.subscription.can_purchase_credits || false;

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
                    <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-2">
                            {planIcon && (
                                <div className="rounded-full py-0.5 flex items-center justify-center">
                                    <img 
                                        src={planIcon} 
                                        alt={planName} 
                                        className="h-6 w-auto" 
                                        style={{ height: '24px', width: 'auto' }}
                                    />
                                </div>
                            )}
                            {accountState?.subscription.current_period_end && !hasScheduledChange && (
                                <span className="text-xs text-muted-foreground">
                                    Renews {formatDateFlexible(accountState.subscription.current_period_end)}
                                </span>
                            )}
                        </div>
                        {/* Scheduled Downgrade Info - inline below plan */}
                        {hasScheduledChange && scheduledChange && (
                            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                                <CalendarClock className="h-3 w-3" />
                                <span>
                                    Changing to {getFrontendTierName(scheduledChange.target_tier.name)} on{' '}
                                    {new Date(scheduledChange.effective_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Credit Breakdown - Grid adapts based on tier */}
            <div className={cn(
                "grid gap-4",
                dailyCreditsInfo?.enabled 
                    ? "grid-cols-2 md:grid-cols-4" 
                    : "grid-cols-1 md:grid-cols-3"
            )}>
                {/* Total Available Credits */}
                <div className="relative overflow-hidden rounded-[18px] border border-border bg-card p-5">
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <Zap className="h-4 w-4 text-primary" />
                            <span className="text-xs text-muted-foreground">Total Available</span>
                        </div>
                        <div>
                            <div className="text-xl leading-none font-semibold">{formatCredits(totalCredits)}</div>
                        </div>
                    </div>
                </div>

                {/* Daily Credits - Only for free tier */}
                {dailyCreditsInfo?.enabled && (
                    <div className="relative overflow-hidden rounded-[18px] border border-blue-500/20 bg-gradient-to-br from-blue-500/5 to-transparent p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2">
                                <RotateCcw className="h-4 w-4 text-blue-500" />
                                <span className="text-xs text-muted-foreground">Daily</span>
                            </div>
                            <div>
                                <div className="text-xl leading-none font-semibold">{formatCredits(dailyCredits)}</div>
                                <p className="text-[11px] text-blue-500/80 mt-1.5">
                                    {hoursUntilDailyRefresh !== null 
                                        ? `Refresh in ${hoursUntilDailyRefresh}h`
                                        : 'Refreshes daily'
                                    }
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Monthly Credits - For paid tiers OR expiring credits display */}
                {(!dailyCreditsInfo?.enabled || monthlyCredits > 0) && (
                    <div className="relative overflow-hidden rounded-[18px] border border-orange-500/20 bg-gradient-to-br from-orange-500/5 to-transparent p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2">
                                <Clock className="h-4 w-4 text-orange-500" />
                                <span className="text-xs text-muted-foreground">Monthly</span>
                            </div>
                            <div>
                                <div className="text-xl leading-none font-semibold">
                                    {formatCredits(dailyCreditsInfo?.enabled ? monthlyCredits : (accountState?.credits.monthly || 0))}
                                </div>
                                <p className="text-[11px] text-orange-500/80 mt-1.5">
                                    {hoursUntilDailyRefresh !== null 
                                        ? `Refresh in ${hoursUntilDailyRefresh} ${hoursUntilDailyRefresh === 1 ? 'hour' : 'hours'}`
                                        : 'No renewal scheduled'
                                    }
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Extra Credits */}
                <div className="relative overflow-hidden rounded-[18px] border border-border bg-card p-5">
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <Infinity className="h-4 w-4 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">Extra</span>
                        </div>
                        <div>
                            <div className="text-xl leading-none font-semibold">{formatCredits(nonExpiringCredits)}</div>
                            <p className="text-[11px] text-muted-foreground mt-1.5">Non-expiring</p>
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
                {planName && (
                    hasScheduledChange ? (
                        <Button
                            variant="outline"
                            className="h-10 border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                            disabled
                        >
                            <CalendarClock className="h-4 w-4 mr-2" />
                            Downgrade Scheduled
                        </Button>
                    ) : (
                        <Button
                            onClick={onOpenPlanModal}
                            variant="outline"
                            className="h-10"
                        >
                            Change Plan
                        </Button>
                    )
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

            {hasScheduledChange && scheduledChange && (
                <ScheduledDowngradeCard
                    scheduledChange={scheduledChange}
                    onCancel={() => {
                        refetchSubscription();
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
                            {accountState?.subscription.current_period_end && formatDateFlexible(accountState.subscription.current_period_end)}.
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
