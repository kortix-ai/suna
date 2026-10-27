'use client';

/**
 * Sign-in for the Kortix in Chrome side panel.
 *
 * The extension frames this page. The panel has no session of its own and a
 * password form does not belong in a side panel, so the page asks the
 * extension for a one-time token (`kortix.panel.needSession`), trades it for a
 * session in the panel's partitioned cookie, and opens `next`.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import Loading from '@kortix/ui/loading';
import { KortixLogo } from '@kortix/ui/kortix-logo';
import { useTranslations } from '@/i18n/use-translations';
import { createClient } from '@/lib/supabase/client';
import { isInExtensionPanel, safePanelNext } from '@/lib/supabase/panel-cookies';

import { startPanelHandshake } from './panel-handshake';

/** The extension answers in well under a second. Past this, it is not coming. */
const SESSION_TIMEOUT_MS = 15_000;

function PanelSignIn() {
  const t = useTranslations('auth.panel');
  const params = useSearchParams();
  const next = safePanelNext(params.get('next'));
  const switchAccount = params.get('switch') === '1';
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Outside the panel nobody can answer: fail on the next tick.
    if (!isInExtensionPanel()) {
      const timer = window.setTimeout(() => setFailed(true), 0);
      return () => window.clearTimeout(timer);
    }
    let done = false;
    return startPanelHandshake({
      auth: createClient().auth,
      win: window,
      switchAccount,
      timeoutMs: SESSION_TIMEOUT_MS,
      finish: (ok) => {
        if (done) return;
        done = true;
        if (ok) window.location.replace(next);
        else setFailed(true);
      },
    });
  }, [next, switchAccount]);

  return (
    <main className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
      <KortixLogo variant="icon" size={22} className="text-foreground" />
      <div className="max-w-[280px]" role="status" aria-live="polite">
        <h1 className="text-foreground text-base font-medium text-balance">
          {failed ? t('errorTitle') : t('waitingTitle')}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm text-pretty">
          {failed ? t('errorBody') : t('waitingBody')}
        </p>
      </div>
      {failed ? (
        // A new tab: inside the panel, /auth hands straight back to this page.
        <Link
          href={`/auth?redirect=${encodeURIComponent(next)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground text-sm underline underline-offset-4"
        >
          {t('signIn')}
        </Link>
      ) : (
        <Loading className="text-muted-foreground size-4" />
      )}
    </main>
  );
}

export default function PanelSignInPage() {
  return (
    <Suspense fallback={null}>
      <PanelSignIn />
    </Suspense>
  );
}
