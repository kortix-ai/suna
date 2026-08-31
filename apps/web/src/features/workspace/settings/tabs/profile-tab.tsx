'use client';

/**
 * The Profile tab — profile picture, email, display name, two-factor
 * authentication, and account deletion.
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

import {
  KeyIcon as KeyRound,
  PlusIcon as Plus,
  ShieldCheckIcon as ShieldCheck,
  ShieldWarningIcon as ShieldWarning,
  DeviceMobileIcon as Smartphone,
  TrashIcon as Trash2,
  WarningIcon as Warning,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useAccountDeletionStatus,
  useCancelAccountDeletion,
  useDeleteAccountImmediately,
  useRequestAccountDeletion,
} from '@/hooks/account/use-account-deletion';
import { type EnrollingFactor, useMfa } from '@/hooks/account/use-mfa';
import { isBillingEnabled } from '@/lib/config';
import { createClient } from '@/lib/supabase/client';
import type { FactorInfo } from '@/lib/supabase/mfa';
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

/** Supabase hands the TOTP QR back as an SVG data URL (or raw SVG in older
 *  versions) — normalize both into something an <img> can render. Moved
 *  here from `security-tab.tsx` (Task 10); this is its only consumer. */
export function totpQrSrc(qr: string): string {
  if (qr.startsWith('data:')) return qr;
  return `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`;
}

/**
 * A section label between two groups — plain small text, optionally one line
 * of explanation, sitting above the next group. Not a card header: it carries
 * no border and no background, so the bordered group below it reads as the
 * thing being labelled. Still an `h2` so the pane keeps a real heading outline
 * (`profile-tab.test.tsx` reads these).
 *
 * Deliberately duplicated in `general-tab.tsx` rather than shared: the two
 * Linear restyles landed in parallel and neither should have edited the other
 * agent's file. Promote it to `components/ui/settings-row.tsx` once a third
 * pane needs it.
 */
/** One enrolled factor row — pure view, exported for render tests. Moved
 *  here from `security-tab.tsx` (Task 10); this is its only consumer.
 *  Border-less: it is stacked inside a `SettingsRowGroup` with the
 *  two-factor row, and the group draws the border and the hairlines. */
