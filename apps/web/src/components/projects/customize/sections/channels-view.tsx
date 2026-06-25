'use client';

import { useQuery } from '@tanstack/react-query';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useEmailInstall,
  useSlackInstall,
  type EmailInstallation,
  type SlackInstallation,
} from '@/hooks/channels/use-channels-installations';
import { getProject } from '@/lib/projects-client';
import { useCustomizeStore } from '@/stores/customize-store';
import { ArrowRight, Check, Mail, MessageSquare, Plug, Slack, type LucideIcon } from 'lucide-react';

export function ChannelsView({ projectId }: { projectId: string | null }) {
  const setSection = useCustomizeStore((s) => s.setSection);
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
  const emailChannelEnabled = projectQuery.data?.experimental?.agentmail_email === true;
  const { data: slackInstall, isLoading: loadingSlack } = useSlackInstall(projectId);
  const { data: emailInstall, isLoading: loadingEmail } = useEmailInstall(
    emailChannelEnabled ? projectId : null,
  );
  const loading = loadingSlack || projectQuery.isLoading || (emailChannelEnabled && loadingEmail);

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionHeader icon={MessageSquare} title="Channels" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8">
          <header className="space-y-1">
            <h2 className="text-foreground text-base font-semibold">Channels</h2>
            <p className="text-muted-foreground text-xs">
              {emailChannelEnabled
                ? 'Slack, Email, and future channel accounts are connector profiles. Configure the profile, name, sharing, and permissions in Connectors.'
                : 'Slack and future channel accounts are connector profiles. Configure the profile, name, sharing, and permissions in Connectors.'}
            </p>
          </header>

          {!projectId ? (
            <InfoBanner tone="neutral">Open a project before configuring channels.</InfoBanner>
          ) : loading ? (
            <Skeleton className="h-40 w-full rounded-2xl" />
          ) : (
            <SectionCard
              title="Manage channels in Connectors"
              description="Add a channel, connect the provider, then assign that profile to agents and permissions from one place."
              action={
                <Button size="sm" className="gap-1.5" onClick={() => setSection('connectors')}>
                  <Plug className="h-4 w-4" />
                  Open Connectors
                </Button>
              }
            >
              <div className="divide-border/60 -mx-6 -my-5 divide-y">
                <ChannelStatusRow
                  icon={Slack}
                  name="Slack"
                  install={slackInstall}
                  status={
                    slackInstall
                      ? slackInstall.workspaceName || slackInstall.workspaceId
                      : 'Not connected'
                  }
                />
                {emailChannelEnabled && (
                  <ChannelStatusRow
                    icon={Mail}
                    name="Email"
                    install={emailInstall}
                    status={emailInstall ? emailInstall.email : 'Not connected'}
                  />
                )}
              </div>
              <InfoBanner
                className="mt-5"
                tone="info"
                icon={ArrowRight}
                action={
                  <Button size="sm" variant="outline" onClick={() => setSection('connectors')}>
                    Add channel
                  </Button>
                }
              >
                {emailChannelEnabled
                  ? 'Channels no longer have separate setup here. Use Connectors to create Email, Slack, and future channel profiles.'
                  : 'Channels no longer have separate setup here. Use Connectors to create Slack and future channel profiles.'}
              </InfoBanner>
            </SectionCard>
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelStatusRow({
  icon: Icon,
  name,
  install,
  status,
}: {
  icon: LucideIcon;
  name: string;
  install: SlackInstallation | EmailInstallation | null | undefined;
  status: string;
}) {
  return (
    <div className="flex items-center gap-3 px-6 py-4">
      <span className="border-border/60 bg-muted/40 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-medium">{name}</p>
        <InlineMeta>
          <span>{status}</span>
          {install ? (
            <span className="text-primary inline-flex items-center gap-1">
              <Check className="h-3 w-3" />
              Connected
            </span>
          ) : null}
        </InlineMeta>
      </div>
    </div>
  );
}
