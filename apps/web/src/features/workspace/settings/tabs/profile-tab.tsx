'use client';

/**
 * The Profile tab — five sections, each a `SettingsSectionHeader` plus its
 * control: profile picture, display name, email (read-only), two-factor
 * authentication, and account deletion.
 *
 * Ported from `features/accounts/settings/general-tab.tsx` (avatar upload,
 * name save, account deletion) and `features/accounts/settings/
 * security-tab.tsx` (MFA factor list and TOTP enrollment — `FactorRow` and
 * `totpQrSrc` are reused directly from there; the surrounding query/mutation
 * plumbing is re-created here against the same `supabaseMFAService` calls,
 * since `SecurityTab` doesn't export a header-less body to mount as-is).
 * Both source files stay in place — they still back the legacy
 * `SidePanelUserSettings` surface until Task 10 retires it.
 *
 * No password-change control: `security-tab.tsx` only ever held MFA
 * enrollment, and no password surface exists anywhere in this codebase (see
 * this task's report). Log out stays in `features/layout/user-menu.tsx`.
 *
 * `ProfileTabView` is the pure, props-only half — it needs no React Query
 * client, router, or Supabase session, so it renders under
 * `renderToStaticMarkup` (see `profile-tab.test.tsx`). `ProfileTab` is the
 * container: every hook below only runs once this component actually
 * mounts, which `SettingsTabPane` guarantees happens only while this tab is
 * the active one — so opening the panel never fires this tab's fetches.
 */

import { PlusIcon as Plus, ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useAccountDeletionStatus,
  useCancelAccountDeletion,
  useDeleteAccountImmediately,
  useRequestAccountDeletion,
} from '@/hooks/account/use-account-deletion';
import { FactorRow, totpQrSrc } from '@/features/accounts/settings/security-tab';
import { invalidateTokenCache } from '@/lib/auth-token';
import { isBillingEnabled } from '@/lib/config';
import { createClient } from '@/lib/supabase/client';
import type { FactorInfo } from '@/lib/supabase/mfa';
import { supabaseMFAService } from '@/lib/supabase/mfa';
import { cn } from '@/lib/utils';

const PROFILE_QUERY_KEY = ['account', 'profile'] as const;
const MFA_FACTORS_QUERY_KEY = ['mfa-factors'] as const;
const MFA_AAL_QUERY_KEY = ['mfa-aal'] as const;

function getInitials(name: string): string {
  return (
    name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'U'
  );
}

type DeletionType = 'grace-period' | 'immediate';

export interface EnrollingFactor {
  factorId: string;
  qr: string;
  secret?: string;
}

export interface ProfileTabViewProps {
  // Profile picture
  userName?: string;
  avatarUrl?: string;
  avatarPreview?: string | null;
  isUploadingAvatar?: boolean;
  fileInputRef?: React.RefObject<HTMLInputElement | null>;
  onOpenFilePicker?: () => void;
  onAvatarFileChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveAvatar?: () => void;
  isRemovingAvatar?: boolean;

  // Name
  nameDraft?: string;
  onNameDraftChange?: (value: string) => void;
  isNameDirty?: boolean;
  isSavingName?: boolean;
  onSaveName?: () => void;

  // Email
  userEmail?: string;

  // Two-factor authentication
  factors?: FactorInfo[];
  factorsLoading?: boolean;
  sessionVerified?: boolean;
  removeFactorTarget?: string | null;
  onRequestRemoveFactor?: (id: string) => void;
  onCancelRemoveFactor?: () => void;
  onConfirmRemoveFactor?: () => void;
  isRemovingFactor?: boolean;
  enrolling?: EnrollingFactor | null;
  enrollCode?: string;
  onEnrollCodeChange?: (value: string) => void;
  onStartEnroll?: () => void;
  isStartingEnroll?: boolean;
  onVerifyEnroll?: () => void;
  isVerifyingEnroll?: boolean;
  onCancelEnroll?: () => void;

