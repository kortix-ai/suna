'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, Slack } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChannelsDialog } from '@/components/channels/channels-dialog';
import { useSlackInstall } from '@/hooks/channels/use-channels-installations';

export default function ProjectChannelsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? null;
  const [open, setOpen] = useState(false);
  const { data: install, isLoading } = useSlackInstall(projectId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Slack className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Channels</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-8">
          {isLoading ? (
            <Skeleton className="h-28 w-full rounded-lg" />
          ) : install ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15">
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    Connected to {install.workspaceName ?? install.workspaceId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Bot <code className="font-mono">{install.botUserId ?? '—'}</code> · team{' '}
                    <code className="font-mono">{install.workspaceId}</code>
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                  Manage
                </Button>
              </div>

              <div className="rounded-lg border border-border/60 bg-card p-4">
                <p className="text-sm font-medium text-foreground">Bind a channel</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add a <code className="font-mono text-xs">[[channels]]</code> entry to this project's{' '}
                  <code className="font-mono text-xs">kortix.toml</code> with{' '}
                  <code className="font-mono text-xs">platform = "slack"</code> and a{' '}
                  <code className="font-mono text-xs">channel_id</code>, then{' '}
                  <code className="font-mono text-xs">@kortix</code> in that Slack channel.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-border/70 bg-card p-5">
                <p className="text-sm font-medium text-foreground">Slack isn't connected yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Connect a Slack workspace to this project. Tokens are stored encrypted in this project's
                  secrets manager — no env vars required.
                </p>
                <div className="mt-4">
                  <Button onClick={() => setOpen(true)} className="gap-2">
                    <Slack className="h-4 w-4" /> Connect Slack
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <ChannelsDialog open={open} onOpenChange={setOpen} projectId={projectId} />
    </div>
  );
}
