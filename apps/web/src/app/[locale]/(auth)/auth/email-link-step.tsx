'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { CodeInput, InfoStrip, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import type { EmailFlowMode } from '@/lib/auth/unified-auth-flow';
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
  /** The flow mode the send action resolved: 'signup' when GoTrue minted the
   * signup confirmation email ("Confirm your email"), anything else when the
   * email kind is unknown (the generic link copy, KRTX-2516's fail-open). */
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
  const tAuth = useTranslations('auth');
  // The copy must name the email the mailbox receives (KRTX-2195): a signup
  // gets the confirmation email, so "a link" read the mail as the wrong
  // message. Unknown mode keeps the generic link copy.
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
          description={t.rich(confirmed ? 'link.confirmDescription' : 'link.description', {
            email: sentEmail ?? '',
            address: (chunks) => (
              <span className="text-foreground font-medium wrap-break-word">{chunks}</span>
            ),
          })}
        />
      </m.div>

      <m.div {...rise(0.06)}>
        {info && <InfoStrip message={info} />}
        {errorMessage && <InfoBanner tone="destructive">{errorMessage}</InfoBanner>}

        {onCodeChange && onVerify && (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm">
              {tAuth('enterCode')}
            </summary>
            <form
              className="mt-4 space-y-5"
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
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={pending || !/^\d{6}$/.test(code ?? '')}
              >
                {pendingAction === 'continue' ? t('oneMoment') : t('continue')}
              </Button>
            </form>
          </details>
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
                className="text-foreground underline-offset-4 hover:underline disabled:opacity-50"
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
              className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline"
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
                  className="hover:text-foreground -my-2 py-2 underline-offset-4 transition-colors hover:underline disabled:opacity-50"
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
