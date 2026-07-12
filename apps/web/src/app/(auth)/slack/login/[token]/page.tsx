'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/features/icon/icon';
import { useAuth } from '@/features/providers/auth-provider';
import { slackIdentityApi } from '@/lib/api/slack-identity';

/**
 * Slack `/login` bind page. The bot DMs the user a link to
 * `/slack/login/<token>`; the token is a short-lived signed payload carrying
 * the Slack workspace + user id. This page requires a normal Kortix login, then
 * POSTs the token (with the user's bearer) to the API, which binds the Slack
 * user to this Kortix account so the agent runs as THEM — not the installer.
 */
type Phase = 'idle' | 'binding' | 'success' | 'error';

export default function SlackLoginPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [hasAccess, setHasAccess] = useState(true);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      const target = `/slack/login/${token}`;
      router.replace(`/auth?redirect=${encodeURIComponent(target)}`);
    }
  }, [isLoading, user, token, router]);

  if (isLoading || !user) {
    return (
      <Centered>
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </Centered>
    );
  }

  if (!token) {
    return (
      <Centered>
        <ResultCard
          ok={false}
          title="Missing link"
          message="This page is opened from a Kortix Slack message. Run `/kortix login` in Slack to get a fresh link."
        />
      </Centered>
    );
  }

  async function connect() {
    setPhase('binding');
    setError(null);
    try {
      const res = await slackIdentityApi.bind(token);
      setWorkspaceName(res.workspaceName);
      setResumed(res.resumed);
      setHasAccess(res.hasAccess);
      setPhase('success');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }

  if (phase === 'success') {
    return (
      <Centered>
        <ResultCard
          ok
          title="Slack connected"
          message={
            !hasAccess
              ? `Your Kortix account is connected${workspaceName ? ` in ${workspaceName}` : ''}. Head back to Slack and request project access to continue.`
              : resumed
                ? `Your Kortix account is connected${workspaceName ? ` in ${workspaceName}` : ''}. Kortix is picking up your Slack message now.`
                : `Your Kortix account is connected${workspaceName ? ` in ${workspaceName}` : ''}. Head back to Slack and mention Kortix with a task.`
          }
        />
      </Centered>
    );
  }

  const busy = phase === 'binding';
  return (
    <Centered>
      <div className="bg-background rounded-md border shadow-sm">
        <div className="p-7">
          <div className="mb-6 flex items-center gap-3">
            <div className="bg-muted/40 grid size-11 place-items-center rounded-sm border">
              <Icon.Slack className="size-5" />
            </div>
            <div>
              <div className="text-base font-semibold">Connect Slack to Kortix</div>
              <div className="text-muted-foreground text-xs">kortix.com · Slack</div>
            </div>
          </div>

          <p className="text-muted-foreground text-sm">
            Connect or create a Kortix account so the Slack bot can run as <strong className="text-foreground">you</strong> —
            using your own credentials, secrets, and connected apps instead of the installer&apos;s.
          </p>

          <dl className="bg-muted/30 mt-5 space-y-2 rounded-md border p-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Kortix account</dt>
              <dd className="truncate font-mono text-xs">{user.email ?? 'You'}</dd>
            </div>
          </dl>

          {phase === 'error' && error && (
            <div className="border-destructive bg-destructive/5 text-destructive mt-5 flex items-start gap-2 rounded-md border p-3 text-sm">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between gap-3">
            <Link href="/" className="text-muted-foreground text-sm underline-offset-4 hover:underline">
              Cancel
            </Link>
            <Button onClick={connect} disabled={busy} size="lg">
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Connecting…
                </>
              ) : (
                <>
                  <Icon.Slack className="size-4" /> Connect account
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="bg-muted/30 text-muted-foreground border-t px-7 py-3 text-xs">
          You can disconnect anytime with <strong className="text-foreground">/kortix logout</strong> in Slack.
        </div>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted/30 flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function ResultCard({ ok, title, message }: { ok: boolean; title: string; message: string }) {
  return (
    <div className="bg-background rounded-md border p-7 text-center shadow-sm">
      <div
        className={
          ok
            ? 'mx-auto grid size-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : 'bg-destructive/10 text-destructive mx-auto grid size-12 place-items-center rounded-full'
        }
      >
        {ok ? <CheckCircle2 className="size-6" /> : <XCircle className="size-6" />}
      </div>
      <div className="mt-4 text-base font-semibold">{title}</div>
      <p className="text-muted-foreground mt-1 text-sm">{message}</p>
    </div>
  );
}