export function FactorRow({
  factor,
  onRemove,
}: {
  factor: { id: string; friendly_name?: string; factor_type?: string; status?: string };
  onRemove: (id: string) => void;
}) {
  const Icon = factor.factor_type === 'phone' ? Smartphone : KeyRound;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-sm">
          <Icon className="text-muted-foreground size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-foreground truncate text-sm">
            {factor.friendly_name ||
              (factor.factor_type === 'phone' ? 'Phone' : 'Authenticator app')}
          </div>
          <div className="text-muted-foreground text-xs">
            {factor.factor_type === 'phone' ? 'SMS' : 'Authenticator app (TOTP)'}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={factor.status === 'verified' ? 'kortix' : 'outline'} size="xs">
          {factor.status}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Remove factor"
          onClick={() => onRemove(factor.id)}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

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

  // Two-factor authentication
  factors?: FactorInfo[];
  factorsLoading?: boolean;
  factorsError?: boolean;
  onRetryFactors?: () => void;
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
  accounts = [],
  accountsLoading = false,
  factors = [],
  factorsLoading = false,
  factorsError = false,
  onRetryFactors = () => {},
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

      {/* Organizations — directly under the identity group and ABOVE Security,
          because it answers the same question those rows do ("who am I here")
          and because Jay asked for it to be EASY to reach: no scrolling, no tab
          to find first. `account-memberships.tsx` carries the full rationale,
          including why it is not a fourth rail row. */}
      <AccountMembershipsSection accounts={accounts} isLoading={accountsLoading} />

      {/* Security */}
      <section className="space-y-3">
        <SettingsSubsectionHeader title="Security" />

        <SettingsRowGroup>
          <SettingsRow
            label="Two-factor authentication"
            description="Add an authenticator app (TOTP) as a second factor."
          >
            {verified.length > 0 && (
              <Badge
                variant="secondary"
                size="xs"
                className={cn(
                  'shrink-0 gap-1',
                  sessionVerified
                    ? 'bg-kortix-green/15 text-kortix-green border-transparent'
                    : 'text-muted-foreground',
                )}
              >
                <ShieldCheck className="size-3.5" />
                {sessionVerified ? 'Session verified' : 'Enrolled'}
              </Badge>
            )}
            {enrolling ? null : (
              <Button
                size="sm"
                variant="secondary"
                onClick={onStartEnroll}
                disabled={isStartingEnroll}
              >
                {isStartingEnroll ? <Loading className="size-3.5" /> : <Plus className="size-4" />}
                Add authenticator app
              </Button>
            )}
          </SettingsRow>
          {/* Enrolled factors stack under the row they belong to, inside the
              same border — `divide-y` draws the hairline between them. While
              the list is in flight, one shape-matched skeleton stands in for a
              factor row, so the group does not jump when the answer lands. */}
          {factorsLoading ? (
            <div className="px-4 py-3">
              <Skeleton className="h-8 w-full rounded-sm" />
            </div>
          ) : factorsError ? null : (
            factors.map((f) => <FactorRow key={f.id} factor={f} onRemove={onRequestRemoveFactor} />)
          )}
        </SettingsRowGroup>

        {/* The three answers the factor list can give, below the group so no
            banner nests a second border inside it:
            - it failed  → say so, in red, with a Retry. Never the empty-state
              copy: "No second factor enrolled" is a claim about the account,
              and a fetch that failed knows nothing about the account.
            - it is empty → the enrollment nudge, in orange ("needs attention"
              per the design system's status-token table — matches the same
              copy's tone in mfa-step-up.tsx's step-up dialog).
            - it has factors → nothing here; the rows above ARE the answer.
            Loading outranks both: an in-flight list has no answer yet. */}
        {!factorsLoading && factorsError ? (
          <InfoBanner
            tone="destructive"
            icon={Warning}
            title="Couldn’t load your authenticator apps"
            action={
              <Button variant="outline" size="sm" onClick={onRetryFactors}>
                Retry
              </Button>
            }
          >
            Your two-factor settings are unchanged — this is only the list failing to load.
          </InfoBanner>
        ) : !factorsLoading && factors.length === 0 && !enrolling ? (
          <InfoBanner tone="warning" icon={ShieldWarning} title="No second factor enrolled">
            If your organization requires MFA, you’ll be blocked from gated actions until you enroll
            an authenticator here.
          </InfoBanner>
        ) : null}

        {enrolling ? (
          <div className="border-border/60 bg-popover space-y-4 rounded-md border p-4">
            <div>
              <h4 className="text-foreground text-sm font-medium">
                Scan with your authenticator app
              </h4>
              <p className="text-muted-foreground mt-1 text-xs text-pretty">
                Use 1Password, Google Authenticator, or any TOTP app — then enter the 6-digit code
                it shows.
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
                    onChange={(e) =>
                      onEnrollCodeChange(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
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
        ) : null}

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

  // --- Two-factor authentication --------------------------------------
  // See hooks/account/use-mfa.ts — the factors/aal queries and the enroll /
  // verify / remove / cancel-enroll mutations live there now, shared with
  // every other MFA-managing surface instead of re-implemented per tab.
  const mfa = useMfa();

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
      factors={mfa.factors}
      factorsLoading={mfa.factorsLoading}
      factorsError={mfa.factorsError}
      onRetryFactors={mfa.onRetryFactors}
      sessionVerified={mfa.sessionVerified}
      removeFactorTarget={mfa.removeFactorTarget}
      onRequestRemoveFactor={mfa.setRemoveFactorTarget}
      onCancelRemoveFactor={() => mfa.setRemoveFactorTarget(null)}
      onConfirmRemoveFactor={mfa.confirmRemoveFactor}
      isRemovingFactor={mfa.isRemovingFactor}
      enrolling={mfa.enrolling}
      enrollCode={mfa.enrollCode}
      onEnrollCodeChange={mfa.setEnrollCode}
      onStartEnroll={mfa.startEnroll}
      isStartingEnroll={mfa.isStartingEnroll}
      onVerifyEnroll={mfa.verifyEnroll}
      isVerifyingEnroll={mfa.isVerifyingEnroll}
      onCancelEnroll={mfa.cancelEnroll}
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
