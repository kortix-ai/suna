'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Check,
  type LucideIcon,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Settings2,
  Slack,
  Unplug,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import {
  EmailConnectForm,
  SlackConnectForm,
} from '@/components/projects/customize/sections/connectors-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Skeleton } from '@/components/ui/skeleton';
import { successToast } from '@/components/ui/toast';
import {
  type EmailInstallation,
  type SlackInstallation,
  useDisconnectEmail,
  useDisconnectSlack,
  useEmailInstall,
  useSlackInstall,
} from '@/hooks/channels/use-channels-installations';
import { getProject } from '@/lib/projects-client';
import { useCustomizeStore } from '@/stores/customize-store';

/** The reserved slug the built-in Email channel materializes under (see api connectors.ts). */
const EMAIL_CONNECTOR_SLUG = 'kortix_email';

/**
 * Channels — connect Slack and Email right here. Each channel is a card that
 * shows its live connection, opens its connect flow in a modal in-place (no
 * detour through Connectors), and offers Disconnect / advanced settings once
 * connected. The deeper surface (per-tool permissions, multiple inboxes,
 * sender rules) still lives in Connectors, reached from each card's menu.
 */
export function ChannelsView({ projectId }: { projectId: string | null }) {
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId ?? ''),
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
        <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8">
          <header className="space-y-1.5">
            <h2 className="text-foreground text-base font-semibold">Channels</h2>
            <p className="text-muted-foreground text-sm">
              Let people reach your agent where they already work. Connect a channel and incoming
              messages start agent sessions automatically.
            </p>
          </header>

          {!projectId ? (
            <InfoBanner tone="neutral">Open a project before configuring channels.</InfoBanner>
          ) : loading ? (
            <div className="space-y-3">
              <Skeleton className="h-32 w-full rounded-2xl" />
              {emailChannelEnabled && <Skeleton className="h-32 w-full rounded-2xl" />}
            </div>
          ) : (
            <div className="space-y-3">
              <SlackChannelCard projectId={projectId} install={slackInstall ?? null} />
              {emailChannelEnabled && (
                <EmailChannelCard projectId={projectId} install={emailInstall ?? null} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SlackChannelCard({
  projectId,
  install,
}: {
  projectId: string;
  install: SlackInstallation | null;
}) {
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const disconnect = useDisconnectSlack();

  return (
    <ChannelCard
      icon={Slack}
      name="Slack"
      description="Mentions and threaded replies route straight into agent sessions."
      connected={Boolean(install)}
      identityLabel="Workspace"
      identity={install ? install.workspaceName || install.workspaceId : null}
      onConnect={() => setConnectOpen(true)}
      onDisconnect={() => setConfirmDisconnect(true)}
    >
      <ChannelConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        title="Connect Slack"
        description="Add Kortix to your workspace — one click and the channel is live, no setup required."
      >
        <SlackConnectForm
          projectId={projectId}
          onConnected={() => {
            setConnectOpen(false);
            successToast('Slack connected');
          }}
        />
      </ChannelConnectDialog>
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Slack?"
        description="Kortix stops receiving Slack mentions and replies for this project. You can reconnect anytime."
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        confirmIcon={<Unplug className="h-4 w-4" />}
        isPending={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(projectId, {
            onSuccess: () => {
              setConfirmDisconnect(false);
              successToast('Slack disconnected');
            },
          })
        }
      />
    </ChannelCard>
  );
}

function EmailChannelCard({
  projectId,
  install,
}: {
  projectId: string;
  install: EmailInstallation | null;
}) {
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const disconnect = useDisconnectEmail();

  return (
    <ChannelCard
      icon={Mail}
      name="Email"
      description="Give your agent its own inbox. Inbound mail starts a session and replies come back by email."
      connected={Boolean(install)}
      identityLabel="Address"
      identity={install?.email ?? null}
      onConnect={() => setConnectOpen(true)}
      onDisconnect={() => setConfirmDisconnect(true)}
    >
      <ChannelConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        title="Connect Email"
        description="Create a managed AgentMail inbox for your agent, or attach one you already have."
      >
        <EmailConnectForm
          projectId={projectId}
          connectorSlug={EMAIL_CONNECTOR_SLUG}
          onConnected={() => {
            setConnectOpen(false);
            successToast('Email connected');
          }}
        />
      </ChannelConnectDialog>
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Email?"
        description="Kortix stops receiving mail at this address for this project. You can reconnect anytime."
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        confirmIcon={<Unplug className="h-4 w-4" />}
        isPending={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(
            { projectId, connectorSlug: EMAIL_CONNECTOR_SLUG },
            {
              onSuccess: () => {
                setConfirmDisconnect(false);
                successToast('Email disconnected');
              },
            },
          )
        }
      />
    </ChannelCard>
  );
}

/** The connect modal shell — header + scrollable body, shared by every channel. */
function ChannelConnectDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[75vh] overflow-y-auto px-6 py-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One channel as a card: identity + live status on the left, the single primary
 * action on the right (Connect when off, a quiet menu when on). The connect and
 * disconnect dialogs ride along as `children`.
 */
function ChannelCard({
  icon: Icon,
  name,
  description,
  connected,
  identityLabel,
  identity,
  onConnect,
  onDisconnect,
  children,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  connected: boolean;
  identityLabel: string;
  identity: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  children: ReactNode;
}) {
  const setSection = useCustomizeStore((s) => s.setSection);

  return (
    <div className="border-border/60 bg-card rounded-2xl border p-5">
      <div className="flex items-start gap-3.5">
        <EntityAvatar icon={Icon} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-foreground text-sm font-semibold">{name}</h3>
            {connected ? (
              <Badge variant="success" size="sm" className="gap-1">
                <Check className="h-3 w-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="outline" size="sm">
                Not connected
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{description}</p>
          {connected && identity ? (
            <InlineMeta className="mt-2">
              <span>{identityLabel}</span>
              <code className="text-foreground font-mono">{identity}</code>
            </InlineMeta>
          ) : null}
        </div>
        <div className="shrink-0">
          {connected ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`${name} options`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => setSection('connectors')}>
                  <Settings2 className="h-4 w-4" />
                  Advanced settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onDisconnect}>
                  <Unplug className="h-4 w-4" />
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button size="sm" className="gap-1.5" onClick={onConnect}>
              <Plus className="h-4 w-4" />
              Connect
            </Button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
