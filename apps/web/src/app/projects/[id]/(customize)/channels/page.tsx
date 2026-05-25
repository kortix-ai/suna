'use client';

import { useTranslations } from 'next-intl';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, Slack } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChannelsDialog } from '@/components/channels/channels-dialog';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
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
      <CustomizeSectionHeader icon={Slack} title="Channels" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8">
          <header className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">Channels</h2>
            <p className="text-xs text-muted-foreground">
              Run this project from chat — connect a Slack workspace and your
              agent responds in the channels you invite it to.
            </p>
          </header>

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

              <SectionCard title={tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line50JsxTextEnableTheBotForThisProject')}>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line52JsxTextAddA')}<code className="font-mono text-xs">[[channels]]</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line52JsxTextEntryWith')}{' '}
                  <code className="font-mono text-xs">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line53JsxTextPlatformSlack')}</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line53JsxTextToThisProjectS')}{' '}
                  <code className="font-mono text-xs">kortix.toml</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line54JsxTextInviteTheBotToAnyChannelInYour')}<code className="font-mono text-xs">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line55JsxTextKortix')}</code>{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line55JsxTextItLlRespondThere')}</p>
              </SectionCard>
            </div>
          ) : (
            <SectionCard
              title={tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line63JsxTextSlackIsnTConnectedYet')}
              action={
                <Button onClick={() => setOpen(true)} size="sm" className="gap-2">
                  <Slack className="h-4 w-4" />{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line70JsxTextConnectSlack')}</Button>
              }
            >
              <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeChannelsPage.line65JsxTextConnectASlackWorkspaceToThisProjectTokens')}</p>
            </SectionCard>
          )}
        </div>
      </div>

      <ChannelsDialog open={open} onOpenChange={setOpen} projectId={projectId} />
    </div>
  );
}
