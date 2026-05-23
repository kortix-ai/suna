'use client';

import { useTranslations } from 'next-intl';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, Slack } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { ChannelsDialog } from '@/components/channels/channels-dialog';
import { useSlackInstall } from '@/hooks/channels/use-channels-installations';

export default function ProjectChannelsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? null;
  return <ChannelsView projectId={projectId} />;
}

export function ChannelsView({ projectId }: { projectId: string | null }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
            <Skeleton className="h-28 w-full rounded-2xl" />
          ) : install ? (
            <div className="space-y-4">
              <InfoBanner
                tone="success"
                icon={Check}
                title={`Connected to ${install.workspaceName ?? install.workspaceId}`}
                action={
                  <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                    Manage
                  </Button>
                }
              >
                Bot <code className="font-mono">{install.botUserId ?? '—'}</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line45JsxTextTeam')}{' '}
                <code className="font-mono">{install.workspaceId}</code>
              </InfoBanner>

              <div className="rounded-2xl border border-border/60 bg-card p-4">
                <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line50JsxTextEnableTheBotForThisProject')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line52JsxTextAddA')}<code className="font-mono text-xs">[[channels]]</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line52JsxTextEntryWith')}{' '}
                  <code className="font-mono text-xs">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line53JsxTextPlatformSlack')}</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line53JsxTextToThisProjectS')}{' '}
                  <code className="font-mono text-xs">kortix.toml</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line54JsxTextInviteTheBotToAnyChannelInYour')}<code className="font-mono text-xs">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line55JsxTextKortix')}</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line55JsxTextItLlRespondThere')}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-2xl border border-border/70 bg-card p-5">
                <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line63JsxTextSlackIsnTConnectedYet')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line65JsxTextConnectASlackWorkspaceToThisProjectTokens')}</p>
                <div className="mt-4">
                  <Button onClick={() => setOpen(true)} className="gap-2">
                    <Slack className="h-4 w-4" />{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line70JsxTextConnectSlack')}</Button>
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
