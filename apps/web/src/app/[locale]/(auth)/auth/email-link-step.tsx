'use client';

import { InfoStrip, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { m, useReducedMotion } from 'motion/react';

const EASE = [0.23, 1, 0.32, 1] as const;

export function EmailLinkStep({
  sentEmail,
  info,
  resendIn,
  pending,
  pendingAction,
  passwordEnabled,
  onResend,
  onChangeEmail,
  onPassword,
}: {
  sentEmail: string | null;
  info: string | null;
  resendIn: number;
  pending: boolean;
  pendingAction: 'continue' | 'link' | 'resend' | 'password' | 'sso' | null;
  passwordEnabled: boolean;
  onResend: () => void;
  onChangeEmail: () => void;
  onPassword: () => void;
}) {
  const t = useTranslations('auth.unified');
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
          description={t.rich('link.description', {
            email: sentEmail ?? '',
            address: (chunks) => (
              <span className="text-foreground font-medium wrap-break-word">{chunks}</span>
            ),
          })}
        />
      </m.div>

      <m.div {...rise(0.06)}>
        {info && <InfoStrip message={info} />}

        <div className="text-muted-foreground mt-6 space-y-2 text-sm">
          <p>
            {t('link.notReceived')}{' '}
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
