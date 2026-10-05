'use client';

/**
 * The Security tab — two-factor authentication and the other devices you are
 * signed in on.
 *
 * Split out of Profile on 2026-09-02 (Jay: "for security it should be a
 * separate tab"). Profile answers "who am I" — picture, name, email, which
 * organizations. This pane answers "how is that identity protected", which is
 * a different question a person comes here with a different intent for, and
 * one that does not belong under a heading between Organizations and Danger
 * zone.
 *
 * Same row shape as every pane (`SettingsRowGroup` / `SettingsRow`), same MFA
 * plumbing as before: `hooks/account/use-mfa.ts` owns the factor queries and
 * the enroll / verify / remove mutations. `FactorRow` and `totpQrSrc` moved
 * here from `profile-tab.tsx` with the section that renders them.
 *
 * `SecurityTabView` is the pure, props-only half — it renders under
 * `renderToStaticMarkup` with no React Query client or Supabase session (see
 * `security-tab.test.tsx`). `SecurityTab` is the container; it only mounts
 * while this tab is active, so opening the panel never fires its queries.
 */

import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  KeyIcon as KeyRound,
  PlusIcon as Plus,
  ShieldWarningIcon as ShieldWarning,
  DeviceMobileIcon as Smartphone,
  TrashIcon as Trash2,
  WarningIcon as Warning,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { CopyButton } from '@/components/markdown/copy-button';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { type EnrollingFactor, useMfa } from '@/hooks/account/use-mfa';
import { requestMfaStepUp } from '@/features/auth/mfa-step-up';
import { createClient } from '@/lib/supabase/client';
import type { FactorInfo } from '@/lib/supabase/mfa';
import { cn } from '@/lib/utils';
import { SettingsTabHeader } from '../settings-tab-header';

/** Supabase hands the TOTP QR back as an SVG data URL (or raw SVG in older
 *  versions) — normalize both into something an <img> can render. */
export function totpQrSrc(qr: string): string {
  if (qr.startsWith('data:')) return qr;
  return `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`;
}

/** One enrolled factor row — pure view, exported for render tests.
 *  Border-less: it is stacked inside a `SettingsRowGroup` with the
 *  two-factor row, and the group draws the border and the hairlines. */
