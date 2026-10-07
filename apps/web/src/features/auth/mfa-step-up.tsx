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

import { ShieldWarningIcon as ShieldWarning } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { Kortix } from '@/features/icon/icons/kortix';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { invalidateTokenCache } from '@/lib/auth-token';
import { mfaChallengeRequired, supabaseMFAService } from '@/lib/supabase/mfa';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/providers/auth-provider';
import { MFA_AAL_QUERY_KEY, MFA_FACTORS_QUERY_KEY } from '@/hooks/account/use-mfa';
import { useTranslations } from '@/i18n/use-translations';

import { MFA_VERIFIED_EVENT, armPendingMfaAction, clearPendingMfaAction } from './mfa-pending-action';

export const MFA_REQUIRED_EVENT = 'kortix:mfa-required';
export { MFA_VERIFIED_EVENT };

/**
 * Run `action` now, or — while this session still owes a TOTP challenge — open
 * the step-up dialog first and run `action` once the code verifies. One action
 * is armed at a time (the latest wins) and cancelling the dialog drops it.
 */
export function requestMfaStepUp(challengeRequired: boolean, action: () => void): void {
  if (!challengeRequired) {
    action();
    return;
  }
  armPendingMfaAction(action);
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
  const t = useTranslations('mfaStepUp');
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
      successToast(t('verified'));
      setCode('');
      // Refetch active queries so reads that failed while the session was aal1
      // recover on their own — the screen the user was on repopulates without a
      // manual reload. (Mutations still need a manual retry; react-query dedupes
      // the refetch storm.)
      queryClient.invalidateQueries();
      onVerified?.();
      window.dispatchEvent(new CustomEvent(MFA_VERIFIED_EVENT));
    },
  });
  const canVerify = code.length === 6 && !verify.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !dismissible) return;
        if (!next) setCode('');
        onDismiss?.();
      }}
    >
      {/* Full screen: the challenge replaces the page instead of floating on a
          dimmed one. Radix still owns focus, Escape and the a11y tree. */}
      <DialogContent
        showOverlay={false}
        hideCloseButton
        className="bg-background inset-0 flex h-dvh max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-y-auto rounded-none border-0 p-6 shadow-none data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-none sm:rounded-none"
      >
        <Kortix className="absolute top-7 left-8 size-5" />
        <div className="flex w-full max-w-sm flex-col">
          <DialogTitle className="text-xl font-medium tracking-tight">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground mt-3 text-sm text-pretty">
            {dismissible ? t('actionDescription') : t('gateDescription')}
          </DialogDescription>

          {factorsQuery.isLoading ? (
            <div className="mt-8">
              <Loading className="size-4" />
            </div>
          ) : factor ? (
            <form
              className="mt-8 flex flex-col"
              onSubmit={(e) => {
                e.preventDefault();
                if (canVerify) verify.mutate();
              }}
            >
              <label htmlFor="mfa-code" className="text-sm font-medium">
                {t('codeLabel')}
              </label>
              <CodeCells
                code={code}
                invalid={verify.isError}
                onChange={(next) => {
                  if (verify.isError) verify.reset();
                  setCode(next);
                }}
              />
              {verify.isError ? (
                <p role="alert" className="text-destructive mt-2 text-sm">
                  {t('invalidCode')}
                </p>
              ) : null}
              <div className="border-border mt-10 flex items-center justify-between border-t pt-5">
                {dismissible ? (
                  <Button type="button" variant="ghost" onClick={() => onDismiss?.()}>
                    {t('cancel')}
                  </Button>
                ) : (
                  // Escape hatch for a lost authenticator: the same sign-out every
                  // in-app control runs. Without it the non-dismissible gate would be
                  // a lockout with no way back to /auth.
                  <Button type="button" variant="ghost" onClick={() => void performSignOut()}>
                    {t('signOut')}
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => {
                    if (canVerify) verify.mutate();
                  }}
                  disabled={!canVerify}
                  className="gap-1.5"
                >
                  {verify.isPending ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
                  {t('verify')}
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-8 flex flex-col gap-5">
              <InfoBanner tone="warning" icon={ShieldWarning} title={t('noFactorTitle')}>
                {t('noFactorDescription')}
              </InfoBanner>
              {dismissible ? (
                <Button type="button" variant="ghost" className="self-start" onClick={() => onDismiss?.()}>
                  {t('cancel')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="self-start"
                  onClick={() => void performSignOut()}
                >
                  {t('signOut')}
                </Button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const CELLS = [0, 1, 2, 3, 4, 5] as const;

/**
 * Six digit cells in two groups of three. One real input sits on top of them,
 * transparent, so typing, paste, and the OS one-time-code autofill all behave
 * like a plain text field; the cells only draw its value.
 */
function CodeCells({
  code,
  invalid,
  onChange,
}: {
  code: string;
  invalid: boolean;
  onChange: (code: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const active = focused ? Math.min(code.length, 5) : -1;
  const group = (cells: readonly number[]) => (
    <div
      className={cn(
        'flex overflow-hidden rounded-lg border transition-colors',
        invalid
          ? 'border-destructive'
          : cells.includes(active)
            ? 'border-foreground ring-border ring-3'
            : 'border-border',
      )}
    >
      {cells.map((i) => (
        <span
          key={i}
          className="border-border flex h-15 w-13 items-center justify-center border-r font-mono text-2xl last:border-r-0"
        >
          {code[i] ?? (i === active ? <span className="bg-foreground h-6 w-px animate-pulse motion-reduce:animate-none" /> : null)}
        </span>
      ))}
    </div>
  );

  return (
    <div className="relative mt-2 flex items-center gap-3 self-start">
      {group(CELLS.slice(0, 3))}
      <span aria-hidden className="bg-muted-foreground/60 h-px w-2.5" />
      {group(CELLS.slice(3))}
      <input
        id="mfa-code"
        value={code}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        autoFocus
        aria-invalid={invalid || undefined}
        className="absolute inset-0 cursor-text opacity-0"
      />
    </div>
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
        onDismiss={() => {
          clearPendingMfaAction();
          setOpen(false);
        }}
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
