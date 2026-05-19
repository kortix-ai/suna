'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Github, Loader2 } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Button } from '@/components/ui/button';
import { saveGitHubInstallation } from '@/lib/projects-client';

export default function GitHubSetupPage() {
  return (
    <Suspense fallback={<ConnectingScreen forceConnecting minimal title="Connecting GitHub" />}>
      <GitHubSetup />
    </Suspense>
  );
}

function GitHubSetup() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const [state, setState] = useState<'saving' | 'done' | 'error'>('saving');
  const [message, setMessage] = useState('Connecting GitHub...');

  const installState = searchParams.get('state') || '';
  const installationId = searchParams.get('installation_id') || '';
  const setupAction = searchParams.get('setup_action') || '';

  useEffect(() => {
    if (!isLoading && !user) {
      const currentUrl = new URL(window.location.href);
      router.replace(`/auth?returnUrl=${encodeURIComponent(currentUrl.pathname + currentUrl.search)}`);
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (isLoading || !user) return;

    if (setupAction === 'uninstall') {
      setState('done');
      setMessage('GitHub App removed');
      window.setTimeout(() => router.replace('/projects'), 900);
      return;
    }

    if (!installState || !installationId) {
      setState('error');
      setMessage('GitHub did not return the installation details.');
      return;
    }

    let cancelled = false;
    saveGitHubInstallation({
      state: installState,
      installation_id: installationId,
    })
      .then((status) => {
        if (cancelled) return;
        setState('done');
        setMessage(status.owner_login ? `Connected ${status.owner_login}` : 'GitHub connected');
        window.setTimeout(() => router.replace('/projects?new=1'), 900);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState('error');
        setMessage(error.message || 'Failed to save the GitHub installation.');
      });

    return () => {
      cancelled = true;
    };
  }, [installState, installationId, isLoading, router, setupAction, user]);

  if (isLoading || !user) {
    return <ConnectingScreen forceConnecting minimal title="Connecting GitHub" />;
  }

  const Icon = state === 'saving' ? Loader2 : state === 'done' ? CheckCircle2 : AlertCircle;

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-border bg-muted/40">
          {state === 'saving' ? (
            <Icon className="h-6 w-6 animate-spin text-muted-foreground" />
          ) : state === 'done' ? (
            <Icon className="h-6 w-6 text-emerald-600" />
          ) : (
            <Icon className="h-6 w-6 text-destructive" />
          )}
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">GitHub setup</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        {state === 'error' ? (
          <Button onClick={() => router.replace('/projects')} className="gap-1.5">
            <Github className="h-4 w-4" />
            Back to projects
          </Button>
        ) : null}
      </div>
    </div>
  );
}
