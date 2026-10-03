'use client';

/**
 * Global TOTP step-up machinery, three pieces sharing one challenge dialog:
 *
 * - `MfaStepUpProvider` — mounted once in the root layout. The SDK's api-client
 *   dispatches `kortix:mfa-required` whenever ANY backend call is denied with
 *   the coded 403 `account_mfa_required` (account-wide "Require MFA" is on and
 *   this session is aal1). This provider catches that event and walks the user
 *   through a TOTP challenge, upgrading the Supabase session to aal2 so the
 *   retried action passes the IAM gate.
 * - `MfaGate` — mounted in the `(app)` shell (KRTX-1386). An aal1 session with
 *   a verified TOTP factor gets the challenge INSTEAD of the app: an enrolled
 *   second factor that no sign-in ever asks for protects nothing. Nothing under
 *   the shell mounts or fetches until the code verifies and the session is aal2.
 * - `requestMfaStepUp` — the "run now, or after the code verifies" helper for
 *   sensitive client actions; the Security tab defers remove-factor and
 *   sign-out-other-devices behind it.
 *
 * `MfaChallengeDialog` is the one dialog both mount. It picks a verified factor
 * (TOTP preferred — an SMS code cannot be produced here), runs
 * `challengeAndVerify`, and dispatches `kortix:mfa-verified` on success so
 * deferred actions resume.
 *
 * Members with NO enrolled factor get pointed at Settings → Security instead
 * of a dead-end code prompt.
 */

