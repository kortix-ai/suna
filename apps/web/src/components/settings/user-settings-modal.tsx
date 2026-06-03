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
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import {
    X,
    Bell,
    Camera,
    Upload,
    type LucideIcon,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/lib/toast';
import { isBillingEnabled } from '@/lib/config';
import { useQuery } from '@tanstack/react-query';
import { Switch } from '@/components/ui/switch';

import { useIsMobile } from '@/hooks/utils';
import { useQueryClient } from '@tanstack/react-query';
import { 
    useAccountDeletionStatus, 
    useRequestAccountDeletion, 
    useCancelAccountDeletion,
    useDeleteAccountImmediately
} from '@/hooks/account/use-account-deletion';
import { AccountState } from '@/lib/api/billing';
import { useAuth } from '@/components/AuthProvider';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';
import { AutoTopupCard } from '@/components/billing/auto-topup-card';
import { SeatManagementCard } from '@/components/billing/seat-management-card';
import { ClaimPerSeatCard } from '@/components/billing/claim-per-seat-card';
import { AccountOverviewTab } from '@/components/billing/account-overview';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import {
    accountStateKeys,
    accountStateSelectors,
    useCreatePortalSession,
    invalidateAccountState,
} from '@/hooks/billing';
import { billingApi } from '@/lib/api/billing';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { InfoBanner } from '@/components/ui/info-banner';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Zap,
    AlertTriangle,
    Clock,
} from 'lucide-react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';


import { formatCredits } from '@kortix/shared';
import { LanguageSwitcher } from './language-switcher';
import { useTranslations } from 'next-intl';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { CheckCircle2, HelpCircle, ShieldCheck, Volume2, EyeOff, KeyRound } from 'lucide-react';
import CreditTransactions from '@/components/billing/credit-transactions';
import { useWebNotificationStore } from '@/stores/web-notification-store';
import { isNotificationSupported, sendWebNotification } from '@/lib/web-notifications';
import { useSoundStore, type SoundPack, type SoundEvent } from '@/stores/sound-store';
import { previewSound } from '@/lib/sounds';
import { AppearanceTab } from './appearance-tab';
import { CliTokensTab } from './cli-tokens-tab';
import {
    getPreferenceTabs,
    type SettingsTabId,
} from '@/lib/menu-registry';

type TabId = SettingsTabId;

interface Tab {
    id: TabId;
    label: string;
    icon: LucideIcon;
    disabled?: boolean;
}

interface UserSettingsModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void; 
    defaultTab?: TabId;
}

