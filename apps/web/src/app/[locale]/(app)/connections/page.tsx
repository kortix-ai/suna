'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

import { Button } from '@kortix/ui/button';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { OutcomeTitle } from '@kortix/ui/internal/auth/auth-consent';
import { Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import { isConnectorsEnabled } from '@/lib/config';
import { useAppHome } from '@kortix/ui/internal/lib/onboarding/use-app-home';

/**
 * `/connections` is the post-OAuth landing for Pipedream connector setup. The connect
 * flow redirects here with `?connected=true` or `?error=true` once the user
 * authorizes the app. The connection is already finalized server-side — this
 * page just confirms it so the tab isn't a dead end.
 *
 * Self-host without Pipedream configured never initiates this OAuth flow, so
 * this route should never legitimately be hit there — but guard it anyway
 * (a stale bookmark/link) by bouncing to /projects instead of confirming a
 * "connection" for a feature that isn't enabled.
 */
export default function ConnectionsPage() {
  return (
    <Suspense fallback={null}>
      <ConnectionResult />
    </Suspense>
  );
}

function ConnectionResult() {
  const appHome = useAppHome();
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const router = useRouter();
  const params = useSearchParams();
  const connectorsEnabled = isConnectorsEnabled();

  useEffect(() => {
    if (!connectorsEnabled) router.replace(appHome);
  }, [appHome, connectorsEnabled, router]);

  const ok = params.get('connected') === 'true';
  const failed = params.get('error') === 'true';
  const connected = !(failed && !ok);

  if (!connectorsEnabled) return null;

  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <StepHeader
          title={
            <OutcomeTitle tone={connected ? 'success' : 'destructive'}>
              {connected
                ? tI18nHardcoded.raw('i18nComplete.text3f45cbce573b')
                : tI18nHardcoded.raw('i18nComplete.text596c52f1eb65')}
            </OutcomeTitle>
          }
          description={
            connected
              ? tI18nHardcoded.raw('i18nComplete.text6257cc52416f')
              : tI18nHardcoded.raw('i18nComplete.text380ded41df15')
          }
        />
      </Rise>
      <Rise delay={0.06} className="space-y-3">
        <Button size="lg" className="w-full" onClick={() => window.close()}>
          {tI18nHardcoded.raw('autoAppAppConnectorsPageJsxTextCloseWindowa183ed6a')}
        </Button>
        <Button
          size="lg"
          variant="secondary"
          className="w-full"
          onClick={() => router.replace(appHome)}
        >
          {tI18nHardcoded.raw('autoAppAppConnectorsPageJsxTextGoToProjectsfb39e5ad')}
        </Button>
      </Rise>
    </AuthFrame>
  );
}
