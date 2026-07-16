'use client';

/**
 * Shared connect-account surface for chat identity binding (Slack, Teams).
 * The bot DMs the user a short-lived signed link; after a normal Kortix
 * login this page POSTs the token so the bot runs as the signed-in user
 * instead of the workspace installer.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import {
  AuthPendingScreen,
  AuthStatusScreen,
  DetailPanel,
  DetailRow,
} from '@/features/auth/auth-consent';
import { ErrorStrip, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';

interface BindResult {
  workspaceName?: string | null;
  resumed: boolean;
  hasAccess: boolean;
}

type Phase = 'idle' | 'binding' | 'success' | 'error';

export function ChatIdentityConnect({
  service,
  token,
  loginPath,
  bind,
  missingLinkMessage,
  disconnectNote,
}: {
  /** Display name used in titles and success copy ("Slack", "Teams"). */
  service: string;
  token: string;
  /** Path back to this page, used as the sign-in redirect target. */
  loginPath: string;
  bind: (token: string) => Promise<BindResult>;
  missingLinkMessage: string;
  /** Small note under the actions ("disconnect anytime with …"). */
  disconnectNote: React.ReactNode;
}) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BindResult | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace(`/auth?redirect=${encodeURIComponent(loginPath)}`);
    }
  }, [isLoading, user, loginPath, router]);

  if (isLoading || !user) {
    return <AuthPendingScreen />;
  }

  if (!token) {
    return (
      <AuthStatusScreen title={`Open this page from ${service}`} description={missingLinkMessage} />
    );
  }

  async function connect() {
    setPhase('binding');
    setError(null);
    try {
      setResult(await bind(token));
      setPhase('success');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }

  if (phase === 'success') {
    const workspace = result?.workspaceName ? ` in ${result.workspaceName}` : '';
    return (
      <AuthStatusScreen
        title={`${service} connected`}
        description={
          !result?.hasAccess
            ? `Your Kortix account is connected${workspace}. Head back to ${service} and request project access to continue.`
            : result?.resumed
              ? `Your Kortix account is connected${workspace}. Kortix is picking up your ${service} message now.`
              : `Your Kortix account is connected${workspace}. Head back to ${service} and mention Kortix with a task.`
        }
      />
    );
  }

  const busy = phase === 'binding';

  return (
    <AuthFrame>
      <Rise>
        <StepHeader
          title={`Connect ${service} to Kortix`}
          description={`The Kortix bot in ${service} will run as you, with your own credentials, secrets, and connected apps instead of the installer's.`}
        />
      </Rise>

      <Rise delay={0.06}>
        {phase === 'error' && error ? <ErrorStrip message={error} /> : null}

        <DetailPanel>
          <DetailRow label="Account" value={user.email ?? 'You'} />
        </DetailPanel>

        <Button size="lg" className="mt-5 w-full" onClick={connect} disabled={busy}>
          {busy ? <Loading className="size-4 shrink-0" /> : null}
          Connect account
        </Button>

        <div className="text-muted-foreground mt-8 space-y-2 text-sm">
          <p>{disconnectNote}</p>
          <p>
            <Link
              href="/"
              className="hover:text-foreground -my-2 inline-block py-2 underline-offset-4 transition-colors hover:underline"
            >
              Cancel
            </Link>
          </p>
        </div>
      </Rise>
    </AuthFrame>
  );
}
