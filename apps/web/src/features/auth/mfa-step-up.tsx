'use client';

import { useTranslations } from '@/i18n/use-translations';
// Global MFA step-up dialog. The SDK's api-client dispatches
// `kortix:mfa-required` whenever ANY backend call is denied with the coded
// 403 `account_mfa_required` (account-wide "Require MFA" is on and this
// session is aal1). This provider — mounted once in the root layout — catches
// that event and walks the user through a TOTP challenge, upgrading the
// Supabase session to aal2 so the retried action passes the IAM gate.
//
// Callers can also request the dialog PROACTIVELY with `requestMfaStepUp`
// (a caller-supplied description, a specific factor, and the action to run
// once the code verifies) — the security tab does this before Remove factor
// and Sign out other devices. A request without a detail behaves exactly as
// the bare event always did.
//
// Members with NO enrolled factor get pointed at Settings → Security instead
// of a dead-end code prompt.

import {
  ShieldCheckIcon as ShieldCheck,
  ShieldWarningIcon as ShieldWarning,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

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
import { invalidateTokenCache } from '@/lib/auth-token';
import { supabaseMFAService } from '@/lib/supabase/mfa';

export const MFA_REQUIRED_EVENT = 'kortix:mfa-required';
export const MFA_VERIFIED_EVENT = 'kortix:mfa-verified';

/** What a caller asks of the step-up dialog, dispatched as the event's
 *  `detail`. Every field is optional: the SDK's api-client dispatches a bare
 *  event for the account-wide "Require MFA" denial, and a caller that needs
 *  the dialog PROACTIVELY (a destructive action re-asking for the code —
 *  see the security tab) supplies the rest.
 *
 *  `onVerified` runs once the code verifies — the caller's action.
 *  `onCancelled` runs when the dialog closes without a verify. Neither
 *  changes the bare-event flow: an absent detail behaves exactly as before.
 */
export interface MfaStepUpRequest {
  /** Dialog body copy for the caller's context (e.g. the destructive-action
   *  warning). Default copy when absent. */
  description?: string;
  /** Challenge THIS verified factor; default is the first verified one. */
  factorId?: string;
  onVerified?: () => void;
  onCancelled?: () => void;
}

/** Ask the global step-up dialog for a fresh TOTP verification. */
export function requestMfaStepUp(request: MfaStepUpRequest): void {
  window.dispatchEvent(new CustomEvent<MfaStepUpRequest>(MFA_REQUIRED_EVENT, { detail: request }));
}

export function MfaStepUpProvider({ children }: { children?: React.ReactNode }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  // The request that opened the dialog. A ref, not state: the event handler
  // sets it together with `open`, and the render that follows reads it once.
  const requestRef = useRef<MfaStepUpRequest | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const onRequired = (event: Event) => {
      requestRef.current = (event as CustomEvent<MfaStepUpRequest>).detail ?? null;
      setOpen(true);
    };
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
  const requested = requestRef.current?.factorId;
  const factor =
    (requested ? verified.find((f) => f.id === requested) : null) ?? verified[0] ?? null;
  const description = requestRef.current?.description ?? tI18nComplete.raw('text3ba20a470a12');

  const verify = useMutation({
    mutationFn: async () => {
      if (!factor) throw new Error('No verified factor enrolled');
      await supabaseMFAService.challengeAndVerify({ factor_id: factor.id, code });
    },
    onSuccess: () => {
      // challengeAndVerify minted a fresh aal2 JWT into Supabase storage, but
      // the api-client caches the access token for 30s — without busting it the
      // retried request would replay the stale aal1 token and be denied again,
      // making step-up look broken for up to 30s. Invalidate so the next call
      // reads the aal2 token.
      invalidateTokenCache();
      successToast(tI18nComplete.raw('text4f7838402f37'));
      setOpen(false);
      setCode('');
      // Refetch active queries so reads that failed while the session was aal1
      // recover on their own — the screen the user was on repopulates without a
      // manual reload. (Mutations still need a manual retry; react-query dedupes
      // the refetch storm.)
      queryClient.invalidateQueries();
      // The request is spent before its action runs, so a caller whose action
      // asks for another step-up opens a fresh dialog instead of mutating a
      // spent one.
      const request = requestRef.current;
      requestRef.current = null;
      request?.onVerified?.();
      window.dispatchEvent(new CustomEvent(MFA_VERIFIED_EVENT));
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('texte7307911656c')),
  });

  return (
    <>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            // A user-initiated close (Escape, overlay, Cancel) releases the
            // caller: the action it held must not run on a later verification.
            // A success close already cleared the ref in onSuccess.
            requestRef.current?.onCancelled?.();
            requestRef.current = null;
            setCode('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="text-kortix-green size-4" />
              {tI18nComplete.raw('text4d8f4755ac09')}
            </DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {factorsQuery.isLoading ? (
            <div className="py-2">
              <Loading className="size-4" />
            </div>
          ) : factor ? (
            <div className="space-y-1.5 py-1">
              <Label className="text-xs">{tI18nComplete.raw('text0d1fa0dfcc9e')}</Label>
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
            <InfoBanner
              tone="warning"
              icon={ShieldWarning}
              title={tI18nComplete.raw('text669350bd2952')}
            >
              {tI18nComplete.raw('textf3a4ff3c0ae3')}
            </InfoBanner>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            {factor && (
              <Button
                onClick={() => verify.mutate()}
                disabled={code.length !== 6 || verify.isPending}
                className="gap-1.5"
              >
                {verify.isPending && <Loading className="size-4" />}
                {tI18nComplete.raw('texteea2745e2867')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
