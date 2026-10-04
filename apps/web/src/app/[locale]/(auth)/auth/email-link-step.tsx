'use client';

import { InfoStrip, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';

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
  return (
    <>
      <Rise>
        <StepHeader
          title={t('link.title')}
          description={t.rich('link.description', {
            email: sentEmail ?? '',
            address: (chunks) => (
              <span className="text-foreground font-medium wrap-break-word">{chunks}</span>
            ),
          })}
        />
      </Rise>

      <Rise delay={0.06}>
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
      </Rise>
    </>
  );
}
