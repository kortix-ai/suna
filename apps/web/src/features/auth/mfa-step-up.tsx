'use client';

// Global MFA step-up dialog. The SDK's api-client dispatches
// `kortix:mfa-required` whenever ANY backend call is denied with the coded
// 403 `account_mfa_required` (account-wide "Require MFA" is on and this
// session is aal1). This provider — mounted once in the root layout — catches
// that event and walks the user through a TOTP challenge, upgrading the
// Supabase session to aal2 so the retried action passes the IAM gate.
//
// Members with NO enrolled factor get pointed at Settings → Security instead
// of a dead-end code prompt.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { supabaseMFAService } from '@/lib/supabase/mfa';

export const MFA_REQUIRED_EVENT = 'kortix:mfa-required';
export const MFA_VERIFIED_EVENT = 'kortix:mfa-verified';

export function MfaStepUpProvider({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const queryClient = useQueryClient();

  useEffect(() => {
    const onRequired = () => setOpen(true);
    window.addEventListener(MFA_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(MFA_REQUIRED_EVENT, onRequired);
  }, []);

  const factorsQuery = useQuery({
    queryKey: ['mfa-factors'],
    queryFn: () => supabaseMFAService.listFactors(),
    enabled: open,
    staleTime: 10_000,
  });

  const verified = (factorsQuery.data?.factors ?? []).filter((f) => f.status === 'verified');
  const factor = verified[0] ?? null;

  const verify = useMutation({
    mutationFn: async () => {
      if (!factor) throw new Error('No verified factor enrolled');
      await supabaseMFAService.challengeAndVerify({ factor_id: factor.id, code });
    },
    onSuccess: () => {
      successToast('Verified — retry what you were doing');
      setOpen(false);
      setCode('');
      queryClient.invalidateQueries({ queryKey: ['mfa-aal'] });
      window.dispatchEvent(new CustomEvent(MFA_VERIFIED_EVENT));
    },
    onError: (err: Error) => errorToast(err.message || 'Code did not verify'),
  });

  return (
    <>
      {children}
      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setCode(''); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="text-kortix-green size-4" />
              Verify it’s you
            </DialogTitle>
            <DialogDescription>
              This account requires multi-factor authentication for that
              action. Enter a code from your authenticator app to verify this
              session.
            </DialogDescription>
          </DialogHeader>

          {factorsQuery.isLoading ? (
            <div className="py-2">
              <Loading className="size-4" />
            </div>
          ) : factor ? (
            <div className="space-y-1.5 py-1">
              <Label className="text-xs">6-digit code</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="w-36 font-mono tracking-widest"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && code.length === 6 && !verify.isPending) verify.mutate();
                }}
              />
            </div>
          ) : (
            <InfoBanner tone="warning" title="No second factor enrolled">
              Enroll an authenticator app under Settings → Security, then retry
              — this account blocks gated actions until your session is
              MFA-verified.
            </InfoBanner>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {factor && (
              <Button
                onClick={() => verify.mutate()}
                disabled={code.length !== 6 || verify.isPending}
                className="gap-1.5"
              >
                {verify.isPending && <Loading className="size-4" />}
                Verify
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
