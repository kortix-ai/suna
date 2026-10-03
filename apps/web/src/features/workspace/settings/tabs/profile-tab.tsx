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
 *   confirmation dialog behind it is unchanged — only the trigger's weight is.
 *   The dialog itself is shared with the account hub's danger zone
 *   (`components/account/delete-account-dialogs.tsx`).
 * - The unavailable case (no account deletion on this deployment) shows muted
 *   text on the right instead of swapping the row out for a paragraph.
 *
 * The factor list answers in four states and each one is visible: loading
 * (skeleton row), failed (red `InfoBanner` + Retry), empty (orange "No second
 * factor enrolled" nudge), and populated (`FactorRow`s). A failed fetch never
 * borrows the empty-state copy — that copy asserts the account has no second
 * factor, which a failed fetch cannot know.
 *
 * Ported from the deleted `features/accounts/settings/general-tab.tsx` (avatar upload,
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
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CancelAccountDeletionDialog,
  DeleteAccountDialog,
  formatDeletionDate,
} from '@/components/account/delete-account-dialogs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAccountDeletionStatus } from '@/hooks/account/use-account-deletion';
import { isBillingEnabled } from '@/lib/config';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { SettingsTabHeader } from '../settings-tab-header';
import {
  type AccountMembership,
  type AccountMembershipsCopy,
  AccountMembershipsSection,
  useAccountMemberships,
} from './account-memberships';

const PROFILE_QUERY_KEY = ['account', 'profile'] as const;

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

export interface ProfileTabCopy {
  profilePicture: string;
  profilePictureDescription: string;
  remove: string;
  uploadProfilePicture: string;
  email: string;
  emailDescription: string;
  name: string;
  nameDescription: string;
  namePlaceholder: string;
  save: string;
  organizations: AccountMembershipsCopy;
  dangerZone: string;
  deleteAccount: string;
  deletionUnavailable: string;
  scheduledForDeletionOn: string;
  scheduledForDeletion: string;
  cancelBeforeDeletion: string;
  deletionDescription: string;
  unavailable: string;
  keepMyAccount: string;
}

export const DEFAULT_PROFILE_TAB_COPY: ProfileTabCopy = {
  profilePicture: 'Profile picture',
  profilePictureDescription: 'JPG, PNG, or GIF. Max 5MB.',
  remove: 'Remove',
  uploadProfilePicture: 'Upload profile picture',
  email: 'Email',
  emailDescription: 'Used to sign in — cannot be changed here.',
  name: 'Name',
  nameDescription: 'Your display name across Kortix.',
  namePlaceholder: 'Your name',
  save: 'Save',
  organizations: {
    title: 'Organizations',
    description: "Members, billing, roles, and audit live in each organization's own settings.",
    fallbackAccountName: 'Account',
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
    manage: 'Manage',
  },
  dangerZone: 'Danger zone',
  deleteAccount: 'Delete account',
  deletionUnavailable:
    "Account deletion isn't available on this deployment. Contact support to close your account.",
  scheduledForDeletionOn: 'Scheduled for deletion on {date}.',
  scheduledForDeletion: 'Scheduled for deletion.',
  cancelBeforeDeletion: 'You can cancel any time before then.',
  deletionDescription:
    'This deletes every agent, thread, credential, and subscription tied to your account. This cannot be undone.',
  unavailable: 'Unavailable',
  keepMyAccount: 'Keep my account',
};

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
  onOpenDeleteDialog?: () => void;
  onOpenCancelDeletionDialog?: () => void;
  copy?: Partial<Omit<ProfileTabCopy, 'organizations'>> & {
    organizations?: Partial<AccountMembershipsCopy>;
  };
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
  onOpenDeleteDialog = () => {},
  onOpenCancelDeletionDialog = () => {},
  copy: copyOverrides = {},
}: ProfileTabViewProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const copy: ProfileTabCopy = {
    ...DEFAULT_PROFILE_TAB_COPY,
    ...copyOverrides,
    organizations: {
      ...DEFAULT_PROFILE_TAB_COPY.organizations,
      ...copyOverrides.organizations,
    },
  };
  // The right-hand control of the Delete-account row, and the line under its
  // label. Three states, one row — an unavailable or already-scheduled
  // deletion changes what the row SAYS and what its control DOES, not which
  // shape the pane is in. Before this, each state replaced the row with a
  // paragraph or a banner, so the pane's last block moved as the state
  // changed. Every gate is unchanged: `accountDeletionSupported` is still the
  // only thing that decides whether a delete is offered at all.
  const deleteAccountDescription = !accountDeletionSupported
    ? copy.deletionUnavailable
    : hasPendingDeletion
      ? `${
          deletionScheduledForLabel
            ? copy.scheduledForDeletionOn.replace('{date}', deletionScheduledForLabel)
            : copy.scheduledForDeletion
        } ${copy.cancelBeforeDeletion}`
      : copy.deletionDescription;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="profile" />

      {/* Profile picture, email, name — one group, one border, hairlines
          between. */}
      <SettingsRowGroup>
        <SettingsRow
          className="group/settings-row"
          label={copy.profilePicture}
          description={copy.profilePictureDescription}
        >
          {avatarUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemoveAvatar}
              disabled={isUploadingAvatar || isRemovingAvatar}
              className="duration-normal opacity-0 transition-opacity ease-out group-hover/settings-row:opacity-100"
            >
              {isRemovingAvatar ? <Loading className="size-3.5 shrink-0" /> : null}
              {copy.remove}
            </Button>
          ) : null}

          <button
            type="button"
            onClick={onOpenFilePicker}
            disabled={isUploadingAvatar}
            className="group focus-visible:ring-ring duration-normal relative shrink-0 cursor-pointer overflow-hidden rounded-md transition-[scale] ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]"
            aria-label={copy.uploadProfilePicture}
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

        <SettingsRow label={copy.email} description={copy.emailDescription}>
          <span className="text-muted-foreground my-auto truncate text-sm">{userEmail}</span>
        </SettingsRow>

        <SettingsRow label={copy.name} description={copy.nameDescription}>
          <Input
            type="text"
            id="profile-name"
            // The row label is a heading, not a `<label htmlFor>` — the
            // control carries its own accessible name.
            aria-label={copy.name}
            value={nameDraft}
            onChange={(e) => onNameDraftChange(e.target.value)}
            placeholder={copy.namePlaceholder}
            className="h-8 w-56"
          />
          {isNameDirty ? (
            <Button type="button" size="sm" onClick={onSaveName} disabled={isSavingName}>
              {isSavingName ? <Loading className="size-3.5 shrink-0" /> : null}
              {copy.save}
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsRowGroup>

      {/* Organizations — directly under the identity group, because it
          answers the same question those rows do ("who am I here") and because
          Jay asked for it to be EASY to reach: no scrolling, no tab to find
          first. `account-memberships.tsx` carries the full rationale. */}
      <AccountMembershipsSection
        accounts={accounts}
        isLoading={accountsLoading}
        copy={copy.organizations}
      />

      {/* Danger zone */}
      <section className="space-y-3">
        <SettingsSubsectionHeader title={copy.dangerZone} />
        <SettingsRowGroup>
          <SettingsRow label={copy.deleteAccount} description={deleteAccountDescription}>
            {!accountDeletionSupported ? (
              <span className="text-muted-foreground text-sm">{copy.unavailable}</span>
            ) : hasPendingDeletion ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onOpenCancelDeletionDialog}
              >
                {copy.keepMyAccount}
              </Button>
            ) : (
              /* Red text, not a filled button: the weight belongs to the
                 confirmation inside the modal, not to the affordance that
                 opens it. Same trigger as `general-tab.tsx`'s Delete
                 workspace. The modal itself is the shared
                 `DeleteAccountDialog` — the container mounts it. */
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onOpenDeleteDialog}
              >
                {copy.deleteAccount}
              </Button>
            )}
          </SettingsRow>
        </SettingsRowGroup>
      </section>
    </div>
  );
}

