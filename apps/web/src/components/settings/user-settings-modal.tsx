'use client';

import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
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
    Trash2,

    ExternalLink,
    Info,
    Plug,
    Bell,
    Mail,
    Smartphone,
    AppWindow,
    Key,
    Camera,
    Upload,
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
import { backendApi } from '@/lib/api-client';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Switch } from '@/components/ui/switch';

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
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';
import { AutoTopupCard } from '@/components/billing/auto-topup-card';
import { 
    useAccountState,
    accountStateKeys,
    accountStateSelectors,
    useCreatePortalSession,
    useCancelSubscription,
    useReactivateSubscription,
    invalidateAccountState,
} from '@/hooks/billing';
import { billingApi } from '@/lib/api/billing';
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
    ArrowRight,
    Plus,
} from 'lucide-react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';

import { cancelSandbox, reactivateSandbox } from '@/lib/platform-client';

import { formatCredits } from '@kortix/shared';
import { LanguageSwitcher } from './language-switcher';
import { useTranslations } from 'next-intl';
// import { ReferralsTab } from '@/components/referrals/referrals-tab';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Keyboard, CheckCircle2, HelpCircle, ShieldCheck, Volume2, EyeOff, Globe } from 'lucide-react';
import CreditTransactions from '@/components/billing/credit-transactions';
import { useWebNotificationStore } from '@/stores/web-notification-store';
import { activateInstanceSelection, useServerStore } from '@/stores/server-store';
import { isNotificationSupported, sendWebNotification } from '@/lib/web-notifications';
import { useSoundStore, type SoundPack, type SoundEvent } from '@/stores/sound-store';
import { previewSound } from '@/lib/sounds';
import { AppearanceTab } from './appearance-tab';
import {
    getPreferenceTabs,
    getAccountTabs,
    getInstanceTabs,
    type SettingsTabId,
} from '@/lib/menu-registry';
import { getCurrentInstanceIdFromPathname } from '@/lib/instance-routes';
import { listSandboxes, type SandboxInfo } from '@/lib/platform-client';
import { InstanceMembersPanel } from '@/app/instances/_components/instance-members-panel';
import { InstanceProjectsPanel } from '@/app/instances/_components/instance-projects-panel';

type TabId = SettingsTabId;

interface Tab {
    id: TabId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    disabled?: boolean;
}

interface UserSettingsModalProps {
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
    const billingActive = isBillingEnabled();
    const pathname = usePathname();

    // Scope Instance-level tabs (Team / Projects) to `/instances/:id/...` so
    // the section vanishes on the `/instances` list or account-only pages.
    const currentInstanceId = getCurrentInstanceIdFromPathname(pathname);
    const instanceSandboxQuery = useQuery({
        queryKey: ['platform', 'sandbox-by-id', currentInstanceId],
        queryFn: async (): Promise<SandboxInfo | null> => {
            if (!currentInstanceId) return null;
            const all = await listSandboxes(currentInstanceId);
            return all.find((s) => s.sandbox_id === currentInstanceId) ?? null;
        },
        enabled: open && !!currentInstanceId,
        staleTime: 30_000,
    });
    const instanceSandbox = instanceSandboxQuery.data ?? null;
    const hasInstance = !!instanceSandbox;

    // Tab definitions from the central menu registry (single source of truth)
    const preferenceTabs: Tab[] = getPreferenceTabs();
    const accountTabs: Tab[] = getAccountTabs(billingActive);
    const instanceTabs: Tab[] = hasInstance ? getInstanceTabs() : [];

    // Skeleton window: the URL is scoped to an instance but the sandbox fetch
    // hasn't resolved yet. Render a placeholder group so the sidebar doesn't
    // pop a new section in a second later.
    const instanceLoading =
        open && !!currentInstanceId && !hasInstance && instanceSandboxQuery.isLoading;

