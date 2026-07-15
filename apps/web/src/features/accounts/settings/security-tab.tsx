'use client';

// Personal security settings: enroll and manage MFA factors (authenticator
// app / TOTP). This is the member-side half of the account-wide "Require MFA"
// enforcement — the admin card (components/iam/mfa-required-card.tsx) flips
// the account flag; THIS tab is where each member enrolls so an aal1 session
// can step up instead of being locked out. The step-up dialog itself lives in
// features/auth/mfa-step-up.tsx and keys on the `account_mfa_required` 403.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { invalidateTokenCache } from '@/lib/auth-token';
import { createClient } from '@/lib/supabase/client';
import { supabaseMFAService } from '@/lib/supabase/mfa';

/** Supabase hands the TOTP QR back as an SVG data URL (or raw SVG in older
 *  versions) — normalize both into something an <img> can render. */
export function totpQrSrc(qr: string): string {
  if (qr.startsWith('data:')) return qr;
  return `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`;
}

/** One enrolled factor row — pure view, exported for render tests. */
export function FactorRow({
  factor,
  onRemove,
}: {
  factor: { id: string; friendly_name?: string; factor_type?: string; status?: string };
  onRemove: (id: string) => void;
}) {
  const Icon = factor.factor_type === 'phone' ? Smartphone : KeyRound;
  return (
    <div className="border-border/60 bg-popover flex items-center justify-between gap-3 rounded-md border px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
          <Icon className="text-muted-foreground size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-foreground truncate text-sm font-medium">
            {factor.friendly_name || (factor.factor_type === 'phone' ? 'Phone' : 'Authenticator app')}
          </div>
          <div className="text-muted-foreground text-xs capitalize">{factor.factor_type}</div>
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

export function SecurityTab() {
  const queryClient = useQueryClient();
  const [enrolling, setEnrolling] = useState<{ factorId: string; qr: string; secret?: string } | null>(
    null,
  );
  const [code, setCode] = useState('');
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const factorsQuery = useQuery({
    queryKey: ['mfa-factors'],
    queryFn: () => supabaseMFAService.listFactors(),
    staleTime: 10_000,
  });

  const aalQuery = useQuery({
    queryKey: ['mfa-aal'],
    queryFn: () => supabaseMFAService.getAAL(),
    staleTime: 10_000,
  });

  const startEnroll = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
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
      setCode('');
    },
    onError: (err: Error) => errorToast(err.message || 'Could not start enrollment'),
  });

  const verifyEnroll = useMutation({
    mutationFn: async () => {
      if (!enrolling) throw new Error('No enrollment in progress');
      await supabaseMFAService.challengeAndVerify({ factor_id: enrolling.factorId, code });
    },
    onSuccess: () => {
      // Verifying the first factor elevates this session to aal2. Bust the
      // 30s token cache so the next gated request uses the new token instead
      // of replaying the stale aal1 one.
      invalidateTokenCache();
      successToast('Authenticator enrolled — this session is now MFA-verified');
      setEnrolling(null);
      setCode('');
      queryClient.invalidateQueries({ queryKey: ['mfa-factors'] });
      queryClient.invalidateQueries({ queryKey: ['mfa-aal'] });
    },
    onError: (err: Error) => errorToast(err.message || 'Code did not verify'),
  });

  const removeFactor = useMutation({
    mutationFn: (factorId: string) => supabaseMFAService.unenrollFactor(factorId),
    onSuccess: () => {
      successToast('Factor removed');
      setRemoveTarget(null);
      queryClient.invalidateQueries({ queryKey: ['mfa-factors'] });
      queryClient.invalidateQueries({ queryKey: ['mfa-aal'] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove factor'),
  });

  const factors = factorsQuery.data?.factors ?? [];
  const verified = factors.filter((f) => f.status === 'verified');
  const sessionVerified = aalQuery.data?.current_level === 'aal2';

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-foreground text-sm font-medium">Two-factor authentication</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Add an authenticator app (TOTP) as a second factor. Accounts with
              “Require MFA” enforce a verified factor before any gated action.
            </p>
          </div>
          {verified.length > 0 && (
            <Badge variant={sessionVerified ? 'kortix' : 'outline'} size="sm" className="shrink-0">
              <ShieldCheck />
              {sessionVerified ? 'Session verified' : 'Enrolled'}
            </Badge>
          )}
        </div>
      </div>

      {factorsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <div className="space-y-2">
          {factors.length === 0 && !enrolling && (
            <InfoBanner tone="info" title="No second factor enrolled">
              If your organization requires MFA, you’ll be blocked from gated
              actions until you enroll an authenticator here.
            </InfoBanner>
          )}
          {factors.map((f) => (
            <FactorRow key={f.id} factor={f} onRemove={(id) => setRemoveTarget(id)} />
          ))}
        </div>
      )}

      {enrolling ? (
        <div className="border-border/60 bg-popover space-y-4 rounded-md border p-4">
          <div>
            <h4 className="text-foreground text-sm font-medium">Scan with your authenticator app</h4>
            <p className="text-muted-foreground mt-1 text-xs">
              Use 1Password, Google Authenticator, or any TOTP app — then enter
              the 6-digit code it shows.
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
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="w-32 font-mono tracking-widest"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => verifyEnroll.mutate()}
                  disabled={code.length !== 6 || verifyEnroll.isPending}
                  className="gap-1.5"
                >
                  {verifyEnroll.isPending && <Loading className="size-4" />}
                  Verify and enable
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    // Abandoning enrollment leaves an unverified factor behind —
                    // clean it up so the list doesn't accumulate ghosts.
                    removeFactor.mutate(enrolling.factorId);
                    setEnrolling(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => startEnroll.mutate()}
          disabled={startEnroll.isPending}
          className="gap-1.5"
        >
          {startEnroll.isPending ? <Loading className="size-4" /> : <Plus className="size-4" />}
          Add authenticator app
        </Button>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title="Remove this factor?"
        description="If your organization requires MFA and this is your only verified factor, you will be locked out of gated actions until you enroll again."
        confirmLabel="Remove factor"
        confirmVariant="destructive"
        onConfirm={() => removeTarget && removeFactor.mutate(removeTarget)}
        isPending={removeFactor.isPending}
      />
    </div>
  );
}