/** Container: owns every hook (React Query, Supabase, refs) and renders
 *  `ProfileTabView` with real data + handlers. Only ever mounted while this
 *  tab is active (`SettingsTabPane` in `settings-panel.tsx` returns `null`
 *  otherwise), so nothing here fetches on panel open. */
export function ProfileTab() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.profile');
  const locale = useLocale();
  const copy = useMemo<ProfileTabCopy>(
    () => ({
      profilePicture: t('profilePicture'),
      profilePictureDescription: t('profilePictureDescription'),
      remove: t('remove'),
      uploadProfilePicture: t('uploadProfilePicture'),
      email: t('email'),
      emailDescription: t('emailDescription'),
      name: t('name'),
      nameDescription: t('nameDescription'),
      namePlaceholder: t('namePlaceholder'),
      save: t('save'),
      organizations: {
        title: t('organizations.title'),
        description: t('organizations.description'),
        fallbackAccountName: t('organizations.fallbackAccountName'),
        owner: t('organizations.owner'),
        admin: t('organizations.admin'),
        member: t('organizations.member'),
        manage: t('organizations.manage'),
      },
      dangerZone: t('dangerZone'),
      deleteAccount: t('deleteAccount'),
      deletionUnavailable: t('deletionUnavailable'),
      scheduledForDeletionOn: t.raw('scheduledForDeletionOn'),
      scheduledForDeletion: t('scheduledForDeletion'),
      cancelBeforeDeletion: t('cancelBeforeDeletion'),
      deletionDescription: t('deletionDescription'),
      unavailable: t('unavailable'),
      keepMyAccount: t('keepMyAccount'),
    }),
    [t],
  );
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
  // On unmount (for example, the panel closes mid-upload), revoke the preview
  // blob URL that is current at that moment. The ref tracks every new preview,
  // so the cleanup never revokes a stale URL captured when the effect ran.
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
      successToast(tI18nComplete('text84cbdb460e07'));
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
    onError: (error: Error) =>
      errorToast(error.message || tI18nComplete('textafee7aaea8e6')),
  });

  const uploadAvatarMutation = useMutation({
    mutationFn: async (file: File) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error(t('toasts.userNotFound'));
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
      successToast(tI18nComplete('text5f2e85f50ed3'));
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
    onError: (error: Error) => {
      if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
      setAvatarPreview(null);
      errorToast(error.message || tI18nComplete('text1a495c868b6b'));
    },
  });

  const removeAvatarMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ data: { avatar_url: '' } });
      if (error) throw error;
    },
    onSuccess: () => {
      successToast(tI18nComplete('text2fd3b5709d0d'));
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
    onError: (error: Error) =>
      errorToast(error.message || tI18nComplete('texta505da26f529')),
  });

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice in a row still fires this handler.
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      errorToast(tI18nComplete('text389e4355c524'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      errorToast(tI18nComplete('textacfd3b07ddc7'));
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
  // The row is state + trigger only; the dialogs themselves (and every
  // mutation behind them) are the shared `DeleteAccountDialog` /
  // `CancelAccountDeletionDialog`, mounted below the view.
  const { data: deletionStatus, isLoading: isCheckingDeletionStatus } = useAccountDeletionStatus();
  const accountDeletionSupported =
    isBillingEnabled() && (deletionStatus?.supported ?? !isCheckingDeletionStatus);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCancelDeletionDialog, setShowCancelDeletionDialog] = useState(false);

  const formatDate = (dateString: string | null | undefined): string | null =>
    formatDeletionDate(dateString, locale);

  return (
    <>
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
      onOpenDeleteDialog={() => setShowDeleteDialog(true)}
      onOpenCancelDeletionDialog={() => setShowCancelDeletionDialog(true)}
      copy={copy}
    />

      {/* The dialogs are portals — their DOM position is irrelevant, so the
          hook-free view above stays the only thing under
          `renderToStaticMarkup`. */}
      <DeleteAccountDialog
        open={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
      />
      <CancelAccountDeletionDialog
        open={showCancelDeletionDialog}
        onClose={() => setShowCancelDeletionDialog(false)}
      />
    </>
  );
}