  // Delete account
  accountDeletionSupported?: boolean;
  hasPendingDeletion?: boolean;
  deletionScheduledForLabel?: string | null;
  showDeleteDialog?: boolean;
  onOpenDeleteDialog?: () => void;
  onCloseDeleteDialog?: () => void;
  deletionType?: DeletionType;
  onDeletionTypeChange?: (value: DeletionType) => void;
  deleteConfirmText?: string;
  onDeleteConfirmTextChange?: (value: string) => void;
  onConfirmDelete?: () => void;
  isDeletingAccount?: boolean;
  showCancelDeletionDialog?: boolean;
  onOpenCancelDeletionDialog?: () => void;
  onCloseCancelDeletionDialog?: () => void;
  onConfirmCancelDeletion?: () => void;
  isCancelingDeletion?: boolean;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `ProfileTab` so this renders under
 *  `renderToStaticMarkup` without a `QueryClientProvider` or a Supabase
 *  session — see `MigrateToV2ButtonView` and `SettingsPanelShell` for the
 *  same split. Every prop is optional with a safe default so the bare
 *  `<ProfileTabView />` the test file renders shows every section fully
 *  formed. */
export function ProfileTabView({
  userName = '',
  avatarUrl = '',
  avatarPreview = null,
  isUploadingAvatar = false,
  fileInputRef,
  onOpenFilePicker = () => {},
  onAvatarFileChange = () => {},
  onRemoveAvatar = () => {},
  isRemovingAvatar = false,
  nameDraft = '',
  onNameDraftChange = () => {},
  isNameDirty = false,
  isSavingName = false,
  onSaveName = () => {},
  userEmail = '',
  factors = [],
  factorsLoading = false,
  sessionVerified = false,
  removeFactorTarget = null,
  onRequestRemoveFactor = () => {},
  onCancelRemoveFactor = () => {},
  onConfirmRemoveFactor = () => {},
  isRemovingFactor = false,
  enrolling = null,
  enrollCode = '',
  onEnrollCodeChange = () => {},
  onStartEnroll = () => {},
  isStartingEnroll = false,
  onVerifyEnroll = () => {},
  isVerifyingEnroll = false,
  onCancelEnroll = () => {},
  accountDeletionSupported = true,
  hasPendingDeletion = false,
  deletionScheduledForLabel = null,
  showDeleteDialog = false,
  onOpenDeleteDialog = () => {},
  onCloseDeleteDialog = () => {},
  deletionType = 'grace-period',
  onDeletionTypeChange = () => {},
  deleteConfirmText = '',
  onDeleteConfirmTextChange = () => {},
  onConfirmDelete = () => {},
  isDeletingAccount = false,
  showCancelDeletionDialog = false,
  onOpenCancelDeletionDialog = () => {},
  onCloseCancelDeletionDialog = () => {},
  onConfirmCancelDeletion = () => {},
  isCancelingDeletion = false,
}: ProfileTabViewProps) {
  const verified = factors.filter((f) => f.status === 'verified');

  return (
    <div className="mx-auto w-full max-w-lg space-y-8 px-6 py-10">
      {/* 1. Profile picture */}
      <section className="space-y-4">
        <SettingsSectionHeader
          title="Profile picture"
          description="Shown across Kortix wherever your account appears."
        />
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onOpenFilePicker}
            disabled={isUploadingAvatar}
            className="group focus-visible:ring-ring relative shrink-0 cursor-pointer overflow-hidden rounded-md focus-visible:ring-2 focus-visible:outline-none"
            aria-label="Upload profile picture"
          >
            <Avatar className="border-border size-14 border">
              <AvatarImage src={avatarPreview || avatarUrl} alt={userName} />
              <AvatarFallback className="bg-muted text-sm font-medium">
                {getInitials(userName)}
              </AvatarFallback>
            </Avatar>
            {isUploadingAvatar ? (
              <span className="bg-foreground/20 absolute inset-0 flex items-center justify-center">
                <KortixLoader size="small" variant="white" />
              </span>
            ) : (
              <span
                className={cn(
                  'bg-foreground/20 duration-normal absolute inset-0 opacity-0 transition-opacity ease-out',
                  'group-hover:opacity-100 group-focus-visible:opacity-100',
                )}
                aria-hidden
              />
            )}
          </button>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onOpenFilePicker}
                disabled={isUploadingAvatar}
              >
                Upload
              </Button>
              {avatarUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRemoveAvatar}
                  disabled={isUploadingAvatar || isRemovingAvatar}
                >
                  {isRemovingAvatar ? <Loading className="size-3.5 shrink-0" /> : null}
                  Remove
                </Button>
              ) : null}
            </div>
            <p className="text-muted-foreground text-xs">JPG, PNG, or GIF. Max 5MB.</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onAvatarFileChange}
            className="hidden"
          />
        </div>
      </section>

      {/* 2. Name */}
      <section className="space-y-3">
        <SettingsSectionHeader title="Name" description="Your display name across Kortix." />
        <div className="flex items-center gap-2">
          <Input
            type="text"
            id="profile-name"
            value={nameDraft}
            onChange={(e) => onNameDraftChange(e.target.value)}
            placeholder="Your name"
            className="max-w-xs"
          />
          {isNameDirty ? (
            <Button type="button" size="sm" onClick={onSaveName} disabled={isSavingName}>
              {isSavingName ? <Loading className="size-3.5 shrink-0" /> : null}
              Save
            </Button>
          ) : null}
        </div>
      </section>

      {/* 3. Email */}
      <section className="space-y-3">
        <SettingsSectionHeader title="Email" description="Used to sign in — cannot be changed here." />
        <Input type="text" id="profile-email" value={userEmail} readOnly className="max-w-xs" />
      </section>

      {/* 4. Two-factor authentication */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <SettingsSectionHeader
            title="Two-factor authentication"
            description="Add an authenticator app (TOTP) as a second factor."
            className="flex-1"
          />
          {verified.length > 0 && (
            <span
              className={cn(
                'mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                sessionVerified ? 'bg-kortix-green/15 text-kortix-green' : 'text-muted-foreground border',
              )}
            >
              <ShieldCheck className="size-3.5" />
              {sessionVerified ? 'Session verified' : 'Enrolled'}
            </span>
          )}
        </div>

        {factorsLoading ? (
          <Skeleton className="h-14 w-full" />
        ) : (
          <div className="space-y-2">
            {factors.length === 0 && !enrolling && (
              <InfoBanner tone="info" title="No second factor enrolled">
                Add an authenticator app so you can step up when a workspace requires MFA.
              </InfoBanner>
            )}
            {factors.map((f) => (
              <FactorRow key={f.id} factor={f} onRemove={onRequestRemoveFactor} />
            ))}
          </div>
        )}

        {enrolling ? (
          <div className="border-border/60 bg-popover space-y-4 rounded-md border p-4">
            <div>
              <h4 className="text-foreground text-sm font-medium">Scan with your authenticator app</h4>
              <p className="text-muted-foreground mt-1 text-xs">
                Use 1Password, Google Authenticator, or any TOTP app — then enter the 6-digit code it
                shows.
              </p>
            </div>
            <div className="flex items-start gap-4">
              {/* biome-ignore lint/performance/noImgElement: QR is an inline SVG data URL, next/image adds nothing */}
              <img
                src={totpQrSrc(enrolling.qr)}
                alt="TOTP enrollment QR code"
                className="border-border/60 size-36 shrink-0 rounded-md border bg-white p-2"
              />
              <div className="min-w-0 flex-1 space-y-3">
                {enrolling.secret && (
                  <div className="space-y-1">
                    <Label className="text-xs">Manual entry secret</Label>
                    <code className="border-border/60 bg-muted/30 block truncate rounded border px-2 py-1.5 font-mono text-xs">
                      {enrolling.secret}
                    </code>
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs">6-digit code</Label>
                  <Input
                    value={enrollCode}
                    onChange={(e) => onEnrollCodeChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="w-32 font-mono tracking-widest"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={onVerifyEnroll}
                    disabled={enrollCode.length !== 6 || isVerifyingEnroll}
                    className="gap-1.5"
                  >
                    {isVerifyingEnroll && <Loading className="size-4" />}
                    Verify and enable
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onCancelEnroll}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={onStartEnroll} disabled={isStartingEnroll} className="gap-1.5">
            {isStartingEnroll ? <Loading className="size-4" /> : <Plus className="size-4" />}
            Add authenticator app
          </Button>
        )}

        <ConfirmDialog
          open={removeFactorTarget !== null}
          onOpenChange={(open) => !open && onCancelRemoveFactor()}
          title="Remove this factor?"
          description="If your organization requires MFA and this is your only verified factor, you will be locked out of gated actions until you enroll again."
          confirmLabel="Remove factor"
          confirmVariant="destructive"
          onConfirm={onConfirmRemoveFactor}
          isPending={isRemovingFactor}
        />
      </section>

      {/* 5. Delete account */}
      <section className="space-y-3">
        <SettingsSectionHeader
          title="Delete account"
          description="Permanently remove your account and everything it owns."
        />
        {!accountDeletionSupported ? (
          <p className="text-muted-foreground text-xs">
            Account deletion isn&apos;t available on this deployment. Contact support to close your
            account.
          </p>
        ) : hasPendingDeletion ? (
          <InfoBanner tone="warning">
            <div className="flex flex-col gap-2">
              <p className="font-medium">
                {deletionScheduledForLabel
                  ? `Your account is scheduled for deletion on ${deletionScheduledForLabel}.`
                  : 'Your account is scheduled for deletion.'}{' '}
                You can cancel any time before then.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenCancelDeletionDialog}
                disabled={isCancelingDeletion}
                className="w-fit"
              >
                Keep my account
              </Button>
            </div>
          </InfoBanner>
        ) : (
          <div className="bg-popover flex items-center justify-between gap-4 rounded-md border px-4 py-3">
            <p className="text-muted-foreground min-w-0 text-xs">
              This deletes every agent, thread, credential, and subscription tied to your account. This
              cannot be undone.
            </p>
            <Button variant="destructive" size="sm" onClick={onOpenDeleteDialog} className="shrink-0">
              Delete account
            </Button>
          </div>
        )}

        {accountDeletionSupported && (
          <>
            <Modal
              open={showDeleteDialog}
              onOpenChange={(open) => !open && onCloseDeleteDialog()}
            >
              <ModalContent className="lg:max-w-md" variant="base">
                <ModalHeader>
                  <ModalTitle>Delete your account?</ModalTitle>
                </ModalHeader>
                <ModalBody className="space-y-4">
                  <InfoBanner tone="warning">
                    {deletionType === 'immediate'
                      ? 'This deletes your account right away. There is no grace period and no way to undo it.'
                      : 'Your account is scheduled for deletion after a 30-day grace period, during which you can cancel.'}
                  </InfoBanner>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">When your account is deleted:</p>
                    <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-sm">
                      <li>Every agent you own is deleted</li>
                      <li>Every thread and message is deleted</li>
                      <li>Every credential and secret is removed</li>
                      <li>Your subscription is cancelled</li>
                      <li>Your billing history is removed</li>
                    </ul>
                  </div>
                  <div className="space-y-3">
                    <Label className="text-sm">Choose when</Label>
                    <RadioGroup
                      value={deletionType}
                      onValueChange={(value) => onDeletionTypeChange(value as DeletionType)}
                    >
                      <RadioGroupItem
                        value="grace-period"
                        id="profile-grace-period"
                        label="30-day grace period"
                        description="Deletion happens automatically after 30 days. Cancel any time before then."
                        size="lg"
                        variant="outline"
                      />
                      <RadioGroupItem
                        value="immediate"
                        id="profile-immediate"
                        label="Delete immediately"
                        description="Your account and its data are deleted right away. This cannot be undone."
                        size="lg"
                        variant="outline"
                      />
                    </RadioGroup>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profile-delete-confirm" className="text-sm">
                      Type &quot;delete&quot; to confirm
                    </Label>
                    <Input
                      type="text"
                      id="profile-delete-confirm"
                      value={deleteConfirmText}
                      onChange={(e) => onDeleteConfirmTextChange(e.target.value)}
                      placeholder="delete"
                      autoComplete="off"
                    />
                  </div>
                </ModalBody>
                <ModalFooter className="w-full sm:justify-between">
                  <Button variant="outline-ghost" onClick={onCloseDeleteDialog} className="w-full sm:w-auto">
                    Keep account
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={onConfirmDelete}
                    disabled={isDeletingAccount || deleteConfirmText !== 'delete'}
                    className="w-full sm:w-auto"
                  >
                    {isDeletingAccount ? 'Processing…' : 'Delete account'}
                  </Button>
                </ModalFooter>
              </ModalContent>
            </Modal>

            <ConfirmDialog
              open={showCancelDeletionDialog}
              onOpenChange={(open) => !open && onCloseCancelDeletionDialog()}
              title="Keep your account?"
              description="This cancels the scheduled deletion. Your account and its data stay exactly as they are."
              confirmLabel="Keep my account"
              onConfirm={onConfirmCancelDeletion}
              isPending={isCancelingDeletion}
            />
          </>
        )}
      </section>
    </div>
  );
}

