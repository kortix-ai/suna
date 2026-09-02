'use client';

/**
 * The Profile tab — profile picture, email, display name, the organizations
 * you belong to, and account deletion.
 *
 * Two-factor authentication left for its own Security tab on 2026-09-02
 * (`security-tab.tsx`, with `FactorRow` and `totpQrSrc`): "who am I" and "how
 * is that protected" are different questions.
 *
 * **Layout: Linear's settings shape** (Jay's reference, 2026-08-11). The pane
 * opens on its heading and a hairline rule, then rows: label on the left, its
 * control on the right, consecutive rows sharing ONE bordered box separated by
 * hairlines — `SettingsRowGroup` / `SettingsRow`
 * (`components/ui/settings-row.tsx`, whose header explains the rationale).
 * Sections between groups are a plain small label, not a card header. Three
 * consequences worth naming, because each replaced something that used to be
 * here:
 * - Email is plain right-aligned muted text, not a `readOnly` `<Input>`. A
 *   disabled-looking text box invites a click that does nothing; a value that
 *   is not editable should not be dressed as a field.
 * - Delete account is red TEXT, not a filled destructive button. The
 *   `ConfirmDialog` behind it is unchanged — only the trigger's weight is.
 * - The unavailable case (no account deletion on this deployment) shows muted
 *   text on the right instead of swapping the row out for a paragraph.
 *
 * The factor list answers in four states and each one is visible: loading
 * (skeleton row), failed (red `InfoBanner` + Retry), empty (orange "No second
 * factor enrolled" nudge), and populated (`FactorRow`s). A failed fetch never
 * borrows the empty-state copy — that copy asserts the account has no second
 * factor, which a failed fetch cannot know.
 *
 * Ported from `features/accounts/settings/general-tab.tsx` (avatar upload,
 * name save, account deletion) and `features/accounts/settings/
 * security-tab.tsx` (MFA factor list and TOTP enrollment). Task 10 deleted
 * `security-tab.tsx` and the legacy user-settings modal that consumed it: the MFA
 * query/mutation orchestration that both files had duplicated now lives in
 * `hooks/account/use-mfa.ts` (see that file's header for the before/after
 * diff), and `FactorRow` / `totpQrSrc` — the pure view pieces `security-
 * tab.tsx` exported — moved down into this file, since this is their only
 * remaining consumer.
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
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useAccountDeletionStatus,
  useCancelAccountDeletion,
  useDeleteAccountImmediately,
  useRequestAccountDeletion,
} from '@/hooks/account/use-account-deletion';
import { isBillingEnabled } from '@/lib/config';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { SettingsTabHeader } from '../settings-tab-header';
import {
  type AccountMembership,
  AccountMembershipsSection,
  useAccountMemberships,
} from './account-memberships';

const PROFILE_QUERY_KEY = ['account', 'profile'] as const;

const deletionDateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

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

  // Organizations — every account this user is a member of. See
  // `account-memberships.tsx` for why the list lives on this tab.
  accounts?: readonly AccountMembership[];
  accountsLoading?: boolean;

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
  accounts = [],
  accountsLoading = false,
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
  // The right-hand control of the Delete-account row, and the line under its
  // label. Three states, one row — an unavailable or already-scheduled
  // deletion changes what the row SAYS and what its control DOES, not which
  // shape the pane is in. Before this, each state replaced the row with a
  // paragraph or a banner, so the pane's last block moved as the state
  // changed. Every gate is unchanged: `accountDeletionSupported` is still the
  // only thing that decides whether a delete is offered at all.
  const deleteAccountDescription = !accountDeletionSupported
    ? "Account deletion isn't available on this deployment. Contact support to close your account."
    : hasPendingDeletion
      ? `${
          deletionScheduledForLabel
            ? `Scheduled for deletion on ${deletionScheduledForLabel}.`
            : 'Scheduled for deletion.'
        } You can cancel any time before then.`
      : 'This deletes every agent, thread, credential, and subscription tied to your account. This cannot be undone.';

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="profile" />

      {/* Profile picture, email, name — one group, one border, hairlines
          between. */}
      <SettingsRowGroup>
        <SettingsRow
          className="group/settings-row"
          label="Profile picture"
          description="JPG, PNG, or GIF. Max 5MB."
        >
          {avatarUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemoveAvatar}
              disabled={isUploadingAvatar || isRemovingAvatar}
              className="opacity-0 transition-opacity duration-150 ease-out group-hover/settings-row:opacity-100"
            >
              {isRemovingAvatar ? <Loading className="size-3.5 shrink-0" /> : null}
              Remove
            </Button>
          ) : null}

          <button
            type="button"
            onClick={onOpenFilePicker}
            disabled={isUploadingAvatar}
            className="group focus-visible:ring-ring relative shrink-0 cursor-pointer overflow-hidden rounded-md transition-[scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]"
            aria-label="Upload profile picture"
          >
            <Avatar className="border-border size-9 border">
              <AvatarImage src={avatarPreview || avatarUrl} alt={userName} />
              <AvatarFallback className="bg-muted text-xs font-medium">
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
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onAvatarFileChange}
            className="hidden"
          />
        </SettingsRow>

        <SettingsRow label="Email" description="Used to sign in — cannot be changed here.">
          <span className="text-muted-foreground my-auto truncate text-sm">{userEmail}</span>
        </SettingsRow>

        <SettingsRow label="Name" description="Your display name across Kortix.">
          <Input
            type="text"
            id="profile-name"
            // The row label is a heading, not a `<label htmlFor>` — the
            // control carries its own accessible name.
            aria-label="Name"
            value={nameDraft}
            onChange={(e) => onNameDraftChange(e.target.value)}
            placeholder="Your name"
            className="h-8 w-56"
          />
          {isNameDirty ? (
            <Button type="button" size="sm" onClick={onSaveName} disabled={isSavingName}>
              {isSavingName ? <Loading className="size-3.5 shrink-0" /> : null}
              Save
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsRowGroup>

      {/* Organizations — directly under the identity group, because it
          answers the same question those rows do ("who am I here") and because
          Jay asked for it to be EASY to reach: no scrolling, no tab to find
          first. `account-memberships.tsx` carries the full rationale. */}
      <AccountMembershipsSection accounts={accounts} isLoading={accountsLoading} />

      {/* Danger zone */}
      <section className="space-y-3">
        <SettingsSubsectionHeader title="Danger zone" />
        <SettingsRowGroup>
          <SettingsRow label="Delete account" description={deleteAccountDescription}>
            {!accountDeletionSupported ? (
              <span className="text-muted-foreground text-sm">Unavailable</span>
            ) : hasPendingDeletion ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onOpenCancelDeletionDialog}
                disabled={isCancelingDeletion}
              >
                Keep my account
              </Button>
            ) : (
              /* Red text, not a filled button: the weight belongs to the
                 confirmation inside the modal, not to the affordance that
                 opens it. Same trigger as `general-tab.tsx`'s Delete
                 workspace. */
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onOpenDeleteDialog}
              >
                Delete account
              </Button>
            )}
          </SettingsRow>
        </SettingsRowGroup>

        {accountDeletionSupported && (
          <>
            <Modal open={showDeleteDialog} onOpenChange={(open) => !open && onCloseDeleteDialog()}>
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
                  <Button
                    variant="outline-ghost"
                    onClick={onCloseDeleteDialog}
                    className="w-full sm:w-auto"
                  >
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

  // --- Organizations ----------------------------------------------------
  // Same account-list entry `WorkspaceSwitcher` already primed on mount, so
  // this costs no extra request inside a project shell.
  const { accounts, isLoading: accountsLoading } = useAccountMemberships();

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
    return deletionDateFormat.format(new Date(dateString));
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
      accounts={accounts}
      accountsLoading={accountsLoading}
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
