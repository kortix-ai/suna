'use client';

import { describeCron, describeRunAt, relativeTime } from '@/components/projects/cron-format';
import type { AutoFolderKind } from '@/components/projects/session-folder-grouping';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Skeleton } from '@/components/ui/skeleton';
import { successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { useChannelBindings } from '@/hooks/channels/use-channel-bindings';
import { cn } from '@/lib/utils';
import { type ProjectTrigger, listProjectTriggers } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Check, Copy, ExternalLink, Hash, PauseCircle, Webhook } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * The custom panel shown at the top of an auto-folder's home page — the actual
 * source behind the folder's sessions:
 *   Scheduled → the project's cron triggers (cadence, timezone, last run)
 *   Webhooks  → the webhook triggers + their public endpoints
 *   Slack     → the connected Slack channels (channel bindings)
 * Email / Telegram have no richer source surface, so they render nothing extra.
 */
export function AutoFolderPanel({
  projectId,
  kind,
}: {
  projectId: string;
  kind: AutoFolderKind;
}) {
  if (kind === 'schedule' || kind === 'webhook') {
    return <TriggersPanel projectId={projectId} kind={kind} />;
  }
  if (kind === 'slack') {
    return <SlackChannelsPanel projectId={projectId} />;
  }
  return null;
}

function PanelShell({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function TriggersPanel({ projectId, kind }: { projectId: string; kind: 'schedule' | 'webhook' }) {
  const { data, isLoading } = useQuery({
    queryKey: ['project-triggers', projectId],
    queryFn: () => listProjectTriggers(projectId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const wantType = kind === 'schedule' ? 'cron' : 'webhook';
  const triggers = (data?.triggers ?? []).filter((t) => t.type === wantType);
  const title = kind === 'schedule' ? 'Schedules' : 'Webhooks';

  if (isLoading) {
    return (
      <PanelShell title={title}>
        <div className="space-y-2">
          {['a', 'b'].map((k) => (
            <Skeleton key={k} className="h-14 w-full rounded-md" />
          ))}
        </div>
      </PanelShell>
    );
  }

  if (triggers.length === 0) return null;

  return (
    <PanelShell
      title={title}
      action={
        <Button asChild variant="ghost" size="sm" className="gap-1.5">
          <Link
            href={`/projects/${projectId}/customize/${kind === 'schedule' ? 'schedules' : 'webhooks'}`}
          >
            Manage
            <ExternalLink className="size-3.5 shrink-0" />
          </Link>
        </Button>
      }
    >
      <ul className="space-y-2">
        {triggers.map((t) => (
          <TriggerRow key={t.slug} trigger={t} kind={kind} />
        ))}
      </ul>
    </PanelShell>
  );
}

function TriggerRow({ trigger, kind }: { trigger: ProjectTrigger; kind: 'schedule' | 'webhook' }) {
  const paused = !trigger.enabled;
  const cadence =
    trigger.type === 'cron'
      ? trigger.run_at
        ? describeRunAt(trigger.run_at)
        : trigger.cron
          ? describeCron(trigger.cron)
          : 'Cron'
      : trigger.secret_env
        ? `Signed via ${trigger.secret_env}`
        : 'Unsigned';

  return (
    <li className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5">
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          paused
            ? 'bg-muted-foreground/10 text-muted-foreground'
            : 'bg-kortix-green/15 text-kortix-green',
        )}
      >
        {paused ? (
          <PauseCircle className="size-5" />
        ) : kind === 'schedule' ? (
          <CalendarClock className="size-5" />
        ) : (
          <Webhook className="size-5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">
            {trigger.name?.trim() || trigger.slug}
          </span>
          {paused && (
            <Badge variant="outline" size="xs">
              Paused
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {cadence}
          {trigger.type === 'cron' && !trigger.run_at ? ` · ${trigger.timezone}` : ''}
          {` · last run ${relativeTime(trigger.last_fired_at)}`}
        </p>
      </div>
      {kind === 'webhook' && trigger.webhook_url && <CopyEndpoint url={trigger.webhook_url} />}
    </li>
  );
}

function CopyEndpoint({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Hint side="top" label={copied ? 'Copied' : 'Copy endpoint URL'}>
      <Button
        variant="outline"
        size="icon-sm"
        className="shrink-0"
        onClick={() => {
          void navigator.clipboard?.writeText(url);
          setCopied(true);
          successToast('Endpoint URL copied');
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </Hint>
  );
}

function SlackChannelsPanel({ projectId }: { projectId: string }) {
  const { data, isLoading } = useChannelBindings(projectId);
  const bindings = data?.bindings ?? [];

  if (isLoading) {
    return (
      <PanelShell title="Connected channels">
        <div className="space-y-2">
          {['a', 'b'].map((k) => (
            <Skeleton key={k} className="h-12 w-full rounded-md" />
          ))}
        </div>
      </PanelShell>
    );
  }

  if (bindings.length === 0) return null;

  return (
    <PanelShell
      title="Connected channels"
      action={
        <Button asChild variant="ghost" size="sm" className="gap-1.5">
          <Link href={`/projects/${projectId}/customize/channels`}>
            Manage
            <ExternalLink className="size-3.5 shrink-0" />
          </Link>
        </Button>
      }
    >
      <ul className="space-y-2">
        {bindings.map((b) => (
          <li
            key={b.bindingId}
            className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5"
          >
            <span className="bg-sidebar-accent/60 flex size-9 shrink-0 items-center justify-center rounded-sm">
              <Icon.Slack className="text-muted-foreground size-4.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-foreground flex items-center gap-1 truncate text-sm font-medium">
                <Hash className="text-muted-foreground/60 size-3.5 shrink-0" />
                {b.channelName ?? b.channelId}
              </div>
              <p className="text-muted-foreground truncate text-xs">
                Agent: {b.effectiveAgent.agent}
                {b.effectiveAgent.source !== 'explicit' ? ' (project default)' : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </PanelShell>
  );
}