export function FactorRow({
  factor,
  onRemove,
  copy = DEFAULT_SECURITY_TAB_COPY,
}: {
  factor: { id: string; friendly_name?: string; factor_type?: string; status?: string };
  onRemove: (id: string) => void;
  copy?: SecurityTabCopy;
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
              (factor.factor_type === 'phone' ? copy.phone : copy.authenticatorApp)}
          </div>
          <div className="text-muted-foreground text-xs">
            {factor.factor_type === 'phone' ? copy.sms : copy.authenticatorTotp}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* A verified factor is the normal case and needs no label; only an
            unfinished one is called out. */}
        {factor.status === 'verified' ? null : (
          <Badge variant="outline" size="xs">
            {factor.status === 'unverified' ? copy.unverified : factor.status}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={copy.removeFactor}
          onClick={() => onRemove(factor.id)}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

const CODE_LENGTH = 6;
const AUTHENTICATOR_APPS = [
  { mark: '1P', name: '1Password' },
  { mark: 'G', name: 'Google Authenticator' },
  { mark: 'A', name: 'Authy' },
];

/** Groups a TOTP secret in fours, the way authenticator apps print it. */
export function formatSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/** The enrollment dialog: scan on the left, type the code on the right.
 *  One real input sits over six drawn cells, so paste, autofill
 *  (`one-time-code`) and screen readers all see a single field. The
 *  container verifies as soon as the sixth digit lands. */
export function EnrollDialog({
  enrolling,
  code,
  onCodeChange,
  onVerify,
  isVerifying,
  onCancel,
  copy,
}: {
  enrolling: EnrollingFactor | null;
  code: string;
  onCodeChange: (value: string) => void;
  onVerify: () => void;
  isVerifying: boolean;
  onCancel: () => void;
  copy: SecurityTabCopy;
}) {
  return (
    <Dialog open={enrolling !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-[40rem]">
        {enrolling ? (
          <div className="flex flex-col sm:flex-row">
            {/* `dark` scopes the dark tokens to this panel in both themes. */}
            <div className="dark bg-background text-foreground border-border flex shrink-0 flex-col gap-6 border-b p-6 sm:w-[16.25rem] sm:border-e sm:border-b-0">
              <div className="space-y-1">
                <h3 className="text-lg font-semibold tracking-tight">{copy.scanTitle}</h3>
                <p className="text-muted-foreground text-sm text-pretty">{copy.scanDescription}</p>
              </div>
              {/* biome-ignore lint/performance/noImgElement: QR is an inline SVG data URL, next/image adds nothing */}
              <img
                src={totpQrSrc(enrolling.qr)}
                alt={copy.qrAlt}
                className="aspect-square w-full max-w-[13.25rem] self-center rounded-lg bg-white p-3"
              />
              {enrolling.secret ? (
                <div className="space-y-2">
                  <div className="text-muted-foreground text-xs font-medium">
                    {copy.manualSecret}
                  </div>
                  <div className="border-border bg-muted/40 flex min-h-10 items-center justify-between gap-2 rounded-md border py-1.5 ps-3 pe-1">
                    <code className="min-w-0 font-mono text-xs leading-5 font-medium tracking-tight">
                      {formatSecret(enrolling.secret)}
                    </code>
                    <CopyButton code={enrolling.secret} className="shrink-0" />
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-6 p-6">
              <div className="space-y-1 pe-8">
                <DialogTitle className="text-lg leading-7">{copy.codeTitle}</DialogTitle>
                <DialogDescription>{copy.codeDescription}</DialogDescription>
              </div>

              <label className="relative flex items-center justify-between">
                <span className="sr-only">{copy.codeTitle}</span>
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <span
                    key={i}
                    aria-hidden
                    className={cn(
                      'border-border bg-background flex h-14 w-[15%] items-center justify-center rounded-md border font-mono text-2xl font-medium tracking-tight',
                      i === Math.min(code.length, CODE_LENGTH - 1) &&
                        'border-foreground ring-foreground/10 ring-2',
                    )}
                  >
                    {code[i] ?? ''}
                  </span>
                ))}
                <input
                  value={code}
                  onChange={(e) =>
                    onCodeChange(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))
                  }
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={CODE_LENGTH}
                  disabled={isVerifying}
                  autoFocus
                  className="absolute inset-0 cursor-text opacity-0"
                />
              </label>

              <div className="border-border flex-1 space-y-3 border-t pt-5">
                <div className="text-muted-foreground text-xs font-medium">{copy.worksWith}</div>
                <ul className="space-y-2">
                  {AUTHENTICATOR_APPS.map((app) => (
                    <li key={app.name} className="flex items-center gap-3 text-sm">
                      <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold tracking-tight">
                        {app.mark}
                      </span>
                      {app.name}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onCancel}>
                  {copy.cancel}
                </Button>
                <Button
                  onClick={onVerify}
                  disabled={code.length !== CODE_LENGTH || isVerifying}
                  className="gap-1.5"
                >
                  {isVerifying ? <Loading className="size-4" /> : null}
                  {copy.verifyAndEnable}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface SecurityTabViewProps {
  // Two-factor authentication
  factors?: FactorInfo[];
  factorsLoading?: boolean;
  factorsError?: boolean;
  onRetryFactors?: () => void;
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

  // Devices
  devices?: DeviceRow[];
  devicesLoading?: boolean;
  devicesError?: boolean;
  onRetryDevices?: () => void;

  // Other devices
  onSignOutOtherDevices?: () => void;
  isSigningOutOtherDevices?: boolean;
  copy?: Partial<SecurityTabCopy>;
}

/** One row in the Devices section. `detail` arrives as the finished,
 *  translated string — the container composes it, so the pure view holds no
 *  date formatting and no locale hook. */
export interface DeviceRow {
  label: string;
  detail?: string;
}

export interface SecurityTabCopy {
  twoFactorTitle: string;
  twoFactorDescription: string;
  authenticatorApp: string;
  authenticatorDescription: string;
  statusOn: string;
  addAuthenticatorApp: string;
  factorsLoadFailed: string;
  retry: string;
  factorsUnchanged: string;
  noFactorEnrolled: string;
  noFactorDescription: string;
  scanTitle: string;
  scanDescription: string;
  qrAlt: string;
  manualSecret: string;
  codeTitle: string;
  codeDescription: string;
  worksWith: string;
  verifyAndEnable: string;
  cancel: string;
  removeFactorTitle: string;
  removeFactorDescription: string;
  removeFactor: string;
  devices: string;
  currentDevice: string;
  deviceActive: string;
  noDevices: string;
  noDevicesDescription: string;
  devicesLoadFailed: string;
  signOutOtherDevices: string;
  signOutOtherDevicesDescription: string;
  phone: string;
  sms: string;
  authenticatorTotp: string;
  verified: string;
  unverified: string;
}

export const DEFAULT_SECURITY_TAB_COPY: SecurityTabCopy = {
  twoFactorTitle: 'Two-factor authentication',
  twoFactorDescription:
    'A second factor keeps your account safe even if your sign-in is compromised.',
  authenticatorApp: 'Authenticator app',
  authenticatorDescription: 'Add an authenticator app (TOTP) as a second factor.',
  statusOn: 'On · Asked at sign-in and before sensitive changes',
  addAuthenticatorApp: 'Add authenticator app',
  factorsLoadFailed: 'Couldn’t load your authenticator apps',
  retry: 'Retry',
  factorsUnchanged:
    'Your two-factor settings are unchanged — this is only the list failing to load.',
  noFactorEnrolled: 'No second factor enrolled',
  noFactorDescription:
    'If your organization requires MFA, you’ll be blocked from gated actions until you enroll an authenticator here.',
  scanTitle: 'Scan with your phone',
  scanDescription: 'Open any authenticator app and scan this code.',
  qrAlt: 'TOTP enrollment QR code',
  manualSecret: 'Can’t scan? Enter this key',
  codeTitle: 'Enter the code',
  codeDescription: 'Type the 6 digits your app shows. It verifies on its own.',
  worksWith: 'Works with',
  verifyAndEnable: 'Verify',
  cancel: 'Cancel',
  removeFactorTitle: 'Remove this factor?',
  removeFactorDescription:
    'If your organization requires MFA and this is your only verified factor, you will be locked out of gated actions until you enroll again.',
  removeFactor: 'Remove factor',
  devices: 'Devices',
  currentDevice: 'This browser',
  deviceActive: 'Active',
  noDevices: 'No signed-in devices',
  noDevicesDescription: 'You are not signed in on any device right now.',
  devicesLoadFailed: 'Couldn’t load your signed-in devices',
  signOutOtherDevices: 'Sign out other devices',
  signOutOtherDevicesDescription:
    'Ends every other session signed in as you. This browser stays signed in.',
  phone: 'Phone',
  sms: 'SMS',
  authenticatorTotp: 'Authenticator app (TOTP)',
  verified: 'verified',
  unverified: 'unverified',
};

/** Presentational only — no hooks, no data fetching. Every prop is optional
 *  with a safe default so the bare `<SecurityTabView />` the test file
 *  renders shows every section fully formed. */
export function SecurityTabView({
  factors = [],
  factorsLoading = false,
  factorsError = false,
  onRetryFactors = () => {},
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
  devices = [],
  devicesLoading = false,
  devicesError = false,
  onRetryDevices = () => {},
  onSignOutOtherDevices = () => {},
  isSigningOutOtherDevices = false,
  copy: copyOverrides = {},
}: SecurityTabViewProps) {
  const copy = { ...DEFAULT_SECURITY_TAB_COPY, ...copyOverrides };
  const verified = factors.filter((f) => f.status === 'verified');

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="security" />

      {/* Two-factor authentication */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={copy.twoFactorTitle}
          description={copy.twoFactorDescription}
        />

        <SettingsRowGroup>
          <SettingsRow
            label={copy.authenticatorApp}
            description={
              verified.length > 0 ? (
                <span className="flex items-center gap-1.5">
                  <span className="bg-kortix-green size-1.5 shrink-0 rounded-full" />
                  {copy.statusOn}
                </span>
              ) : (
                copy.authenticatorDescription
              )
            }
          >
            {enrolling ? null : (
              <Button
                size="sm"
                variant="secondary"
                onClick={onStartEnroll}
                disabled={isStartingEnroll}
              >
                {isStartingEnroll ? <Loading className="size-3.5" /> : <Plus className="size-4" />}
                {copy.addAuthenticatorApp}
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
            factors.map((f) => (
              <FactorRow key={f.id} factor={f} onRemove={onRequestRemoveFactor} copy={copy} />
            ))
          )}
        </SettingsRowGroup>

        {/* The three answers the factor list can give, below the group so no
            banner nests a second border inside it:
            - it failed  → say so, in red, with a Retry. Never the empty-state
              copy: "No second factor enrolled" is a claim about the account,
              and a fetch that failed knows nothing about the account.
            - it is empty → the enrollment nudge, in orange ("needs attention").
            - it has factors → nothing here; the rows above ARE the answer.
            Loading outranks both: an in-flight list has no answer yet. */}
        {!factorsLoading && factorsError ? (
          <InfoBanner
            tone="destructive"
            icon={Warning}
            title={copy.factorsLoadFailed}
            action={
              <Button variant="outline" size="sm" onClick={onRetryFactors}>
                {copy.retry}
              </Button>
            }
          >
            {copy.factorsUnchanged}
          </InfoBanner>
        ) : !factorsLoading && factors.length === 0 && !enrolling ? (
          <InfoBanner tone="warning" icon={ShieldWarning} title={copy.noFactorEnrolled}>
            {copy.noFactorDescription}
          </InfoBanner>
        ) : null}

        <EnrollDialog
          enrolling={enrolling}
          code={enrollCode}
          onCodeChange={onEnrollCodeChange}
          onVerify={onVerifyEnroll}
          isVerifying={isVerifyingEnroll}
          onCancel={onCancelEnroll}
          copy={copy}
        />

        <ConfirmDialog
          open={removeFactorTarget !== null}
          onOpenChange={(open) => !open && onCancelRemoveFactor()}
          title={copy.removeFactorTitle}
          description={copy.removeFactorDescription}
          confirmLabel={copy.removeFactor}
          confirmVariant="destructive"
          onConfirm={onConfirmRemoveFactor}
          isPending={isRemovingFactor}
        />
      </section>

      {/* Devices */}
      <section className="space-y-3">
        <SettingsSubsectionHeader title={copy.devices} />
        <SettingsRowGroup>
          {/* While the list is in flight, one shape-matched skeleton stands in
              for a device row, so the group does not jump when the answer
              lands — same answer as the factor list above. */}
          {devicesLoading ? (
            <div className="px-4 py-3">
              <Skeleton className="h-8 w-full rounded-sm" />
            </div>
          ) : (
            devices.map((device) => (
              <div key={device.label} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-sm">
                    <Smartphone className="text-muted-foreground size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-foreground truncate text-sm">{device.label}</div>
                    {device.detail ? (
                      <div className="text-muted-foreground text-xs">{device.detail}</div>
                    ) : null}
                  </div>
                </div>
                <Badge variant="success" size="xs">
                  {copy.deviceActive}
                </Badge>
              </div>
            ))
          )}
          <SettingsRow
            label={copy.signOutOtherDevices}
            description={copy.signOutOtherDevicesDescription}
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={onSignOutOtherDevices}
              disabled={isSigningOutOtherDevices}
            >
              {isSigningOutOtherDevices ? <Loading className="size-3.5 shrink-0" /> : null}
              {copy.signOutOtherDevices}
            </Button>
          </SettingsRow>
        </SettingsRowGroup>

        {/* The three answers the device list can give, below the group so no
            state nests a second border inside it — the same split the factor
            list makes. A failed fetch is an error with a Retry, never the
            empty-state copy; an empty list is said out loud. Loading outranks
            both. */}
        {devicesLoading ? null : devicesError ? (
          <ErrorState
            size="sm"
            title={copy.devicesLoadFailed}
            action={
              <Button variant="outline" size="sm" onClick={onRetryDevices}>
                {copy.retry}
              </Button>
            }
          />
        ) : devices.length === 0 ? (
          <EmptyState size="sm" title={copy.noDevices} description={copy.noDevicesDescription} />
        ) : null}
      </section>
    </div>
  );
}

/** Container: owns every hook and renders `SecurityTabView` with real data
 *  and handlers. Only ever mounted while this tab is active. */
export function SecurityTab() {
  const t = useTranslations('settings.security');
  const locale = useLocale();
  const copy: SecurityTabCopy = {
    twoFactorTitle: t('twoFactorTitle'),
    twoFactorDescription: t('twoFactorDescription'),
    authenticatorApp: t('authenticatorApp'),
    authenticatorDescription: t('authenticatorDescription'),
    statusOn: t('statusOn'),
    addAuthenticatorApp: t('addAuthenticatorApp'),
    factorsLoadFailed: t('factorsLoadFailed'),
    retry: t('retry'),
    factorsUnchanged: t('factorsUnchanged'),
    noFactorEnrolled: t('noFactorEnrolled'),
    noFactorDescription: t('noFactorDescription'),
    scanTitle: t('scanTitle'),
    scanDescription: t('scanDescription'),
    qrAlt: t('qrAlt'),
    manualSecret: t('manualSecret'),
    codeTitle: t('codeTitle'),
    codeDescription: t('codeDescription'),
    worksWith: t('worksWith'),
    verifyAndEnable: t('verifyAndEnable'),
    cancel: t('cancel'),
    removeFactorTitle: t('removeFactorTitle'),
    removeFactorDescription: t('removeFactorDescription'),
    removeFactor: t('removeFactor'),
    devices: t('devices'),
    currentDevice: t('currentDevice'),
    deviceActive: t('deviceActive'),
    noDevices: t('noDevices'),
    noDevicesDescription: t('noDevicesDescription'),
    devicesLoadFailed: t('devicesLoadFailed'),
    signOutOtherDevices: t('signOutOtherDevices'),
    signOutOtherDevicesDescription: t('signOutOtherDevicesDescription'),
    phone: t('phone'),
    sms: t('sms'),
    authenticatorTotp: t('authenticatorTotp'),
    verified: t('verified'),
    unverified: t('unverified'),
  };
  const supabase = createClient();
  const mfa = useMfa();

  // The devices signed in as you. GoTrue gives a client no way to enumerate
  // the account's other sessions, so this list holds the one device it can
  // vouch for — the browser this page runs on — backed by a real
  // `GET /auth/v1/user` call; `last_sign_in_at` is the auth server's own
  // record of when that session signed in. A session-less answer (the user
  // is signed out) is the explicit empty state, not an error.
  const deviceQuery = useQuery({
    queryKey: ['auth-current-device'],
    queryFn: async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error?.name === 'AuthSessionMissingError') return null;
      if (error) throw error;
      return data.user;
    },
    staleTime: 10_000,
  });

  const signedInAt = deviceQuery.data?.last_sign_in_at ?? null;
  const devices: DeviceRow[] = signedInAt
    ? [
        {
          label: copy.currentDevice,
          detail: t('deviceSignedInAt', {
            date: new Intl.DateTimeFormat(locale, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            }).format(new Date(signedInAt)),
          }),
        },
      ]
    : [];

  // `scope: 'others'` revokes every refresh token but this browser's, so the
  // person stays signed in where they pressed the button.
  const signOutOthers = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signOut({ scope: 'others' });
      if (error) throw error;
    },
    onSuccess: () => successToast(t('signedOutOtherDevices')),
    onError: (error: Error) => errorToast(error.message || t('signOutOtherDevicesFailed')),
  });

  // Remove factor and sign-out-other-devices end a factor or sessions, so an
  // aal1 session with a verified TOTP factor asks for the code first
  // (KRTX-1386): requestMfaStepUp opens the global challenge dialog and runs
  // the action once the code verifies. A verified session runs the action
  // directly.
  const runWithStepUp = (action: () => void) =>
    requestMfaStepUp(mfa.challengeRequired, action);

  // The sixth digit submits the code; no button press needed.
  const { enrollCode, isVerifyingEnroll, verifyEnroll } = mfa;
  useEffect(() => {
    if (enrollCode.length === 6 && !isVerifyingEnroll) verifyEnroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per completed code
  }, [enrollCode]);

  return (
    <SecurityTabView
      factors={mfa.factors}
      factorsLoading={mfa.factorsLoading}
      factorsError={mfa.factorsError}
      onRetryFactors={mfa.onRetryFactors}
      removeFactorTarget={mfa.removeFactorTarget}
      onRequestRemoveFactor={mfa.setRemoveFactorTarget}
      onCancelRemoveFactor={() => mfa.setRemoveFactorTarget(null)}
      onConfirmRemoveFactor={() => {
        if (mfa.removeFactorTarget) runWithStepUp(mfa.confirmRemoveFactor);
      }}
      isRemovingFactor={mfa.isRemovingFactor}
      enrolling={mfa.enrolling}
      enrollCode={mfa.enrollCode}
      onEnrollCodeChange={mfa.setEnrollCode}
      onStartEnroll={mfa.startEnroll}
      isStartingEnroll={mfa.isStartingEnroll}
      onVerifyEnroll={mfa.verifyEnroll}
      isVerifyingEnroll={mfa.isVerifyingEnroll}
      onCancelEnroll={mfa.cancelEnroll}
      devices={devices}
      devicesLoading={deviceQuery.isLoading}
      devicesError={deviceQuery.isError}
      onRetryDevices={() => deviceQuery.refetch()}
      onSignOutOtherDevices={() => runWithStepUp(() => signOutOthers.mutate())}
      isSigningOutOtherDevices={signOutOthers.isPending}
      copy={copy}
    />
  );
}