    type TabGroup = { label: string; tabs: Tab[]; skeleton?: boolean };
    const tabGroups: TabGroup[] = [
        { label: 'Preferences', tabs: preferenceTabs },
        ...(instanceTabs.length > 0
            ? [{ label: instanceSandbox?.name || 'Instance', tabs: instanceTabs }]
            : instanceLoading
              ? [{ label: '', tabs: [], skeleton: true }]
              : []),
        { label: 'Account', tabs: accountTabs },
    ];

    const allTabs = [...preferenceTabs, ...instanceTabs, ...accountTabs];

    useEffect(() => {
        setActiveTab(defaultTab);
    }, [defaultTab]);

    useEffect(() => {
        if (
            (activeTab === 'instance-members' || activeTab === 'instance-projects') &&
            !hasInstance
        ) {
            setActiveTab('general');
        }
    }, [activeTab, hasInstance]);

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
                                {instanceLoading ? (
                                    <>
                                        <Skeleton className="h-9 w-24 rounded-md" />
                                        <Skeleton className="h-9 w-24 rounded-md" />
                                    </>
                                ) : null}
                                {allTabs.map((tab) => {
                                    const Icon = tab.icon;
                                    const isActive = activeTab === tab.id;

                                    return (
                                        <Button
                                            key={tab.id}
                                            onClick={() => handleTabClick(tab.id)}
                                            disabled={tab.disabled}
                                            variant={isActive ? "secondary" : "ghost"}
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
                                {activeTab === 'general' && <GeneralTab onClose={() => onOpenChange(false)} />}
                                {activeTab === 'appearance' && <AppearanceTab />}
                                {activeTab === 'sounds' && <SoundsTab />}
                                {activeTab === 'notifications' && <NotificationsTab />}
                                {activeTab === 'shortcuts' && <KeyboardShortcutsTab />}
                                {activeTab === 'billing' && <BillingTab returnUrl={returnUrl} isActive={activeTab === 'billing'} />}
                                {activeTab === 'transactions' && <TransactionsTab />}
                                {activeTab === 'instance-members' && instanceSandbox && (
                                    <InstanceMembersPanel sandboxId={instanceSandbox.sandbox_id} />
                                )}
                                {activeTab === 'instance-projects' && instanceSandbox && (
                                    <InstanceProjectsPanel
                                        sandbox={instanceSandbox}
                                        canManage={!!instanceSandbox.can_manage}
                                    />
                                )}
                                {/* {activeTab === 'referrals' && <ReferralsTab isActive={open && activeTab === 'referrals'} />} */}
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
                                                <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">{group.label}</span>
                                            )}
                                        </div>
                                        <div className="flex flex-col gap-0.5">
                                            {group.skeleton ? (
                                                <>
                                                    <Skeleton className="mx-2 h-9 rounded-md" />
                                                    <Skeleton className="mx-2 h-9 rounded-md" />
                                                </>
                                            ) : (
                                                group.tabs.map((tab) => {
                                                const Icon = tab.icon;
                                                const isActive = activeTab === tab.id;

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
                            {activeTab === 'general' && <GeneralTab onClose={() => onOpenChange(false)} />}
                            {activeTab === 'appearance' && <AppearanceTab />}
                            {activeTab === 'sounds' && <SoundsTab />}
                            {activeTab === 'notifications' && <NotificationsTab />}
                            {activeTab === 'shortcuts' && <KeyboardShortcutsTab />}
                            {activeTab === 'billing' && <BillingTab returnUrl={returnUrl} isActive={activeTab === 'billing'} />}
                            {activeTab === 'transactions' && <TransactionsTab />}
                            {activeTab === 'instance-members' && instanceSandbox && (
                                <InstanceMembersPanel sandboxId={instanceSandbox.sandbox_id} />
                            )}
                            {activeTab === 'instance-projects' && instanceSandbox && (
                                <InstanceProjectsPanel
                                    sandbox={instanceSandbox}
                                    canManage={!!instanceSandbox.can_manage}
                                />
                            )}
                            {/* {activeTab === 'referrals' && <ReferralsTab isActive={open && activeTab === 'referrals'} />} */}
                        </div>
                    </div>
                )}


            </DialogContent>
        </Dialog>
    );
}


function GeneralTab({ onClose }: { onClose: () => void }) {
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
    const queryClient = useQueryClient();

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

    const uploadAvatar = async (userId: string): Promise<string | null> => {
        if (!avatarFile) return avatarUrl;

        setIsUploadingAvatar(true);
        try {
            const fileExt = avatarFile.name.split('.').pop();
            const fileName = `${userId}-${Date.now()}.${fileExt}`;

            // Upload to Supabase Storage
            const { error: uploadError } = await supabase.storage
                .from('avatars')
                .upload(fileName, avatarFile, {
                    cacheControl: '3600',
                    upsert: true,
                });

            if (uploadError) {
                console.error('Upload error:', uploadError);
                throw uploadError;
            }

            // Get public URL
            const { data: { publicUrl } } = supabase.storage
                .from('avatars')
                .getPublicUrl(fileName);

            return publicUrl;
        } catch (error) {
            console.error('Avatar upload failed:', error);
            toast.error(t('profilePicture.uploadFailed'));
            return null;
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

            // Upload avatar if a new one was selected
            let newAvatarUrl = avatarUrl;
            if (avatarFile) {
                const uploadedUrl = await uploadAvatar(userId);
                if (uploadedUrl) {
                    newAvatarUrl = uploadedUrl;
                }
            }

            const { data, error } = await supabase.auth.updateUser({
                data: { 
                    name: userName,
                    avatar_url: newAvatarUrl,
                }
            });

            if (error) throw error;

            // Clean up preview URL
            if (avatarPreview) {
                URL.revokeObjectURL(avatarPreview);
                setAvatarPreview(null);
            }
            setAvatarFile(null);
            setAvatarUrl(newAvatarUrl);

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
                                accept="image/*"
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
                        <DialogContent className="max-w-md max-h-[90vh] sm:max-h-[85vh] overflow-y-auto p-4 sm:p-6">
                            <DialogHeader>
                                <DialogTitle className="text-base sm:text-lg">{t('deleteAccount.dialogTitle')}</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4">
                                <Alert className={cn(
                                    "shadow-none",
                                    deletionType === 'immediate' 
                                        ? "border-red-500/30 bg-red-500/5" 
                                        : "border-amber-500/30 bg-amber-500/5"
                                )}>
                                    <AlertTriangle className={cn(
                                        "h-4 w-4 flex-shrink-0",
                                        deletionType === 'immediate' ? "text-red-600" : "text-amber-600"
                                    )} />
                                    <AlertDescription>
                                        <strong className="text-foreground text-sm sm:text-base">
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
                                        <div className="flex items-start gap-2 sm:gap-3 rounded-md border p-3 sm:p-4">
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
                                        <div className="flex items-start gap-2 sm:gap-3 rounded-md border border-red-500/30 p-3 sm:p-4">
                                            <RadioGroupItem value="immediate" id="immediate" className="mt-0.5 flex-shrink-0" />
                                            <div className="space-y-1 flex-1 min-w-0">
                                                <Label htmlFor="immediate" className="font-medium cursor-pointer text-sm sm:text-base text-red-600 block">
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
                                        className="shadow-none text-sm sm:text-base"
                                        autoComplete="off"
                                    />
                                </div>
                                
                                <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-2">
                                    <Button variant="outline" onClick={() => {
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
                <h3 className="text-lg font-semibold mb-1">Keyboard Shortcuts</h3>
                <p className="text-sm text-muted-foreground">
                    View and customize keyboard shortcuts for tab navigation.
                </p>
            </div>

            {/* Modifier key picker */}
            <div className="space-y-3">
                <Label className="text-sm font-medium">Modifier key</Label>
                <p className="text-xs text-muted-foreground -mt-1">
                    Choose which modifier key is used for tab shortcuts.
                </p>
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
                <Label className="text-sm font-medium">All shortcuts</Label>
                <div className="rounded-md border divide-y">
                    {shortcuts.map((s) => (
                        <div key={s.label} className="flex items-center justify-between px-3 py-2.5">
                            <span className="text-sm text-foreground">{s.label}</span>
                            <kbd className="inline-flex h-6 items-center rounded border bg-muted px-2 text-[10px] font-mono text-muted-foreground whitespace-nowrap">
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
    const preferences = useSoundStore((s) => s.preferences);
    const setPack = useSoundStore((s) => s.setPack);
    const setVolume = useSoundStore((s) => s.setVolume);
    const setEventEnabled = useSoundStore((s) => s.setEventEnabled);

    const packs: { id: SoundPack; label: string; description: string }[] = [
        { id: 'off', label: 'Off', description: 'All sounds disabled' },
        { id: 'opencode', label: 'Default', description: 'Default sound pack' },
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
                <p className="text-sm text-muted-foreground mt-1">
                    Choose a sound pack and configure which events play sounds
                </p>
            </div>

            {/* Sound Pack Selection */}
            <div>
                <h4 className="text-sm font-medium mb-3">Sound Pack</h4>
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
                                'flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors',
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
                        <h4 className="text-sm font-medium mb-3">Sound Events</h4>
                        <div className="rounded-lg border divide-y">
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
                <p className="text-sm text-muted-foreground mt-1">
                    Configure how and when you receive notifications
                </p>
            </div>

            {!supported ? (
                <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">
                        Your browser does not support notifications.
                    </p>
                </div>
            ) : (
                <div className="space-y-6">
                    {/* Master toggle */}
                    <div className="rounded-lg border p-4">
                        <NotificationToggle
                            icon={Bell}
                            label="Enable Notifications"
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
                                <h4 className="text-sm font-medium mb-3">Notification Types</h4>
                                <div className="rounded-lg border divide-y">
                                    <NotificationToggle
                                        icon={CheckCircle2}
                                        label="Task Completions"
                                        description="When a session finishes its task"
                                        enabled={preferences.onCompletion}
                                        onToggle={(v) => setPreference('onCompletion', v)}
                                    />
                                    <NotificationToggle
                                        icon={AlertTriangle}
                                        label="Errors"
                                        description="When a session encounters an error"
                                        enabled={preferences.onError}
                                        onToggle={(v) => setPreference('onError', v)}
                                    />
                                    <NotificationToggle
                                        icon={HelpCircle}
                                        label="Questions"
                                        description="When Kortix needs your input to continue"
                                        enabled={preferences.onQuestion}
                                        onToggle={(v) => setPreference('onQuestion', v)}
                                    />
                                    <NotificationToggle
                                        icon={ShieldCheck}
                                        label="Permission Requests"
                                        description="When Kortix needs permission to use a tool"
                                        enabled={preferences.onPermission}
                                        onToggle={(v) => setPreference('onPermission', v)}
                                    />
                                </div>
                            </div>

                            {/* Behavior */}
                            <div>
                                <h4 className="text-sm font-medium mb-3">Behavior</h4>
                                <div className="rounded-lg border divide-y">
                                    <NotificationToggle
                                        icon={EyeOff}
                                        label="Only When Tab is Hidden"
                                        description="Only notify when you're on another tab or app"
                                        enabled={preferences.onlyWhenHidden}
                                        onToggle={(v) => setPreference('onlyWhenHidden', v)}
                                    />
                                    <NotificationToggle
                                        icon={Volume2}
                                        label="Notification Sound"
                                        description="Play a sound when a notification is sent"
                                        enabled={preferences.playSound}
                                        onToggle={(v) => setPreference('playSound', v)}
                                    />
                                </div>
                            </div>

                            {/* Test */}
                            <Button onClick={handleTestNotification} variant="outline" size="sm">
                                Send Test Notification
                            </Button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

interface NotificationToggleProps {
    icon: React.ComponentType<{ className?: string }>;
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

// Billing Tab Component - Usage, credits, subscription management
// ─── Instances Section ───────────────────────────────────────────────────────

function InstancesSection({ accountState, onRefetch }: { accountState: any; onRefetch: () => void }) {
    const instances = accountState?.instances ?? [];
    const canAddInstances = accountState?.can_add_instances ?? false;
    const [loading, setLoading] = useState<string | null>(null);
    const { servers, activeServerId } = useServerStore();
    const router = useRouter();
    const pathname = usePathname();

    const handleCancel = async (sandboxId: string) => {
        setLoading(sandboxId);
        try { await cancelSandbox(sandboxId); onRefetch(); }
        catch (err) { console.error('Failed to cancel:', err); }
        finally { setLoading(null); }
    };

    const handleReactivate = async (sandboxId: string) => {
        setLoading(sandboxId);
        try { await reactivateSandbox(sandboxId); onRefetch(); }
        catch (err) { console.error('Failed to reactivate:', err); }
        finally { setLoading(null); }
    };

    const handleSwitch = async (inst: any) => {
        const result = await activateInstanceSelection(inst.sandbox_id, { pathname });
        if (result) {
            router.push(result.href);
        }
    };

    return (
        <div className="border-t border-border pt-4 space-y-3">
            <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-widest text-muted-foreground">Instances</p>
                {canAddInstances && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => window.location.href = '/instances'}
                    >
                        <Plus className="size-3 mr-1" />
                        New Kortix
                    </Button>
                )}
            </div>
            {instances.length === 0 ? (
                <p className="text-xs text-muted-foreground">No instances yet.</p>
            ) : (
                <div className="space-y-1.5">
                    {instances.map((inst: any) => {
                        const serverEntry = servers.find((s) => s.sandboxId === inst.external_id);
                        const isActive = serverEntry ? activeServerId === serverEntry.id : false;
                        const hasSub = Boolean(inst.stripe_subscription_id || inst.stripe_subscription_item_id);
                        const isCancelling = inst.cancel_at_period_end;
                        return (
                            <div key={inst.sandbox_id} className={cn(
                                'flex items-center justify-between py-2.5 px-3 rounded-lg border transition-colors',
                                isActive ? 'border-foreground/15 bg-foreground/[0.02]' : 'border-border',
                            )}>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium truncate">{inst.name}</span>
                                        {isCancelling && (
                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 font-medium shrink-0">Cancelling</span>
                                        )}
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        {inst.server_type}{inst.location ? ` · ${inst.location}` : ''}
                                    </p>
                                    {inst.status === 'error' && inst.error_message && (
                                        <p className="text-xs text-destructive mt-1">{inst.error_message}</p>
                                    )}
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0 ml-3">
                                    {inst.status === 'active' && !isActive && serverEntry && (
                                        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => handleSwitch(inst)}>
                                            Switch
                                        </Button>
                                    )}
                                    {inst.status === 'error' && (
                                        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => useNewInstanceModalStore.getState().openNewInstanceModal()}>
                                            Retry
                                        </Button>
                                    )}
                                    {hasSub && !isCancelling && (
                                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" onClick={() => handleCancel(inst.sandbox_id)} disabled={loading === inst.sandbox_id}>
                                            {loading === inst.sandbox_id ? '...' : 'Cancel'}
                                        </Button>
                                    )}
                                    {hasSub && isCancelling && (
                                        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => handleReactivate(inst.sandbox_id)} disabled={loading === inst.sandbox_id}>
                                            {loading === inst.sandbox_id ? '...' : 'Reactivate'}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Billing Tab ─────────────────────────────────────────────────────────────

const CREDIT_PACKAGES: { credits: number; price: number }[] = [
    { credits: 1000, price: 10 },
    { credits: 2500, price: 25 },
    { credits: 5000, price: 50 },
    { credits: 10000, price: 100 },
    { credits: 25000, price: 250 },
    { credits: 50000, price: 500 },
];

function BillingTab({ returnUrl, isActive }: { returnUrl: string; isActive: boolean }) {
    const { session, isLoading: authLoading } = useAuth();
    const highlight = useUserSettingsModalStore((s) => s.highlight);
    const [selectedPackage, setSelectedPackage] = useState<(typeof CREDIT_PACKAGES)[number] | null>(null);
    const [isPurchasing, setIsPurchasing] = useState(false);
    const [purchaseError, setPurchaseError] = useState<string | null>(null);
    const queryClient = useQueryClient();

    const billingActive = isBillingEnabled();

    // Use unified account state hook.
    // When any instance is provisioning, poll every 5s so the status
    // badge updates automatically without the user having to reopen Settings.
    const {
        data: accountState,
        isLoading: isLoadingSubscription,
        error: subscriptionError,
        refetch: refetchSubscription
    } = useQuery<AccountState>({
        queryKey: accountStateKeys.state(),
        queryFn: () => billingApi.getAccountState(false),
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
    
    // Get commitment info from account state
    const commitmentInfo = accountState?.subscription.commitment;

    const createPortalSessionMutation = useCreatePortalSession();


    const planName = accountStateSelectors.planName(accountState);
    
    // Get scheduled change from account state
    const hasScheduledChange = accountState?.subscription.has_scheduled_change && accountState?.subscription.scheduled_change;
    const scheduledChange = accountState?.subscription.scheduled_change;
    
    const getFrontendTierName = (tierKey: string) => {
        if (tierKey === 'free') return 'Free';
        if (tierKey === 'pro') return 'Pro';
        return tierKey || 'Free';
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
    const dailyCreditsInfo = accountStateSelectors.dailyCreditsInfo(accountState);
    
    const dailyCredits = accountStateSelectors.dailyCredits(accountState);
    const monthlyCredits = accountStateSelectors.monthlyCredits(accountState);
    const nonExpiringCredits = accountStateSelectors.extraCredits(accountState);
    const totalCredits = accountStateSelectors.totalCredits(accountState);
    
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

    const handlePurchaseCredits = async () => {
        if (!selectedPackage) return;
        setIsPurchasing(true);
        setPurchaseError(null);
        try {
            const response = await billingApi.purchaseCredits({
                amount: selectedPackage.price,
                success_url: `${window.location.origin}/instances?credit_purchase=success`,
                cancel_url: window.location.href,
            });
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

    if (!billingActive) {
        return (
            <div className="p-4 sm:p-6 min-w-0 max-w-full overflow-x-hidden">
                <Alert className="border-blue-500/50 bg-blue-500/10">
                    <Shield className="h-4 w-4 text-blue-500" />
                    <AlertDescription>
                        <div className="font-medium mb-1">Self-Hosted</div>
                        <div className="text-sm text-muted-foreground">
                            Billing is disabled in this environment.
                        </div>
                    </AlertDescription>
                </Alert>
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
    const subStatus = subscription?.status;
    const isSubscribed = subStatus === 'active' || subStatus === 'trialing';
    const isFreeTier = subscription?.tier_key === 'free' || subscription?.tier_key === 'none';
    const isCancelled = subscription?.is_cancelled || subscription?.cancel_at_period_end;
    const canPurchaseCredits = subscription?.can_purchase_credits || false;
    const yoloUsage = accountState?.yolo_usage;
    const yoloResetAt = yoloUsage?.window_reset_at ? new Date(yoloUsage.window_reset_at).toLocaleString() : null;

    return (
        <div className="p-4 sm:p-6 space-y-6 min-w-0 max-w-full overflow-x-hidden">

            {/* ── Header ── */}
            <div>
                <h1 className="text-lg font-medium tracking-tight">Billing</h1>
                <p className="text-sm text-muted-foreground mt-0.5">Credits, instances, and subscription.</p>
            </div>

            {/* ── Insufficient credits alert (routed here from 402 errors) ── */}
            {highlight === 'credits' && totalCredits <= 0 && (
                <Alert className="border-amber-500/40 bg-amber-500/5">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertDescription>
                        <div className="text-sm font-medium text-foreground">You ran out of credits.</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                            {canPurchaseCredits
                                ? 'Buy credits below or enable auto top-up so it never happens again.'
                                : 'Subscribe to continue using the assistant.'}
                        </div>
                    </AlertDescription>
                </Alert>
            )}

            {/* ── Credit Balance ── */}
            <div>
                <p className="text-xs uppercase tracking-widest text-muted-foreground mb-3">Credits</p>
                <div className="flex items-baseline gap-1">
                    <span className={cn(
                        "text-3xl font-medium tabular-nums tracking-tight",
                        totalCredits <= 0 && "text-amber-600 dark:text-amber-500"
                    )}>
                        ${(totalCredits / 100).toFixed(2)}
                    </span>
                </div>
            </div>

            {/* ── Kortix YOLO (shown between Credits and Top-up actions) ── */}
            {yoloUsage && (
                <div className="border-t border-border pt-4 space-y-2">
                    <div className="flex items-center justify-between">
                        <p className="text-xs uppercase tracking-widest text-muted-foreground">Kortix YOLO</p>
                        <a
                            href="https://yolo.kortix.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                            Learn more <ExternalLink className="size-3" />
                        </a>
                    </div>
                    <div className="text-2xl font-medium tabular-nums tracking-tight">{yoloUsage.used_percent}%</div>
                    <p className="text-sm text-muted-foreground">
                        {yoloUsage.window_started && yoloResetAt
                            ? `Resets ${yoloResetAt}`
                            : '5h window starts on first request'}
                    </p>
                    <p className="text-xs text-muted-foreground/70 leading-relaxed pt-1">
                        Every Kortix subscription includes{' '}
                        <a
                            href="https://yolo.kortix.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-foreground/80 underline underline-offset-2 decoration-foreground/30 hover:decoration-foreground/60"
                        >
                            Kortix YOLO
                        </a>{' '}—
                        an all-you-can-use AI model subscription powered by our in-house model router.
                        Choose between <span className="font-medium text-foreground/80">Fast</span> and{' '}
                        <span className="font-medium text-foreground/80">Think</span> in the model selector
                        by default. Zero credit cost; the rolling 5&nbsp;hour window resets automatically
                        so you can keep building without thinking about usage.
                    </p>
                </div>
            )}

            {/* ── Auto top-up (primary — recommended first so users avoid this altogether) ── */}
            {canPurchaseCredits && (
                <div className="border-t border-border pt-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-xs uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                            <Zap className="size-3" />
                            Auto top-up
                        </p>
                        <p className="text-[11px] text-muted-foreground/60">Never run out again</p>
                    </div>
                    <AutoTopupCard fetchSettings showSaveButton />
                </div>
            )}

            {/* ── Buy credits (secondary — one-time) ── */}
            {canPurchaseCredits && (
                <div className="border-t border-border pt-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-xs uppercase tracking-widest text-muted-foreground">Buy credits</p>
                        <p className="text-[11px] text-muted-foreground/60">One-time top-up</p>
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
                                        'h-auto p-3 flex-col rounded-xl text-center',
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

            {/* ── Instances ── */}
            {!isFreeTier && (
                <InstancesSection accountState={accountState} onRefetch={refetchSubscription} />
            )}

            {/* ── Manage ── */}
            <div className="border-t border-border pt-4">
                <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={handleManageSubscription}
                    disabled={createPortalSessionMutation.isPending}
                >
                    {createPortalSessionMutation.isPending ? 'Loading...' : 'Manage on Stripe'}
                </Button>
            </div>

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
            onClick={() => window.open('/help/credits', '_blank', 'noopener,noreferrer')}
          >
            Learn More about Credits
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function TransactionsTab() {
    return (
        <div className="p-4 sm:p-6 pb-12 sm:pb-6 space-y-4 min-w-0 max-w-full overflow-x-hidden">
            <div>
                <h3 className="text-lg font-medium tracking-tight mb-0.5">Credit ledger</h3>
                <p className="text-sm text-muted-foreground">
                    Ledger-backed account events from the Kortix schema: purchases, grants, usage, expirations, refunds, and bonuses.
                </p>
            </div>
            <CreditTransactions />
        </div>
    );
}