/** Container: owns every hook (React Query, Supabase, refs) and renders
 *  `ProfileTabView` with real data + handlers. Only ever mounted while this
 *  tab is active (`SettingsTabPane` in `settings-panel.tsx` returns `null`
 *  otherwise), so nothing here fetches on panel open. */
export function ProfileTab() {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Profile (name, email, avatar) ---------------------------------
  const profileQuery = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      return {
        name: data.user?.user_metadata?.name || data.user?.email?.split('@')[0] || '',
        email: data.user?.email || '',
        avatarUrl: data.user?.user_metadata?.avatar_url || '',
      };
    },
    staleTime: 10_000,
  });

  const [nameDraft, setNameDraft] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  // Sync the draft from the loaded name during render, not an effect — this
  // is React's documented pattern for "adjust state when an input changes"
  // (react.dev/learn/you-might-not-need-an-effect#adjusting-state-based-on-a-prop-or-state-change).
  // Calling setState here bails out the in-progress render and re-runs
  // immediately, before the browser paints, so it never flashes the stale
  // draft. `nameTouched` guards it so the user's in-progress edit is never
  // clobbered by a background refetch of the same query.
  const [loadedName, setLoadedName] = useState<string | null>(null);
  if (profileQuery.data && !nameTouched && profileQuery.data.name !== loadedName) {
    setLoadedName(profileQuery.data.name);
    setNameDraft(profileQuery.data.name);
  }

  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const avatarPreviewRef = useRef<string | null>(null);
  useEffect(() => {
    avatarPreviewRef.current = avatarPreview;
  }, [avatarPreview]);
  // See general-tab.tsx's identical effect: revoke whatever preview blob is
  // current on unmount (closing the panel mid-upload), not one captured once.
  useEffect(() => {
    return () => {
      if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
    };
  }, []);

  const saveNameMutation = useMutation({
    mutationFn: async (name: string) => {
      const { error } = await supabase.auth.updateUser({ data: { name } });
      if (error) throw error;
    },
    onSuccess: () => {
      setNameTouched(false);
      successToast('Name updated');
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
    onError: (error: Error) => errorToast(error.message || 'Could not update name'),
  });

  const uploadAvatarMutation = useMutation({
    mutationFn: async (file: File) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error('User not found');
      const fileExt = (file.name.split('.').pop() || 'png').toLowerCase();
      const filePath = `${userId}/${Date.now()}.${fileExt}`;
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { cacheControl: '3600', upsert: true });
      if (uploadError) throw uploadError;
      const {
        data: { publicUrl },
      } = supabase.storage.from('avatars').getPublicUrl(filePath);
      const { error } = await supabase.auth.updateUser({ data: { avatar_url: publicUrl } });
      if (error) throw error;
      return publicUrl;
    },
    onSuccess: () => {
      if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
      setAvatarPreview(null);
      successToast('Profile picture updated');
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
    onError: (error: Error) => {
      if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
      setAvatarPreview(null);
      errorToast(error.message || 'Could not upload profile picture');
    },
  });

  const removeAvatarMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ data: { avatar_url: '' } });
      if (error) throw error;
    },
    onSuccess: () => {
      successToast('Profile picture removed');
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
    onError: (error: Error) => errorToast(error.message || 'Could not remove profile picture'),
  });

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice in a row still fires this handler.
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      errorToast('Please choose an image file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      errorToast('Image must be smaller than 5MB');
      return;
    }
    if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
    setAvatarPreview(URL.createObjectURL(file));
    uploadAvatarMutation.mutate(file);
  };

  // --- Two-factor authentication --------------------------------------
  const factorsQuery = useQuery({
    queryKey: MFA_FACTORS_QUERY_KEY,
    queryFn: () => supabaseMFAService.listFactors(),
    staleTime: 10_000,
  });
  const aalQuery = useQuery({
    queryKey: MFA_AAL_QUERY_KEY,
    queryFn: () => supabaseMFAService.getAAL(),
    staleTime: 10_000,
  });

  const [enrolling, setEnrolling] = useState<EnrollingFactor | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [removeFactorTarget, setRemoveFactorTarget] = useState<string | null>(null);

  const startEnrollMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Authenticator (${new Date().toISOString().slice(0, 10)})`,
      });
      if (error) throw new Error(error.message);
      if (!data?.totp?.qr_code) throw new Error('Enrollment returned no QR code');
      return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
    },
    onSuccess: (data) => {
      setEnrolling(data);
      setEnrollCode('');
    },
    onError: (error: Error) => errorToast(error.message || 'Could not start enrollment'),
  });

  const removeFactorMutation = useMutation({
    mutationFn: (factorId: string) => supabaseMFAService.unenrollFactor(factorId),
    onSuccess: () => {
      successToast('Factor removed');
      setRemoveFactorTarget(null);
      queryClient.invalidateQueries({ queryKey: MFA_FACTORS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MFA_AAL_QUERY_KEY });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to remove factor'),
  });

  const verifyEnrollMutation = useMutation({
    mutationFn: async () => {
      if (!enrolling) throw new Error('No enrollment in progress');
      await supabaseMFAService.challengeAndVerify({ factor_id: enrolling.factorId, code: enrollCode });
    },
    onSuccess: () => {
      invalidateTokenCache();
      successToast('Authenticator enrolled — this session is now MFA-verified');
      setEnrolling(null);
      setEnrollCode('');
      queryClient.invalidateQueries();
    },
    onError: (error: Error) => errorToast(error.message || 'Code did not verify'),
  });

  const handleCancelEnroll = () => {
    // Abandoning enrollment leaves an unverified factor behind — clean it up.
    if (enrolling) removeFactorMutation.mutate(enrolling.factorId);
    setEnrolling(null);
  };

  // --- Delete account ---------------------------------------------------
  const { data: deletionStatus, isLoading: isCheckingDeletionStatus } = useAccountDeletionStatus();
  const requestDeletion = useRequestAccountDeletion();
  const cancelDeletion = useCancelAccountDeletion();
  const deleteImmediately = useDeleteAccountImmediately();
  const accountDeletionSupported =
    isBillingEnabled() && (deletionStatus?.supported ?? !isCheckingDeletionStatus);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCancelDeletionDialog, setShowCancelDeletionDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletionType, setDeletionType] = useState<DeletionType>('grace-period');

  const closeDeleteDialog = () => {
    setShowDeleteDialog(false);
    setDeleteConfirmText('');
    setDeletionType('grace-period');
  };

  const handleConfirmDelete = async () => {
    try {
      if (deletionType === 'immediate') {
        await deleteImmediately.mutateAsync();
      } else {
        await requestDeletion.mutateAsync('User requested deletion');
      }
      closeDeleteDialog();
    } catch {
      // Mutation onError already shows the user-facing message.
    }
  };

  const handleConfirmCancelDeletion = async () => {
    try {
      await cancelDeletion.mutateAsync();
      setShowCancelDeletionDialog(false);
    } catch {
      // Mutation onError already shows the user-facing message.
    }
  };

  const formatDate = (dateString: string | null | undefined): string | null => {
    if (!dateString) return null;
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <ProfileTabView
      userName={profileQuery.data?.name ?? ''}
      avatarUrl={profileQuery.data?.avatarUrl ?? ''}
      avatarPreview={avatarPreview}
      isUploadingAvatar={uploadAvatarMutation.isPending}
      fileInputRef={fileInputRef}
      onOpenFilePicker={() => fileInputRef.current?.click()}
      onAvatarFileChange={handleAvatarFileChange}
      onRemoveAvatar={() => removeAvatarMutation.mutate()}
      isRemovingAvatar={removeAvatarMutation.isPending}
      nameDraft={nameDraft}
      onNameDraftChange={(value) => {
        setNameTouched(true);
        setNameDraft(value);
      }}
      isNameDirty={nameTouched && nameDraft !== (profileQuery.data?.name ?? '')}
      isSavingName={saveNameMutation.isPending}
      onSaveName={() => saveNameMutation.mutate(nameDraft)}
      userEmail={profileQuery.data?.email ?? ''}
      factors={factorsQuery.data?.factors ?? []}
      factorsLoading={factorsQuery.isLoading}
      sessionVerified={aalQuery.data?.current_level === 'aal2'}
      removeFactorTarget={removeFactorTarget}
      onRequestRemoveFactor={setRemoveFactorTarget}
      onCancelRemoveFactor={() => setRemoveFactorTarget(null)}
      onConfirmRemoveFactor={() => removeFactorTarget && removeFactorMutation.mutate(removeFactorTarget)}
      isRemovingFactor={removeFactorMutation.isPending}
      enrolling={enrolling}
      enrollCode={enrollCode}
      onEnrollCodeChange={setEnrollCode}
      onStartEnroll={() => startEnrollMutation.mutate()}
      isStartingEnroll={startEnrollMutation.isPending}
      onVerifyEnroll={() => verifyEnrollMutation.mutate()}
      isVerifyingEnroll={verifyEnrollMutation.isPending}
      onCancelEnroll={handleCancelEnroll}
      accountDeletionSupported={accountDeletionSupported}
      hasPendingDeletion={deletionStatus?.has_pending_deletion ?? false}
      deletionScheduledForLabel={formatDate(deletionStatus?.deletion_scheduled_for)}
      showDeleteDialog={showDeleteDialog}
      onOpenDeleteDialog={() => setShowDeleteDialog(true)}
      onCloseDeleteDialog={closeDeleteDialog}
      deletionType={deletionType}
      onDeletionTypeChange={setDeletionType}
      deleteConfirmText={deleteConfirmText}
      onDeleteConfirmTextChange={setDeleteConfirmText}
      onConfirmDelete={handleConfirmDelete}
      isDeletingAccount={requestDeletion.isPending || deleteImmediately.isPending}
      showCancelDeletionDialog={showCancelDeletionDialog}
      onOpenCancelDeletionDialog={() => setShowCancelDeletionDialog(true)}
      onCloseCancelDeletionDialog={() => setShowCancelDeletionDialog(false)}
      onConfirmCancelDeletion={handleConfirmCancelDeletion}
      isCancelingDeletion={cancelDeletion.isPending}
    />
  );
}
