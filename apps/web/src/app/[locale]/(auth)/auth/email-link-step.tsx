'use client';

import { useTranslations } from '@/i18n/use-translations';
import type { EmailFlowMode } from '@/lib/auth/unified-auth-flow';
import { Button } from '@kortix/ui/button';
import {
  CodeInput,
  FieldError,
  InfoStrip,
  StepHeader,
} from '@kortix/ui/internal/auth/auth-primitives';
import { m, useReducedMotion } from 'motion/react';

const EASE = [0.23, 1, 0.32, 1] as const;

export function EmailLinkStep({
  sentEmail,
  errorMessage,
  info,
  resendIn,
  pending,
  pendingAction,
  passwordEnabled,
  /** The flow mode the send action resolved: 'signup' names the signup
   * confirmation email GoTrue minted; 'unknown' the send whose email kind
   * only the mailbox knows (sign-in link or confirmation, KRTX-3504 — the
   * API no longer says which); 'closed' a sign-in-only send that reaches the
   * mailbox only when the account exists. Anything else keeps the generic
   * link copy (KRTX-2516's fail-open). */
  mode,
  onResend,
  onChangeEmail,
  onPassword,
  code,
  onCodeChange,
  onVerify,
}: {
  sentEmail: string | null;
  errorMessage: string | null;
  info: string | null;
  resendIn: number;
  pending: boolean;
  pendingAction: 'continue' | 'link' | 'resend' | 'password' | 'sso' | null;
  passwordEnabled: boolean;
  mode?: EmailFlowMode;
  onResend: () => void;
  onChangeEmail: () => void;
  onPassword: () => void;
  code?: string;
  onCodeChange?: (value: string) => void;
  onVerify?: () => void;
}) {
  const t = useTranslations('auth.unified');
  // The copy must name the email the mailbox receives (KRTX-2195): a signup
  // gets the confirmation email, so "a link" read the mail as the wrong
  // message. KRTX-3504: the API no longer says whether the address holds an
  // account, so an eligible send ('unknown') reaches mailboxes as EITHER kind
  // — the copy names both; a closed-signup send ('closed') mails a sign-in
  // link only when the account exists — the copy claims nothing more. Any
  // other mode keeps the generic link copy (KRTX-2516's fail-open).
  const descriptionKey =
    mode === 'unknown'
      ? 'link.unknownDescription'
      : mode === 'closed'
        ? 'link.closedDescription'
        : 'link.description';
  const confirmed = mode === 'signup';
  const prefersReducedMotion = useReducedMotion();
  const rise = (delay = 0) => ({
    initial: { opacity: 0, y: prefersReducedMotion ? 0 : 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, delay, ease: EASE },
  });
  return (
    <>
      <m.div {...rise(0)}>
        <StepHeader
          title={t('link.title')}
          description={t.rich(confirmed ? 'link.confirmDescription' : descriptionKey, {
            email: sentEmail ?? '',
            address: (chunks) => (
              <span className="text-foreground font-medium wrap-break-word">{chunks}</span>
            ),
          })}
        />
      </m.div>

      <m.div {...rise(0.06)}>
        {info && <InfoStrip message={info} />}

        {onCodeChange && onVerify && (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              onVerify();
            }}
          >
            <CodeInput
              value={code ?? ''}
              onChange={onCodeChange}
              disabled={pending}
              invalid={!!errorMessage}
            />
            {errorMessage && <FieldError id="code-error" message={errorMessage} />}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={pending || !/^\d{6}$/.test(code ?? '')}
            >
              {pendingAction === 'continue' ? t('oneMoment') : t('continue')}
            </Button>
          </form>
        )}
        {errorMessage && !(onCodeChange && onVerify) && (
          <FieldError id="code-error" message={errorMessage} />
        )}

        <div className="text-muted-foreground mt-6 space-y-2 text-sm">
          <p>
            {confirmed ? t('link.confirmNotReceived') : t('link.notReceived')}{' '}
            {resendIn > 0 ? (
              <span className="tabular-nums">{t('link.resendIn', { seconds: resendIn })}</span>
            ) : (
              <button
                type="button"
                onClick={onResend}
                disabled={pending}
                className="text-foreground disabled:opacity-50"
              >
                {pendingAction === 'resend' ? t('sending') : t('link.resend')}
              </button>
            )}
          </p>
          <p className="flex items-center gap-2">
            <button
              type="button"
              onClick={onChangeEmail}
              disabled={pending}
              className="hover:text-foreground -my-2 py-2 transition-colors"
            >
              {t('useDifferentEmail')}
            </button>
            {passwordEnabled && (
              <>
                <span aria-hidden className="text-muted-foreground select-none">
                  ·
                </span>
                <button
                  type="button"
                  onClick={onPassword}
                  disabled={pending}
                  className="hover:text-foreground -my-2 py-2 transition-colors disabled:opacity-50"
                >
                  {pendingAction === 'password' ? t('oneMoment') : t('usePasswordInstead')}
                </button>
              </>
            )}
          </p>
        </div>
      </m.div>
    </>
  );
}
