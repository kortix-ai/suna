'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Plug } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Post-OAuth landing for connector 1-click connect (Pipedream). The connect
 * flow redirects here with `?connected=true` or `?error=true` once the user
 * authorizes the app. The connection is already finalized server-side — this
 * page just confirms it so the tab isn't a dead end.
 */
export default function ConnectorsPage() {
  return (
    <Suspense fallback={null}>
      <ConnectorResult />
    </Suspense>
  );
}

function ConnectorResult() {
  const router = useRouter();
  const params = useSearchParams();
  const ok = params.get('connected') === 'true';
  const failed = params.get('error') === 'true';
  const state: 'connected' | 'error' = failed && !ok ? 'error' : 'connected';

  const Icon = state === 'connected' ? CheckCircle2 : AlertCircle;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-border bg-muted/40">
          {state === 'connected' ? (
            <Icon className="h-6 w-6 text-emerald-600" />
          ) : (
            <Icon className="h-6 w-6 text-destructive" />
          )}
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {state === 'connected' ? 'Connector connected' : 'Connection failed'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {state === 'connected'
              ? 'Authorized. You can close this tab and return to where you started — your agent can use this integration now.'
              : "The authorization didn't complete. Close this tab and start the connect again from your terminal or the dashboard."}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" className="gap-1.5" onClick={() => window.close()}>
            <Plug className="h-4 w-4" />
            Close window
          </Button>
          <Button variant="ghost" onClick={() => router.replace('/projects')}>
            Go to projects
          </Button>
        </div>
      </div>
    </div>
  );
}
