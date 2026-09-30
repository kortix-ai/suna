'use client';

/**
 * What the preview hand-off shows (`/preview/authorize`). The page used to be a
 * bare spinner, then a redirect, so nobody could tell which preview was opening
 * or that they were being signed in to it.
 *
 * Three states, one column: opening, the address is not a preview this
 * deployment serves, the session expired. No fetching here, so each renders in
 * a test.
 */

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { DetailPanel, DetailRow } from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';

export type PreviewAuthorizeState = 'opening' | 'not-served' | 'expired';

/**
 * The part of `to` worth showing: its host, plus the path when it is not a
 * preview (the path is then what tells the reader where the link pointed).
 * `to` is attacker-controllable; it is only ever rendered as text.
 */
export function previewAddress(to: string, withPath: boolean): string {
  try {
    const url = new URL(to);
    const path = withPath && url.pathname !== '/' ? url.pathname : '';
    return `${url.host}${path}`;
  } catch {
    return to.trim();
  }
}

export function PreviewAuthorizeView({
  state,
  to,
  email,
  onSignInAgain,
}: {
  state: PreviewAuthorizeState;
  /** The `?to=` address, as given. */
  to: string;
  email: string | null;
  onSignInAgain: () => void;
}) {
  const t = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const address = previewAddress(to, state === 'not-served');

  if (state === 'opening') {
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={t('previewAuthorize.openingTitle')}
            description={t('previewAuthorize.openingDescription')}
          />
        </Rise>
        <Rise delay={0.06}>
          <DetailPanel>
            <DetailRow label={t('previewAuthorize.preview')} value={address} mono />
            {email ? (
              <DetailRow label={tI18nComplete.raw('text7e1b0d5641f2')} value={email} />
            ) : null}
          </DetailPanel>
          <div role="status" className="text-muted-foreground mt-5 flex items-center gap-2 text-sm">
            <Loading className="size-4 shrink-0" />
            <span>{t('previewAuthorize.signingIn')}</span>
          </div>
        </Rise>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <StepHeader
          title={tI18nComplete.raw('text4ce7b95988e3')}
          description={t(
            state === 'expired' ? 'previewAuthorize.sessionExpired' : 'previewAuthorize.notServed',
          )}
        />
      </Rise>
      <Rise delay={0.06}>
        {address ? (
          <DetailPanel>
            <DetailRow
              label={t(
                state === 'expired' ? 'previewAuthorize.preview' : 'previewAuthorize.address',
              )}
              value={address}
              mono
            />
          </DetailPanel>
        ) : null}
        {state === 'expired' ? (
          <Button size="lg" className="mt-5 w-full" onClick={onSignInAgain}>
            {t('previewAuthorize.signInAgain')}
          </Button>
        ) : null}
      </Rise>
    </AuthFrame>
  );
}