import {
  ShieldCheckIcon as ShieldCheck,
  ShieldWarningIcon as ShieldWarning,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { invalidateTokenCache } from '@/lib/auth-token';
import { mfaChallengeRequired, supabaseMFAService } from '@/lib/supabase/mfa';
import { useAuth } from '@/features/providers/auth-provider';
import { MFA_AAL_QUERY_KEY, MFA_FACTORS_QUERY_KEY } from '@/hooks/account/use-mfa';
import { useTranslations } from '@/i18n/use-translations';

export const MFA_REQUIRED_EVENT = 'kortix:mfa-required';
export const MFA_VERIFIED_EVENT = 'kortix:mfa-verified';

/**
 * Run `action` now, or — while this session still owes a TOTP challenge — open
 * the step-up dialog first and run `action` once the code verifies. Same
 * contract as `chat-identity-connect`: the action stays armed if the dialog is
 * cancelled and runs at the next verified session.
 */
export function requestMfaStepUp(challengeRequired: boolean, action: () => void): void {
  if (!challengeRequired) {
    action();
    return;
  }
  window.addEventListener(MFA_VERIFIED_EVENT, () => action(), { once: true });
  window.dispatchEvent(new CustomEvent(MFA_REQUIRED_EVENT));
}

interface MfaChallengeDialogProps {
  open: boolean;
  /**
   * Whether the dialog may be closed without verifying. The sign-in gate
   * renders it non-dismissible: an aal1 session with a verified TOTP factor
   * cannot reach the app until the code verifies.
   */
  dismissible: boolean;
  onDismiss?: () => void;
  /** Called after a successful verification, before the verified event. */
  onVerified?: () => void;
}

export function MfaChallengeDialog({ open, dismissible, onDismiss, onVerified }: MfaChallengeDialogProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [code, setCode] = useState('');
  const queryClient = useQueryClient();

  const factorsQuery = useQuery({
    queryKey: MFA_FACTORS_QUERY_KEY,
    queryFn: () => supabaseMFAService.listFactors(),
    enabled: open,
    staleTime: 10_000,
  });

  const verified = (factorsQuery.data?.factors ?? []).filter((f) => f.status === 'verified');
  // The challenge is a TOTP code: prefer the TOTP factor so an account that
  // also carries a verified phone factor is never asked for an SMS code this
  // dialog cannot send.
  const factor = verified.find((f) => f.factor_type === 'totp') ?? verified[0] ?? null;

  const verify = useMutation({
    mutationFn: async () => {
      if (!factor) throw new Error('No verified factor enrolled');
      await supabaseMFAService.challengeAndVerify({ factor_id: factor.id, code });
    },
    onSuccess: () => {
      // challengeAndVerify minted a fresh aal2 JWT into Supabase storage, but
      // the api-client caches the access token for 30s — without busting it the
      // next request would replay the stale aal1 token and be denied again.
      // Invalidate so every caller (and the MfaGate's AAL answer, which is what
      // releases the gate) reads the aal2 token.
      invalidateTokenCache();
      successToast(tI18nComplete.raw('text4f7838402f37'));
      setCode('');
      // Refetch active queries so reads that failed while the session was aal1
      // recover on their own — the screen the user was on repopulates without a
      // manual reload. (Mutations still need a manual retry; react-query dedupes
      // the refetch storm.)
      queryClient.invalidateQueries();
      onVerified?.();
      window.dispatchEvent(new CustomEvent(MFA_VERIFIED_EVENT));
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('texte7307911656c')),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !dismissible) return;
        if (!next) setCode('');
        onDismiss?.();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="text-kortix-green size-4" />
            {tI18nComplete.raw('text4d8f4755ac09')}
          </DialogTitle>
          <DialogDescription>{tI18nComplete.raw('text3ba20a470a12')}</DialogDescription>
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
          {dismissible ? (
            <Button variant="ghost" onClick={() => onDismiss?.()}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
          ) : (
            // Escape hatch for a lost authenticator: the same sign-out every
            // in-app control runs. Without it the non-dismissible gate would be
            // a lockout with no way back to /auth.
            <Button variant="ghost" onClick={() => void performSignOut()}>
              {tI18nComplete.raw('text48f0d3d397d4')}
            </Button>
          )}
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
  );
}

export function MfaStepUpProvider({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onRequired = () => setOpen(true);
    window.addEventListener(MFA_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(MFA_REQUIRED_EVENT, onRequired);
  }, []);

  return (
    <>
      {children}
      <MfaChallengeDialog
        open={open}
        dismissible
        onDismiss={() => setOpen(false)}
        onVerified={() => setOpen(false)}
      />
    </>
  );
}

/**
 * The sign-in gate for the `(app)` shell. When a verified TOTP factor is
 * enrolled and this session is still aal1 (a fresh magic-link sign-in), the
 * challenge renders instead of the app and stays up until the session is aal2.
 *
 * The hold covers BOTH windows that could otherwise fetch with an aal1 token:
 * the auth provider's bootstrap (the stored session is already live for the
 * SDK's token cache before `isLoading` clears) and this gate's own first AAL
 * read. During both the shell renders a neutral loading frame instead of the
 * app. Two fail-opens, both bounded: an AAL read that ERRORS releases the app
 * (the account-wide `account_mfa_required` backend gate still covers that
 * session when the policy is on, and the Security tab's own step-up still
 * guards its sensitive actions), and an auth bootstrap that never completes
 * ends in the provider's bootstrapError path, same as before this gate.
 */
export function MfaGate({ children }: { children?: React.ReactNode }) {
  const { session, isLoading } = useAuth();
  const aalQuery = useQuery({
    queryKey: MFA_AAL_QUERY_KEY,
    queryFn: () => supabaseMFAService.getAAL(),
    enabled: !isLoading && !!session,
    staleTime: 10_000,
  });
  // `!!session` keeps the gate off once the session is gone: `performSignOut`
  // from the dialog's escape hatch must not leave a stale aal1 answer gating
  // the signed-out document.
  const enforced = !!session && !isLoading && mfaChallengeRequired(aalQuery.data);
  const deciding = isLoading || (!!session && aalQuery.isPending);

  return (
    <>
      {deciding || enforced ? (
        // A neutral full-screen frame for the window while the gate decides —
        // never the app, never blank.
        <div className="bg-background grid h-dvh place-items-center">
          <Loading className="size-6" />
        </div>
      ) : (
        children
      )}
      <MfaChallengeDialog open={enforced} dismissible={false} />
    </>
  );
}