export function UserSettingsModal({
    open,
    onOpenChange,
    defaultTab = 'general',
}: UserSettingsModalProps) {
    const isMobile = useIsMobile();
    const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
    // Tab definitions from the central menu registry (single source of truth).
    // Account-level tabs (Billing, Transactions) now live in AccountSettingsModal.
    const preferenceTabs: Tab[] = React.useMemo(() => getPreferenceTabs(), []);
    const accountTabs: Tab[] = React.useMemo(
        () => [{ id: 'tokens', label: 'CLI tokens', icon: KeyRound }],
        [],
    );

    type TabGroup = { label: string; tabs: Tab[]; skeleton?: boolean };
    const tabGroups: TabGroup[] = [
        { label: 'Preferences', tabs: preferenceTabs },
        { label: 'Account', tabs: accountTabs },
    ];

    const allTabs = React.useMemo(
        () => [...preferenceTabs, ...accountTabs],
        [preferenceTabs, accountTabs],
    );
    const activeContentTab: TabId = allTabs.some((tab) => tab.id === activeTab)
        ? activeTab
        : 'general';

    useEffect(() => {
        setActiveTab(defaultTab);
    }, [defaultTab]);

    useEffect(() => {
        if (!allTabs.some((tab) => tab.id === activeTab)) {
            setActiveTab('general');
        }
    }, [activeTab, allTabs]);

    const handleTabClick = (tabId: TabId) => {
        setActiveTab(tabId);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    "p-0 gap-0",
                    isMobile 
                        ? "fixed inset-0 w-screen h-screen max-w-none max-h-none rounded-none m-0 translate-x-0 translate-y-0 left-0 top-0" 
                        : "max-w-6xl max-h-[90vh] overflow-hidden"
                )}
                hideCloseButton={true}
            >
                <DialogTitle className="sr-only">Settings</DialogTitle>
                
                {isMobile ? (
                    /* Mobile Layout - Full Screen */
                    <div className="flex flex-col h-screen w-screen overflow-hidden">
                        {/* Mobile Header */}
                        <div className="px-4 py-3 border-b border-border flex-shrink-0 bg-background">
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
                        </div>
                        
                        <div className="px-3 py-2.5 border-b border-border flex-shrink-0 bg-background">
                            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-3 px-3 scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                                {allTabs.map((tab) => {
                                    const Icon = tab.icon;
                                    const isActive = activeContentTab === tab.id;

                                    return (
                                        <Button
                                            key={tab.id}
                                            onClick={() => handleTabClick(tab.id)}
                                            disabled={tab.disabled}
                                            variant={isActive ? "subtle" : "ghost"}
                                            className={cn(
                                                "flex items-center gap-2 whitespace-nowrap flex-shrink-0 justify-start",
                                                !isActive && "text-muted-foreground hover:text-foreground"
                                            )}
                                        >
                                            <Icon className="h-4 w-4 flex-shrink-0" />
                                            <span>{tab.label}</span>
                                        </Button>
                                    );
                                })}
                            </div>
                        </div>
                        
                        {/* Mobile Content - Scrollable */}
                        <div className="flex-1 overflow-x-hidden overflow-y-auto">
                            <div className="w-full max-w-full">
                                {activeContentTab === 'general' && <GeneralTab onClose={() => onOpenChange(false)} />}
                                {activeContentTab === 'appearance' && <AppearanceTab />}
                                {activeContentTab === 'sounds' && <SoundsTab />}
                                {activeContentTab === 'notifications' && <NotificationsTab />}
                                {activeContentTab === 'shortcuts' && <KeyboardShortcutsTab />}
                                {activeContentTab === 'tokens' && <CliTokensTab />}
                            </div>
                        </div>
                    </div>
                ) : (
                    /* Desktop Layout - Side by Side */
                    <div className="flex flex-row h-[700px]">
                        {/* Desktop Sidebar */}
                        <div className="bg-background flex-shrink-0 w-56 p-4 border-r border-border">
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

                            {/* Desktop Tabs - Grouped */}
                            <div className="flex flex-col gap-4">
                                {tabGroups.map((group, groupIdx) => (
                                    <div key={group.skeleton ? `skeleton-${groupIdx}` : group.label}>
                                        <div className="px-4 pb-1.5">
                                            {group.skeleton ? (
                                                <Skeleton className="h-3 w-20 rounded" />
                                            ) : (
                                                <span className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">{group.label}</span>
                                            )}
                                        </div>
                                        <div className="flex flex-col gap-0.5">
                                            {group.skeleton ? (
                                                <>
                                                    <Skeleton className="mx-2 h-9 rounded-full" />
                                                    <Skeleton className="mx-2 h-9 rounded-full" />
                                                </>
                                            ) : (
                                                group.tabs.map((tab) => {
                                                const Icon = tab.icon;
                                                const isActive = activeContentTab === tab.id;

                                                return (
                                                    <Button
                                                        key={tab.id}
                                                        onClick={() => handleTabClick(tab.id)}
                                                        disabled={tab.disabled}
                                                        variant="ghost"
                                                        className={cn(
                                                            "w-full flex items-center gap-3 justify-start",
                                                            isActive
                                                                ? "bg-accent text-foreground hover:bg-accent"
                                                                : "text-muted-foreground hover:text-foreground"
                                                        )}
                                                    >
                                                        <Icon className="h-4 w-4 flex-shrink-0" />
                                                        <span>{tab.label}</span>
                                                    </Button>
                                                );
                                                })
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Desktop Content */}
                        <div className="flex-1 overflow-y-auto min-h-0 w-full max-w-full">
                            {activeContentTab === 'general' && <GeneralTab onClose={() => onOpenChange(false)} />}
                            {activeContentTab === 'appearance' && <AppearanceTab />}
                            {activeContentTab === 'sounds' && <SoundsTab />}
                            {activeContentTab === 'notifications' && <NotificationsTab />}
                            {activeContentTab === 'shortcuts' && <KeyboardShortcutsTab />}
                            {activeContentTab === 'tokens' && <CliTokensTab />}
                        </div>
                    </div>
                )}


            </DialogContent>
        </Dialog>
    );
}


function GeneralTab({ onClose }: { onClose: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
    const t = useTranslations('settings.general');
    const tCommon = useTranslations('common');
    const [userName, setUserName] = useState('');
    const [userEmail, setUserEmail] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');
    const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
    const [avatarFile, setAvatarFile] = useState<File | null>(null);
    const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [showCancelDialog, setShowCancelDialog] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const [deletionType, setDeletionType] = useState<'grace-period' | 'immediate'>('grace-period');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const supabase = createClient();

    const { data: deletionStatus, isLoading: isCheckingStatus } = useAccountDeletionStatus();
    const requestDeletion = useRequestAccountDeletion();
    const cancelDeletion = useCancelAccountDeletion();
    const deleteImmediately = useDeleteAccountImmediately();
    const accountDeletionSupported = deletionStatus?.supported ?? !isCheckingStatus;

    useEffect(() => {
        const fetchUserData = async () => {
            setIsLoading(true);
            const { data } = await supabase.auth.getUser();
            if (data.user) {
                setUserName(data.user.user_metadata?.name || data.user.email?.split('@')[0] || '');
                setUserEmail(data.user.email || '');
                setAvatarUrl(data.user.user_metadata?.avatar_url || '');
            }
            setIsLoading(false);
        };

        fetchUserData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const getInitials = (name: string) => {
        return name
            .split(' ')
            .map(part => part[0])
            .join('')
            .toUpperCase()
            .slice(0, 2) || 'U';
    };

    const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            // Validate file type
            if (!file.type.startsWith('image/')) {
                toast.error(t('profilePicture.invalidType'));
                return;
            }
            // Validate file size (max 5MB)
            if (file.size > 5 * 1024 * 1024) {
                toast.error(t('profilePicture.tooLarge'));
                return;
            }
            setAvatarFile(file);
            const previewUrl = URL.createObjectURL(file);
            setAvatarPreview(previewUrl);
        }
    };

    // Uploads to `${userId}/<file>` so the per-user RLS policy on the public
    // "avatars" bucket allows it. Throws on failure so the caller can abort.
    const uploadAvatar = async (userId: string): Promise<string> => {
        if (!avatarFile) return avatarUrl;

        setIsUploadingAvatar(true);
        try {
            const fileExt = (avatarFile.name.split('.').pop() || 'png').toLowerCase();
            const filePath = `${userId}/${Date.now()}.${fileExt}`;

            const { error: uploadError } = await supabase.storage
                .from('avatars')
                .upload(filePath, avatarFile, {
                    cacheControl: '3600',
                    upsert: true,
                });

            if (uploadError) throw uploadError;

            const { data: { publicUrl } } = supabase.storage
                .from('avatars')
                .getPublicUrl(filePath);

            return publicUrl;
        } finally {
            setIsUploadingAvatar(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const { data: userData } = await supabase.auth.getUser();
            const userId = userData.user?.id;

            if (!userId) throw new Error('User not found');

            // Upload the new avatar first — if this throws (e.g. storage not
            // provisioned), we abort below WITHOUT saving or reloading.
            const newAvatarUrl = avatarFile ? await uploadAvatar(userId) : avatarUrl;

            const { error } = await supabase.auth.updateUser({
                data: {
                    name: userName,
                    avatar_url: newAvatarUrl,
                },
            });

            if (error) throw error;

            // Clean up preview URL
            if (avatarPreview) {
                URL.revokeObjectURL(avatarPreview);
                setAvatarPreview(null);
            }
            setAvatarFile(null);
            setAvatarUrl(newAvatarUrl);

            // No reload: updateUser fires a Supabase `USER_UPDATED` event, and
            // AuthProvider re-renders every avatar consumer (header, sidebar)
            // live. The old window.location.reload() was the "hard reload".
            toast.success(t('profileUpdated'));
        } catch (error) {
            console.error('Error updating profile:', error);
            const message = error instanceof Error && error.message ? error.message : '';
            toast.error(message || t('profileUpdateFailed'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleRequestDeletion = async () => {
        try {
            if (deletionType === 'immediate') {
                await deleteImmediately.mutateAsync();
            } else {
                await requestDeletion.mutateAsync('User requested deletion');
            }
            setShowDeleteDialog(false);
            setDeleteConfirmText('');
            setDeletionType('grace-period'); // Reset to default
        } catch {
            // Mutation onError already shows the user-facing message.
        }
    };

    const handleCancelDeletion = async () => {
        try {
            await cancelDeletion.mutateAsync();
            setShowCancelDialog(false);
        } catch {
            // Mutation onError already shows the user-facing message.
        }
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
            <div className="p-4 sm:p-6 space-y-5 sm:space-y-6 min-w-0 max-w-full">
                <Skeleton className="h-8 w-32" />
                <div className="space-y-4">
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-20 w-full" />
                </div>
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-6 pb-12 sm:pb-6 space-y-5 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
            <div>
                <h3 className="text-lg font-semibold mb-1">{t('title')}</h3>
                <p className="text-sm text-muted-foreground">
                    {t('description')}
                </p>
            </div>

            <div className="space-y-4">
                {/* Profile Picture Section */}
                <div className="space-y-3">
                    <Label>{t('profilePicture.title')}</Label>
                    <div className="flex items-center gap-4">
                        <div className="relative group">
                            <Avatar className="h-16 w-16 border-2 border-border">
                                <AvatarImage 
                                    src={avatarPreview || avatarUrl} 
                                    alt={userName} 
                                />
                                <AvatarFallback className="text-base bg-muted">
                                    {getInitials(userName)}
                                </AvatarFallback>
                            </Avatar>
                            <Button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isUploadingAvatar}
                                variant="ghost"
                                className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 h-auto"
                            >
                                {isUploadingAvatar ? (
                                    <KortixLoader size="small" variant="white" />
                                ) : (
                                    <Camera className="h-5 w-5 text-white" />
                                )}
                            </Button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line596JsxAttrAcceptImage')}
                                onChange={handleAvatarChange}
                                className="hidden"
                            />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isUploadingAvatar}
                                className="w-full sm:w-auto"
                            >
                                <Upload className="h-4 w-4 mr-1.5" />
                                {t('profilePicture.upload')}
                            </Button>
                            <p className="text-xs text-muted-foreground">
                                {t('profilePicture.hint')}
                            </p>
                        </div>
                    </div>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="name">{t('name')}</Label>
                    <Input type="text"
                        id="name"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                        placeholder={t('namePlaceholder')}
                        className="shadow-none"
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="email">{t('email')}</Label>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Input type="text"
                                id="email"
                                value={userEmail}
                                disabled
                                className="bg-muted/50 cursor-not-allowed shadow-none"
                            />
                        </TooltipTrigger>
                        <TooltipContent>
                            {t('emailCannotChange')}
                        </TooltipContent>
                    </Tooltip>
                </div>

                <div className="space-y-2">
                    <LanguageSwitcher />
                </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-4">
                <Button
                    variant="outline"
                    onClick={onClose}
                    className="w-full sm:w-auto"
                >
                    {tCommon('cancel')}
                </Button>
                <Button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="w-full sm:w-auto"
                >
                    {isSaving ? tCommon('saving') : t('saveChanges')}
                </Button>
            </div>
            {isBillingEnabled() && accountDeletionSupported && (
                <>
                    <div className="pt-8 space-y-4">
                        <div>
                            <h3 className="text-base font-medium mb-1">{t('deleteAccount.title')}</h3>
                            <p className="text-sm text-muted-foreground">
                                {t('deleteAccount.description')}
                            </p>
                        </div>

                        {deletionStatus?.has_pending_deletion ? (
                            <InfoBanner
                                tone="warning"
                                icon={Clock}
                                title={t('deleteAccount.scheduled')}
                            >
                                <p className="mt-1 text-muted-foreground">
                                    {t('deleteAccount.scheduledDescription', {
                                        date: formatDate(deletionStatus.deletion_scheduled_for)
                                    })}
                                </p>
                                <p className="mt-2 text-muted-foreground">
                                    {t('deleteAccount.canCancel')}
                                </p>
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
                            </InfoBanner>
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
                        <DialogContent className="max-w-md max-h-[90vh] sm:max-h-[85vh] gap-0 overflow-hidden p-0">
                            <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
                                <DialogTitle className="text-lg font-semibold tracking-tight">{t('deleteAccount.dialogTitle')}</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4 overflow-y-auto px-6 py-5">
                                <InfoBanner tone="warning" icon={AlertTriangle}>
                                    <strong className="text-foreground text-sm sm:text-base">
                                        {deletionType === 'immediate'
                                            ? t('deleteAccount.warningImmediate')
                                            : t('deleteAccount.warningGracePeriod')}
                                    </strong>
                                </InfoBanner>
                                
                                <div>
                                    <p className="text-sm font-medium mb-2">
                                        {t('deleteAccount.whenDelete')}
                                    </p>
                                    <ul className="text-xs sm:text-sm text-muted-foreground space-y-1.5 pl-4 sm:pl-5 list-disc">
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
                                    <Label className="text-sm">{t('deleteAccount.chooseDeletionType')}</Label>
                                    <RadioGroup value={deletionType} onValueChange={(value) => setDeletionType(value as 'grace-period' | 'immediate')}>
                                        <div className="flex items-start gap-2 sm:gap-3 rounded-2xl border p-3 sm:p-4">
                                            <RadioGroupItem value="grace-period" id="grace-period" className="mt-0.5 flex-shrink-0" />
                                            <div className="space-y-1 flex-1 min-w-0">
                                                <Label htmlFor="grace-period" className="font-medium cursor-pointer text-sm sm:text-base block">
                                                    {t('deleteAccount.gracePeriodOption')}
                                                </Label>
                                                <p className="text-xs sm:text-sm text-muted-foreground">
                                                    {t('deleteAccount.gracePeriodDescription')}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-start gap-2 sm:gap-3 rounded-2xl border p-3 sm:p-4">
                                            <RadioGroupItem value="immediate" id="immediate" className="mt-0.5 flex-shrink-0" />
                                            <div className="space-y-1 flex-1 min-w-0">
                                                <Label htmlFor="immediate" className="font-medium cursor-pointer text-sm sm:text-base block">
                                                    {t('deleteAccount.immediateOption')}
                                                </Label>
                                                <p className="text-xs sm:text-sm text-muted-foreground">
                                                    {t('deleteAccount.immediateDescription')}
                                                </p>
                                            </div>
                                        </div>
                                    </RadioGroup>
                                </div>
                                
                                <div className="space-y-2">
                                    <Label htmlFor="delete-confirm" className="text-sm">
                                        {t('deleteAccount.confirmText')}
                                    </Label>
                                    <Input type="text"
                                        id="delete-confirm"
                                        value={deleteConfirmText}
                                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                                        placeholder={t('deleteAccount.confirmPlaceholder')}
                                        className="text-sm sm:text-base"
                                        autoComplete="off"
                                    />
                                </div>
                            </div>

                            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
                                <Button variant="ghost" onClick={() => {
                                    setShowDeleteDialog(false);
                                    setDeleteConfirmText('');
                                    setDeletionType('grace-period');
                                }} className="w-full sm:w-auto">
                                    {t('deleteAccount.keepAccount')}
                                </Button>
                                <Button
                                    variant="destructive"
                                    onClick={handleRequestDeletion}
                                    disabled={
                                        (requestDeletion.isPending || deleteImmediately.isPending) ||
                                        deleteConfirmText !== 'delete'
                                    }
                                    className="w-full sm:w-auto"
                                >
                                    {(requestDeletion.isPending || deleteImmediately.isPending)
                                        ? tCommon('processing')
                                        : t('deleteAccount.button')}
                                </Button>
                            </div>
                        </DialogContent>
                    </Dialog>

                    <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
                        <AlertDialogContent className="max-w-md p-4 sm:p-6">
                            <AlertDialogHeader>
                                <AlertDialogTitle className="text-base sm:text-lg">{t('deleteAccount.cancelDeletionTitle')}</AlertDialogTitle>
                            </AlertDialogHeader>
                            <div className="space-y-4">
                                <AlertDialogDescription className="text-xs sm:text-sm text-muted-foreground">
                                    {t('deleteAccount.cancelDeletionDescription')}
                                </AlertDialogDescription>
                                <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-2">
                                    <Button variant="outline" onClick={() => setShowCancelDialog(false)} className="w-full sm:w-auto">
                                        {tCommon('back')}
                                    </Button>
                                    <Button 
                                        onClick={handleCancelDeletion} 
                                        disabled={cancelDeletion.isPending}
                                        className="w-full sm:w-auto"
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

// ============================================================================
// Keyboard Shortcuts Tab
// ============================================================================

function KeyboardShortcutsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
    const { preferences, setKeyboardPreferences, getModifierLabel } = useUserPreferencesStore();
    const modifier = preferences.keyboard.tabSwitchModifier;
    const modLabel = getModifierLabel();

    const shortcuts = [
        { label: 'New tab', keys: `${modLabel}+T` },
        { label: 'Close active tab', keys: 'Ctrl+W' },
        { label: 'Reopen closed tab', keys: `${modLabel}+Shift+T` },
        { label: 'Next tab', keys: `${modLabel}+Shift+]` },
        { label: 'Previous tab', keys: `${modLabel}+Shift+[` },
        { label: 'Next tab (alt)', keys: `${modLabel}+Alt+→` },
        { label: 'Previous tab (alt)', keys: `${modLabel}+Alt+←` },
        { label: 'Switch to tab 1-8', keys: `${modLabel}+1 ... ${modLabel}+8` },
        { label: 'Switch to last tab', keys: `${modLabel}+9` },
        { label: 'New session', keys: 'Ctrl+J' },
        { label: 'Command palette', keys: 'Ctrl+K' },
        { label: 'Toggle left sidebar', keys: 'Ctrl+B' },
        { label: 'Toggle right sidebar', keys: 'Ctrl+Shift+B' },
    ];

    return (
        <div className="p-4 sm:p-6 pb-12 sm:pb-6 space-y-5 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
            <div>
                <h3 className="text-lg font-semibold mb-1">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line876JsxTextKeyboardShortcuts')}</h3>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line878JsxTextViewAndCustomizeKeyboardShortcutsForTabNavigation')}</p>
            </div>

            {/* Modifier key picker */}
            <div className="space-y-3">
                <Label className="text-sm font-medium">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line884JsxTextModifierKey')}</Label>
                <p className="text-xs text-muted-foreground -mt-1">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line886JsxTextChooseWhichModifierKeyIsUsedForTab')}</p>
                <RadioGroup
                    value={modifier}
                    onValueChange={(val) =>
                        setKeyboardPreferences({
                            tabSwitchModifier: val as 'meta' | 'ctrl',
                            closeTabModifier: val as 'meta' | 'ctrl',
                        })
                    }
                    className="flex gap-3"
                >
                    <div className="flex items-center gap-2">
                        <RadioGroupItem value="meta" id="mod-meta" />
                        <Label htmlFor="mod-meta" className="cursor-pointer font-normal">
                            Cmd <span className="text-muted-foreground">(⌘)</span>
                        </Label>
                    </div>
                    <div className="flex items-center gap-2">
                        <RadioGroupItem value="ctrl" id="mod-ctrl" />
                        <Label htmlFor="mod-ctrl" className="cursor-pointer font-normal">
                            Ctrl <span className="text-muted-foreground">(^)</span>
                        </Label>
                    </div>
                </RadioGroup>
            </div>

            {/* All shortcuts reference */}
            <div className="space-y-3">
                <Label className="text-sm font-medium">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line915JsxTextAllShortcuts')}</Label>
                <div className="rounded-2xl border divide-y">
                    {shortcuts.map((s) => (
                        <div key={s.label} className="flex items-center justify-between px-3 py-2.5">
                            <span className="text-sm text-foreground">{s.label}</span>
                            <kbd className="inline-flex h-6 items-center rounded border bg-muted px-2 text-xs font-mono text-muted-foreground whitespace-nowrap">
                                {s.keys}
                            </kbd>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// Sounds Tab
function SoundsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
    const preferences = useSoundStore((s) => s.preferences);
    const setPack = useSoundStore((s) => s.setPack);
    const setVolume = useSoundStore((s) => s.setVolume);
    const setEventEnabled = useSoundStore((s) => s.setEventEnabled);

    const packs: { id: SoundPack; label: string; description: string }[] = [
        { id: 'off', label: 'Off', description: 'All sounds disabled' },
        { id: 'kortix', label: 'Seshion Pack', description: 'Whistlin' },
    ];

    const events: { id: SoundEvent; label: string; description: string }[] = [
        { id: 'completion', label: 'Task Completion', description: 'When AI finishes a task' },
        { id: 'error', label: 'Error', description: 'When a session encounters an error' },
        { id: 'notification', label: 'Notification', description: 'Questions and permission requests' },
        { id: 'send', label: 'Message Sent', description: 'When you send a message' },
    ];

    return (
        <div className="p-6 space-y-6">
            <div>
                <h3 className="text-lg font-semibold">Sounds</h3>
                <p className="text-sm text-muted-foreground mt-1">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line956JsxTextChooseASoundPackAndConfigureWhichEvents')}</p>
            </div>

            {/* Sound Pack Selection */}
            <div>
                <h4 className="text-sm font-medium mb-3">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line962JsxTextSoundPack')}</h4>
                <RadioGroup
                    value={preferences.pack}
                    onValueChange={(value) => setPack(value as SoundPack)}
                    className="space-y-2"
                >
                    {packs.map((pack) => (
                        <label
                            key={pack.id}
                            htmlFor={`pack-${pack.id}`}
                            className={cn(
                                'flex items-center gap-3 rounded-2xl border px-4 py-3 cursor-pointer transition-colors',
                                preferences.pack === pack.id
                                    ? 'border-foreground/20 bg-muted/50'
                                    : 'border-border hover:bg-muted/30',
                            )}
                        >
                            <RadioGroupItem value={pack.id} id={`pack-${pack.id}`} />
                            <div className="flex-1">
                                <div className="text-sm font-medium">{pack.label}</div>
                                <div className="text-xs text-muted-foreground">{pack.description}</div>
                            </div>
                        </label>
                    ))}
                </RadioGroup>
            </div>

            {preferences.pack !== 'off' && (
                <>
                    {/* Volume */}
                    <div>
                        <h4 className="text-sm font-medium mb-3">Volume</h4>
                        <div className="flex items-center gap-3 px-4">
                            <Volume2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <input
                                type="range"
                                min={0}
                                max={100}
                                value={Math.round(preferences.volume * 100)}
                                onChange={(e) => setVolume(Number(e.target.value) / 100)}
                                className="flex-1 accent-foreground h-1.5 cursor-pointer"
                            />
                            <span className="text-xs text-muted-foreground w-8 text-right tabular-nums">
                                {Math.round(preferences.volume * 100)}%
                            </span>
                        </div>
                    </div>

                    {/* Sound Events */}
                    <div>
                        <h4 className="text-sm font-medium mb-3">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1012JsxTextSoundEvents')}</h4>
                        <div className="rounded-2xl border divide-y">
                            {events.map((event) => {
                                const enabled = preferences.events[event.id] !== false;
                                return (
                                    <div key={event.id} className="flex items-center justify-between gap-4 px-4 py-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium">{event.label}</div>
                                            <div className="text-xs text-muted-foreground">{event.description}</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                                                onClick={() => previewSound(event.id)}
                                            >
                                                Preview
                                            </Button>
                                            <Switch
                                                checked={enabled}
                                                onCheckedChange={(v) => setEventEnabled(event.id, v)}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

// Notifications Tab
function NotificationsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
    const permission = useWebNotificationStore((s) => s.permission);
    const preferences = useWebNotificationStore((s) => s.preferences);
    const toggleEnabled = useWebNotificationStore((s) => s.toggleEnabled);
    const setPreference = useWebNotificationStore((s) => s.setPreference);
    const syncPermission = useWebNotificationStore((s) => s.syncPermission);

    useEffect(() => {
        syncPermission();
    }, [syncPermission]);

    const supported = isNotificationSupported();

    const handleTestNotification = () => {
        sendWebNotification({
            type: 'completion',
            title: 'Test Notification',
            body: 'Notifications are working correctly!',
            tag: 'test',
        }, true);
    };

    return (
        <div className="p-6 space-y-6">
            <div>
                <h3 className="text-lg font-semibold">Notifications</h3>
                <p className="text-sm text-muted-foreground mt-1">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1075JsxTextConfigureHowAndWhenYouReceiveNotifications')}</p>
            </div>

            {!supported ? (
                <div className="rounded-2xl border p-4">
                    <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1082JsxTextYourBrowserDoesNotSupportNotifications')}</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {/* Master toggle */}
                    <div className="rounded-2xl border p-4">
                        <NotificationToggle
                            icon={Bell}
                            label={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1091JsxAttrLabelEnableNotifications')}
                            description={
                                permission === 'granted'
                                    ? 'Browser permission granted'
                                    : permission === 'denied'
                                        ? 'Blocked by browser — update in browser site settings'
                                        : 'Will request browser permission when enabled'
                            }
                            enabled={preferences.enabled}
                            onToggle={() => toggleEnabled()}
                        />
                    </div>

                    {preferences.enabled && (
                        <>
                            {/* Notification types */}
                            <div>
                                <h4 className="text-sm font-medium mb-3">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1108JsxTextNotificationTypes')}</h4>
                                <div className="rounded-2xl border divide-y">
                                    <NotificationToggle
                                        icon={CheckCircle2}
                                        label={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1112JsxAttrLabelTaskCompletions')}
                                        description={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1113JsxAttrDescriptionWhenASessionFinishesItsTask')}
                                        enabled={preferences.onCompletion}
                                        onToggle={(v) => setPreference('onCompletion', v)}
                                    />
                                    <NotificationToggle
                                        icon={AlertTriangle}
                                        label="Errors"
                                        description={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1120JsxAttrDescriptionWhenASessionEncountersAnError')}
                                        enabled={preferences.onError}
                                        onToggle={(v) => setPreference('onError', v)}
                                    />
                                    <NotificationToggle
                                        icon={HelpCircle}
                                        label="Questions"
                                        description={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1127JsxAttrDescriptionWhenKortixNeedsYourInputToContinue')}
                                        enabled={preferences.onQuestion}
                                        onToggle={(v) => setPreference('onQuestion', v)}
                                    />
                                    <NotificationToggle
                                        icon={ShieldCheck}
                                        label={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1133JsxAttrLabelPermissionRequests')}
                                        description={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1134JsxAttrDescriptionWhenKortixNeedsPermissionToUseATool')}
                                        enabled={preferences.onPermission}
                                        onToggle={(v) => setPreference('onPermission', v)}
                                    />
                                </div>
                            </div>

                            {/* Behavior */}
                            <div>
                                <h4 className="text-sm font-medium mb-3">Behavior</h4>
                                <div className="rounded-2xl border divide-y">
                                    <NotificationToggle
                                        icon={EyeOff}
                                        label={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1147JsxAttrLabelOnlyWhenTabIsHidden')}
                                        description={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1148JsxAttrDescriptionOnlyNotifyWhenYouReOnAnotherTab')}
                                        enabled={preferences.onlyWhenHidden}
                                        onToggle={(v) => setPreference('onlyWhenHidden', v)}
                                    />
                                    <NotificationToggle
                                        icon={Volume2}
                                        label={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1154JsxAttrLabelNotificationSound')}
                                        description={tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1155JsxAttrDescriptionPlayASoundWhenANotificationIsSent')}
                                        enabled={preferences.playSound}
                                        onToggle={(v) => setPreference('playSound', v)}
                                    />
                                </div>
                            </div>

                            {/* Test */}
                            <Button onClick={handleTestNotification} variant="outline" size="sm">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1164JsxTextSendTestNotification')}</Button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

interface NotificationToggleProps {
    icon: LucideIcon;
    label: string;
    description: string;
    enabled: boolean;
    onToggle: (value: boolean) => void;
    disabled?: boolean;
}

function NotificationToggle({ icon: Icon, label, description, enabled, onToggle, disabled }: NotificationToggleProps) {
    return (
        <div className="flex items-start justify-between gap-4 px-4 py-3">
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
                disabled={disabled}
            />
        </div>
    );
}

const CREDIT_PACKAGES: { credits: number; price: number }[] = [
    { credits: 1000, price: 10 },
    { credits: 2500, price: 25 },
    { credits: 5000, price: 50 },
    { credits: 10000, price: 100 },
    { credits: 25000, price: 250 },
    { credits: 50000, price: 500 },
];

export function BillingTab({ returnUrl, isActive }: { returnUrl: string; isActive: boolean }) {
    const { session, isLoading: authLoading } = useAuth();
    const highlight = useUserSettingsModalStore((s) => s.highlight);
    const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
    const [selectedPackage, setSelectedPackage] = useState<(typeof CREDIT_PACKAGES)[number] | null>(null);
    const [isPurchasing, setIsPurchasing] = useState(false);
    const [purchaseError, setPurchaseError] = useState<string | null>(null);
    const queryClient = useQueryClient();

    // Scope all reads + the credit-purchase mutation below to the account this
    // BillingTab was rendered for. On /accounts/[id] this is wrapped in a
    // BillingAccountProvider; everywhere else (admin tab, etc.) falls back to
    // the user's primary account.
    const billingAccountId = useBillingAccountId();

    // Use unified account state hook.
    // When any instance is provisioning, poll every 5s so the status
    // badge updates automatically without the user having to reopen Settings.
    const {
        data: accountState,
        isLoading: isLoadingSubscription,
        error: subscriptionError,
    } = useQuery<AccountState>({
        queryKey: accountStateKeys.state(billingAccountId),
        queryFn: () => billingApi.getAccountState(false, billingAccountId),
        enabled: !!session && !authLoading,
        staleTime: 1000 * 60 * 2,
        gcTime: 1000 * 60 * 15,
        refetchOnWindowFocus: false,
        refetchOnMount: true,
        // Poll every 5s while any instance is still provisioning; stop otherwise.
        refetchInterval: (query) => {
            const data = query.state.data as AccountState | undefined;
            const hasProvisioning = data?.instances?.some(
                (i: any) => i.status === 'provisioning'
            );
            return hasProvisioning ? 5000 : false;
        },
        refetchIntervalInBackground: false,
    });
    
    const createPortalSessionMutation = useCreatePortalSession();

    const totalCredits = accountStateSelectors.totalCredits(accountState);

    // Refetch billing info whenever the billing tab becomes active (only once per activation)
    const prevIsActiveRef = useRef(false);
    useEffect(() => {
        // Only refetch if tab just became active (not on every render)
        if (isActive && !prevIsActiveRef.current && session && !authLoading) {
            // Use centralized invalidation which includes deduplication
            invalidateAccountState(queryClient, true);
        }
        prevIsActiveRef.current = isActive;
        // Only depend on isActive, session, and authLoading - not the refetch functions
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive, session, authLoading]);

    const handleManageSubscription = () => {
        createPortalSessionMutation.mutate({ return_url: returnUrl });
    };

    const handlePurchaseCredits = async () => {
        if (!selectedPackage) return;
        setIsPurchasing(true);
        setPurchaseError(null);
        try {
            const response = await billingApi.purchaseCredits({
                amount: selectedPackage.price,
                success_url: `${window.location.origin}/projects?credit_purchase=success`,
                cancel_url: window.location.href,
            }, billingAccountId);
            if (response.checkout_url) {
                window.location.href = response.checkout_url;
            } else {
                throw new Error('No checkout URL received');
            }
        } catch (err: any) {
            const msg = err?.details?.detail || err?.message || 'Failed to create checkout session';
            setPurchaseError(msg);
            toast.error(msg);
        } finally {
            setIsPurchasing(false);
        }
    };



    const isLoading = isLoadingSubscription || authLoading;
    const error = subscriptionError ? (subscriptionError instanceof Error ? subscriptionError.message : 'Failed to load subscription data') : null;

    if (isLoading) {
        return (
            <div className="p-4 sm:p-6 space-y-5 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
                <Skeleton className="h-8 w-32" />
                <div className="space-y-4">
                    <Skeleton className="h-32 w-full" />
                    <Skeleton className="h-32 w-full" />
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-4 sm:p-6 min-w-0 max-w-full overflow-x-hidden">
                <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            </div>
        );
    }

    const subscription = accountState?.subscription;
    const canPurchaseCredits = subscription?.can_purchase_credits || false;

    // Subscription state drives the whole tab. When billing is on and there's
    // no active subscription, the team-plan checkout IS the page — everything
    // else (wallet, limits, top-up) is noise until they're on a plan.
    const isPerSeat = accountState?.billing_model === 'per_seat';
    const hasActiveSubscription = Boolean(subscription?.subscription_id);
    const subscribedToTeam = isPerSeat && hasActiveSubscription;
    const showTeamCheckout = isBillingEnabled() && !hasActiveSubscription;

    return (
        <div className="p-4 sm:p-6 space-y-6 min-w-0 max-w-full overflow-x-hidden">

            {/* ── Header ── */}
            <div>
                <h1 className="text-lg font-medium tracking-tight">Billing</h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                    {showTeamCheckout
                        ? 'Put your whole team on Kortix.'
                        : 'Your plan, wallet, and usage.'}
                </p>
            </div>

            {showTeamCheckout ? (
                /* ── Not subscribed: a compact CTA that opens the one Team plan
                       modal. The full pricing/checkout lives ONLY in that modal. */
                <>
                    <div className="flex flex-col items-start gap-4 rounded-2xl border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <h3 className="text-base font-semibold">Kortix Team</h3>
                            <p className="mt-0.5 text-sm text-muted-foreground">
                                Subscribe to put your whole team on Kortix — LLM compute and AI Computers, one wallet.
                            </p>
                        </div>
                        <Button
                            onClick={() => openUpgradeDialog({ reason: 'subscription_required' })}
                            className="w-full shrink-0 sm:w-auto"
                        >
                            Subscribe to Team plan
                        </Button>
                    </div>
                    <div className="flex justify-center">
                        <Button
                            variant="link"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={handleManageSubscription}
                            disabled={createPortalSessionMutation.isPending}
                        >
                            {createPortalSessionMutation.isPending ? 'Loading…' : 'Manage billing'}
                        </Button>
                    </div>
                </>
            ) : (
                /* ── Subscribed: plan + wallet + spend + top-up + manage ── */
                <>
                    {/* Insufficient credits alert (routed here from 402 errors) */}
                    {highlight === 'credits' && totalCredits <= 0 && (
                        <InfoBanner tone="warning" icon={AlertTriangle} title="You ran out of credits">
                            {canPurchaseCredits
                                ? 'Buy credits below or turn on auto top-up so it never happens again.'
                                : 'Top up your wallet to keep your agents running.'}
                        </InfoBanner>
                    )}

                    {/* Plan / wallet / spend / limits */}
                    <AccountOverviewTab accountId={billingAccountId} />

                    {/* Legacy machine-billed users — claim the new seat-based plan */}
                    {accountState?.billing_model === 'legacy' && <ClaimPerSeatCard accountState={accountState} />}

                    {/* Team seats — when on the per-seat plan */}
                    {subscribedToTeam && <SeatManagementCard accountState={accountState} />}

                    {/* Auto top-up (primary — recommended first so users avoid running dry) */}
                    {canPurchaseCredits && (
                        <div className="border-t border-border pt-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <p className="text-xs uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                                    <Zap className="size-3" />Auto top-up</p>
                                <p className="text-xs text-muted-foreground/60">Never run out again</p>
                            </div>
                            <AutoTopupCard fetchSettings showSaveButton />
                        </div>
                    )}

                    {/* Buy credits (secondary — one-time) */}
                    {canPurchaseCredits && (
                        <div className="border-t border-border pt-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <p className="text-xs uppercase tracking-widest text-muted-foreground">Buy credits</p>
                                <p className="text-xs text-muted-foreground/60">One-time top-up</p>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {CREDIT_PACKAGES.map((pkg) => {
                                    const isSelected = selectedPackage?.price === pkg.price;
                                    return (
                                        <Button
                                            key={pkg.price}
                                            type="button"
                                            onClick={() => setSelectedPackage(pkg)}
                                            disabled={isPurchasing}
                                            variant="outline"
                                            className={cn(
                                                'h-auto p-3 flex-col rounded-2xl text-center',
                                                isSelected && 'border-foreground bg-foreground/5',
                                            )}
                                        >
                                            <span className="text-lg font-semibold tabular-nums">${pkg.price}</span>
                                            <span className="text-xs text-muted-foreground">{formatCredits(pkg.credits)} credits</span>
                                        </Button>
                                    );
                                })}
                            </div>
                            {purchaseError && (
                                <Alert variant="destructive">
                                    <AlertTriangle className="h-4 w-4" />
                                    <AlertDescription>{purchaseError}</AlertDescription>
                                </Alert>
                            )}
                            <Button
                                onClick={handlePurchaseCredits}
                                disabled={isPurchasing || !selectedPackage}
                                className="w-full"
                            >
                                {isPurchasing
                                    ? 'Processing...'
                                    : selectedPackage
                                        ? `Buy $${selectedPackage.price} in credits`
                                        : 'Select a package'}
                            </Button>
                        </div>
                    )}

                    {/* Manage */}
                    <div className="border-t border-border pt-4">
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            onClick={handleManageSubscription}
                            disabled={createPortalSessionMutation.isPending}
                        >
                            {createPortalSessionMutation.isPending ? 'Loading...' : 'Manage billing'}
                        </Button>
                    </div>
                </>
            )}

        </div>
    );
}

export function TransactionsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
    return (
        <div className="p-4 sm:p-6 pb-12 sm:pb-6 space-y-4 min-w-0 max-w-full overflow-x-hidden">
            <div>
                <h3 className="text-lg font-medium tracking-tight mb-0.5">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1723JsxTextCreditLedger')}</h3>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1725JsxTextLedgerBackedAccountEventsFromTheKortixSchema')}</p>
            </div>
            <CreditTransactions />
        </div>
    );
}
