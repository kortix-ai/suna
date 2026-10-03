'use client';

/**
 * The TOTP challenge — the gate between a first-factor sign-in and the app.
 *
 * The sign-in completions (the auth callback route and the password server
 * actions) land a session that has a verified authenticator-app factor here
 * instead of the app, and the middleware holds every app path behind this
 * page while the challenge is pending. The magic link or password proves the
 * mailbox, not the second factor.
 *
 * One verified TOTP factor is challenged; `challengeAndVerify` pairs a fresh
 * challenge with every attempt, so a failed code never leaves a stale
 * challenge behind. A recovery code entered here verifies the same way.
 *
 * A session whose factor list has NO verified TOTP factor continues
 * immediately: the pending flag outlived its factor (removed on another
 * device), and a challenge with nothing to verify is a trap. A list that
 * failed to LOAD is an error with a retry — never a continue.
 */

import { Button } from '@/components/ui/button';
import { AuthMobileLogo, CodeInput, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { invalidateTokenCache } from '@/lib/auth-token';
import {
  clearMfaPendingCookieClient,
  hasVerifiedTotpFactor,
  pickVerifiedTotpFactor,
} from '@/lib/auth/mfa-challenge';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';
import { useAppHome } from '@/lib/onboarding/use-app-home';
import { type FactorInfo, supabaseMFAService } from '@/lib/supabase/mfa';
import { SignOutIcon as LogOut } from '@phosphor-icons/react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

function MfaChallengeContent() {
  const t = useTranslations('auth.mfaChallenge');
  const searchParams = useSearchParams();
  const appHome = useAppHome();

  const returnUrl = sanitizeAuthReturnUrl(searchParams.get('returnUrl'));
  const destination = returnUrl || appHome;

  // The destination resolves after `useAuth()` hydrates; the load effect and
  // the success handler both fire against the latest value through the ref.
  const destinationRef = useRef(destination);
  destinationRef.current = destination;

  const proceed = () => {
    clearMfaPendingCookieClient();
    // A HARD navigation: the app must mount fresh on the aal2 session this
    // verification just minted (token caches, query caches).
    window.location.assign(destinationRef.current);
  };

  const [factors, setFactors] = useState<FactorInfo[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const loadFactors = useCallback(async () => {
    setLoadError(false);
    try {
      const { factors: all } = await supabaseMFAService.listFactors();
      setFactors(all);
      if (!hasVerifiedTotpFactor({ factors: all })) {
        // Nothing to challenge — the pending flag is stale. Continue instead
        // of trapping the session on a page it can never pass.
        clearMfaPendingCookieClient();
        window.location.assign(destinationRef.current);
      }
    } catch {
      setLoadError(true);
    }
  }, []);

  // Runs once per mount; the destination is read through the ref.
  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  const factor = factors ? pickVerifiedTotpFactor(factors) : null;

  const verify = async () => {
    if (!factor || code.length !== 6 || verifying) return;
    setVerifying(true);
    setInvalid(false);
    try {
      await supabaseMFAService.challengeAndVerify({ factor_id: factor.id, code });
      // The verification minted an aal2 session token into Supabase storage.
      // Bust the api-client's 30s token cache so the destination mounts on
      // the elevated token instead of replaying the aal1 one.
      invalidateTokenCache();
      proceed();
    } catch {
      // Wrong code (or an expired challenge): every attempt pairs a fresh
      // challenge, so the next submit starts clean.
      setInvalid(true);
      setCode('');
    } finally {
      setVerifying(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await performSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="bg-background relative flex min-h-svh flex-col">
      <AuthMobileLogo />
      <div className="kx-below-titlebar absolute top-6 right-6 z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          className="text-muted-foreground hover:text-foreground gap-2"
        >
          <LogOut className="size-4" />
          <span className="hidden sm:inline">{t('signOut')}</span>
        </Button>
      </div>

      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
        <div className="w-full max-w-[380px]">
          <Rise>
            <StepHeader title={t('title')} description={t('description')} />
          </Rise>

          <Rise delay={0.06}>
            {loadError ? (
              <div className="space-y-3">
                <p className="text-destructive text-sm">{t('loadFailed')}</p>
                <Button variant="secondary" size="sm" onClick={() => void loadFactors()}>
                  {t('retry')}
                </Button>
              </div>
            ) : factor ? (
              <div className="space-y-4">
                <CodeInput value={code} onChange={setCode} invalid={invalid} />
                {invalid && <p className="text-destructive text-sm">{t('invalidCode')}</p>}
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => void verify()}
                  disabled={code.length !== 6 || verifying}
                >
                  {verifying ? t('verifying') : t('verify')}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{t('loading')}</p>
            )}
          </Rise>
        </div>
      </main>
    </div>
  );
}

export default function MfaChallengePage() {
  return (
    <Suspense fallback={<div className="bg-background min-h-svh" />}>
      <MfaChallengeContent />
    </Suspense>
  );
}
