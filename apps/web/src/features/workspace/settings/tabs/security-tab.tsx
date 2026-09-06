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

import {
  KeyIcon as KeyRound,
  PlusIcon as Plus,
  ShieldCheckIcon as ShieldCheck,
  ShieldWarningIcon as ShieldWarning,
  DeviceMobileIcon as Smartphone,
  TrashIcon as Trash2,
  WarningIcon as Warning,
} from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { type EnrollingFactor, useMfa } from '@/hooks/account/use-mfa';
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

export interface SecurityTabViewProps {
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

  // Other devices
  onSignOutOtherDevices?: () => void;
  isSigningOutOtherDevices?: boolean;
}

/** Presentational only — no hooks, no data fetching. Every prop is optional
 *  with a safe default so the bare `<SecurityTabView />` the test file
 *  renders shows every section fully formed. */
export function SecurityTabView({
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
  onSignOutOtherDevices = () => {},
  isSigningOutOtherDevices = false,
}: SecurityTabViewProps) {
  const verified = factors.filter((f) => f.status === 'verified');

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="security" />

      {/* Two-factor authentication */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Two-factor authentication"
          description="A second factor keeps your account safe even if your sign-in is compromised."
        />

        <SettingsRowGroup>
          <SettingsRow
            label="Authenticator app"
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
            - it is empty → the enrollment nudge, in orange ("needs attention").
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

      {/* Devices */}
      <section className="space-y-3">
        <SettingsSubsectionHeader title="Devices" />
        <SettingsRowGroup>
          <SettingsRow
            label="Sign out other devices"
            description="Ends every other session signed in as you. This browser stays signed in."
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={onSignOutOtherDevices}
              disabled={isSigningOutOtherDevices}
            >
              {isSigningOutOtherDevices ? <Loading className="size-3.5 shrink-0" /> : null}
              Sign out other devices
            </Button>
          </SettingsRow>
        </SettingsRowGroup>
      </section>
    </div>
  );
}

/** Container: owns every hook and renders `SecurityTabView` with real data
 *  and handlers. Only ever mounted while this tab is active. */
export function SecurityTab() {
  const supabase = createClient();
  const mfa = useMfa();

  // `scope: 'others'` revokes every refresh token but this browser's, so the
  // person stays signed in where they pressed the button.
  const signOutOthers = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signOut({ scope: 'others' });
      if (error) throw error;
    },
    onSuccess: () => successToast('Signed out of your other devices'),
    onError: (error: Error) => errorToast(error.message || 'Could not sign out other devices'),
  });

  return (
    <SecurityTabView
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
      onSignOutOtherDevices={() => signOutOthers.mutate()}
      isSigningOutOtherDevices={signOutOthers.isPending}
    />
  );
}
