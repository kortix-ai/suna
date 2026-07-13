'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ModelSelector } from '@/features/session/model-selector';
import { AgentSelector, flattenModels } from '@/features/session/session-chat-input';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { EmailConnectForm } from '@/features/workspace/customize/sections/connectors-view';
import { TeamsChannelPanel } from '@/features/workspace/customize/sections/teams-channel-panel';
import {
  type ChannelBinding,
  useChannelBindings,
  useUpdateChannelBinding,
} from '@/hooks/channels/use-channel-bindings';
import {
  type EmailInstallation,
  type SlackInstallation,
  type TelegramInstallation,
  useConnectSlack,
  useConnectTelegram,
  useDisconnectEmail,
  useDisconnectSlack,
  useDisconnectTelegram,
  useEmailInstall,
  useSlackInstall,
  useSlackManifest,
  useSlackMode,
  useTelegramInstall,
} from '@/hooks/channels/use-channels-installations';
import {
  useDisconnectTeams,
  useTeamsInstall,
  useTeamsMode,
} from '@/hooks/channels/use-teams-installations';
import { modelKeyToWire, wireToModelKey } from '@/hooks/opencode/use-model-store';
import {
  type Agent,
  useOpenCodeProviders,
  useVisibleAgents,
} from '@/hooks/opencode/use-opencode-sessions';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { getProject, listProjectAccess } from '@kortix/sdk/projects-client';
import { Check, CheckCircleSolid, ExternalLinkSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Mail, MessageSquare, Send, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';

/** Reserved slug for the built-in Email channel (see api connectors.ts). */
const EMAIL_CONNECTOR_SLUG = 'kortix_email';
const CHANNEL_LOADING_ROWS = ['channel-loading-1', 'channel-loading-2', 'channel-loading-3'];
const SLACK_MANIFEST_STEPS = [
  'Click Open Slack, choose "From a manifest", paste the JSON, confirm.',
  'On the next screen, click Install to Workspace and approve.',
  'Copy the Bot User OAuth Token (xoxb-…) and Signing Secret.',
];

export function ChannelsView({ projectId }: { projectId: string | null }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId ?? ''),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
  const emailChannelEnabled = projectQuery.data?.experimental?.agentmail_email === true;
  const { data: install, isLoading: loadingInstall } = useSlackInstall(projectId);
  const { data: mode, isLoading: loadingMode } = useSlackMode(projectId);
  const { data: telegramInstall, isLoading: loadingTelegram } = useTelegramInstall(projectId);
  const { data: emailInstall, isLoading: loadingEmail } = useEmailInstall(
    emailChannelEnabled ? projectId : null,
    EMAIL_CONNECTOR_SLUG,
  );
  const loading =
    loadingInstall ||
    loadingMode ||
    loadingTelegram ||
    projectQuery.isLoading ||
    (emailChannelEnabled && loadingEmail);
  const oauthInstallUrl = mode?.oauth_available ? mode.install_url : null;
  const canWrite =
    useProjectCan(projectId ?? undefined, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE).allowed === true;

  return (
    <CustomizeSectionWrapper
      title="Channels"
      description={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextRunThisb83f74db',
      )}
      action={
        canWrite && projectId && !loading && !install && oauthInstallUrl ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={oauthInstallUrl} target="_blank" rel="noopener noreferrer">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAddTo1729c1b6',
              )}
            </Link>
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        {!projectId ? (
          <InfoBanner tone="neutral">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOpenA4ae69220',
            )}
          </InfoBanner>
        ) : loading ? (
          <div className="space-y-1">
            {CHANNEL_LOADING_ROWS.map((key) => (
              <Skeleton key={key} className="h-10 rounded-md" />
            ))}
          </div>
        ) : !oauthInstallUrl && !install ? (
          <div className="space-y-4">
            <EmptyState
              icon={MessageSquare}
              size="sm"
              title={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrTitleBringbd0857f4',
              )}
              description={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrDescriptionSelf7c5e4adb',
              )}
            />
            <BringYourOwnPanel projectId={projectId} inline />
            {/* Telegram stays reachable regardless of the Slack install state —
                it's an optional channel with its own BYO-bot connect flow. */}
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Bot</TableHead>
                  <TableHead className="w-[120px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TelegramChannelRow
                  projectId={projectId}
                  installation={telegramInstall ?? null}
                  canWrite={canWrite}
                />
              </TableBody>
            </Table>
          </div>
        ) : (
          <>
            {install ? (
              <InfoBanner
                tone="success"
                icon={Check}
                title={`Connected to ${install.workspaceName ?? install.workspaceId}`}
              >
                Bot <code className="font-mono text-xs">{install.botUserId ?? '—'}</code>
                {' · '}Team <code className="font-mono text-xs">{install.workspaceId}</code>
              </InfoBanner>
            ) : null}

            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead className="w-[120px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SlackChannelRow
                  projectId={projectId}
                  installation={install ?? null}
                  oauthInstallUrl={oauthInstallUrl}
                  canWrite={canWrite}
                />
                <TelegramChannelRow
                  projectId={projectId}
                  installation={telegramInstall ?? null}
                  canWrite={canWrite}
                />
                {emailChannelEnabled ? (
                  <EmailChannelRow
                    projectId={projectId}
                    installation={emailInstall ?? null}
                    canWrite={canWrite}
                  />
                ) : null}
                <TeamsChannelRow projectId={projectId} canWrite={canWrite} />
              </TableBody>
            </Table>

            {install ? (
              <InfoBanner tone="neutral" icon={CheckCircleSolid}>
                <p className="text-sm">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextInviteThe94db1964',
                  )}{' '}
                  <span className="text-foreground font-medium">
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextMention67ed74a7',
                    )}
                  </span>{' '}
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextItA7139ed4f',
                  )}{' '}
                  <span className="text-foreground font-medium">Slack CLI</span>.
                </p>
              </InfoBanner>
            ) : oauthInstallUrl ? (
              <BringYourOwnPanel projectId={projectId} />
            ) : null}

            <div className="border-border/60 border-t pt-6">
              <TeamsChannelPanel projectId={projectId} />
            </div>

            {install ? <ChannelBindingsSection projectId={projectId} canWrite={canWrite} /> : null}
          </>
        )}
      </div>
    </CustomizeSectionWrapper>
  );
}

/**
 * Per-channel agent/model/join-policy overrides — the web management surface
 * for `chat_channel_bindings` (spec §2.5 "Channels become manageable"). Today
 * the only other way to change these is the in-Slack `/kortix agent|model|policy`
 * commands; this edits the same row through `PATCH …/channels/bindings/:id`.
 */
function ChannelBindingsSection({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}) {
  const bindingsQuery = useChannelBindings(projectId);
  const bindings = bindingsQuery.data?.bindings ?? [];

  if (bindingsQuery.isLoading) {
    return (
      <div className="space-y-1">
        <Skeleton className="h-8 rounded-md" />
        <Skeleton className="h-8 rounded-md" />
      </div>
    );
  }
  if (bindings.length === 0) return null;

  return (
    <div className="space-y-2">
      <Label>Channel bindings</Label>
      <p className="text-muted-foreground text-xs">
        Which agent, model, and join policy each connected channel uses. A channel with no override
        follows the project default.
      </p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Channel</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Join policy</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bindings.map((b) => (
            <ChannelBindingTableRow
              key={b.bindingId}
              projectId={projectId}
              binding={b}
              projectDefaultAgent={bindingsQuery.data?.projectDefaultAgent ?? null}
              canWrite={canWrite}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const CONVERSATION_POLICIES: Array<{ value: ChannelBinding['conversationPolicy']; label: string }> =
  [
    { value: 'project_open', label: 'Project members can join' },
    { value: 'owner_only', label: 'Owner only' },
    { value: 'owner_approval', label: 'Owner approval' },
  ];

/** Label for the synthetic agent-picker entry meaning "inherit the project's default agent". */
function agentDefaultLabel(projectDefaultAgent: string | null): string {
  return projectDefaultAgent ? `Project default (${projectDefaultAgent})` : 'Project default';
}

/** Bare model id → the compact form callers below already assume (`kortix/x` → `x`). */
function stripOpencodeNamespace(model: string): string {
  return model.startsWith('kortix/') ? model.slice('kortix/'.length) : model;
}

/**
 * Honest one-line summary of what a channel's model binding will actually
 * run — including the case an explicit pin silently degrades because it's no
 * longer servable (BYOK key disconnected, managed model retired), which
 * `effectiveModel.source` surfaces as something other than `'explicit'`.
 */
function describeEffectiveModel(binding: ChannelBinding): string {
  if (binding.opencodeModel) {
    const label = stripOpencodeNamespace(binding.opencodeModel);
    return binding.effectiveModel.source === 'explicit'
      ? label
      : `${label} (unavailable — using default)`;
  }
  const resolved = binding.effectiveModel.model;
  return resolved ? `Project default (${stripOpencodeNamespace(resolved)})` : 'Project default';
}

function ChannelBindingTableRow({
  projectId,
  binding,
  projectDefaultAgent,
  canWrite,
}: {
  projectId: string;
  binding: ChannelBinding;
  projectDefaultAgent: string | null;
  canWrite: boolean;
}) {
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 20_000,
  });
  // `can_manage` is the coarse project-manage flag; AND it with the real
  // connector write leaf so a READ-only connector role can't edit bindings
  // (the PATCH route asserts project.connector.write and would 403).
  const canManage = Boolean(accessQuery.data?.can_manage) && canWrite;

  // Same agent source as the chat input / schedules pickers (spec: "use the
  // same component everywhere"). `projectId` does a server-side fetch of the
  // declared manifest agents — no live sandbox/session required, so it works
  // on a settings page with nothing running.
  const visibleAgents = useVisibleAgents({ projectId });
  const agentSelectorAgents = useMemo<Agent[]>(() => {
    const defaultEntry = {
      name: agentDefaultLabel(projectDefaultAgent),
      description: "Falls back to the project's configured default agent.",
      mode: 'primary',
      permission: {},
      options: {},
    } as unknown as Agent;
    const names = new Set(visibleAgents.map((a) => a.name));
    // Keep a currently-bound name in the list even if it was since renamed/
    // removed, so the picker never renders a value it can't display.
    const missingCurrent =
      binding.agentName && !names.has(binding.agentName)
        ? [
            {
              name: binding.agentName,
              mode: 'primary',
              permission: {},
              options: {},
            } as unknown as Agent,
          ]
        : [];
    return [defaultEntry, ...visibleAgents, ...missingCurrent];
  }, [visibleAgents, projectDefaultAgent, binding.agentName]);
  const selectedAgentValue = binding.agentName ?? agentDefaultLabel(projectDefaultAgent);

  const { data: providers } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const selectedModel = binding.opencodeModel
    ? wireToModelKey(stripOpencodeNamespace(binding.opencodeModel))
    : null;

  const update = useUpdateChannelBinding();

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell>
        <div className="min-w-0">
          <p className="text-sm font-medium">{binding.channelName ?? binding.channelId}</p>
          <p className="text-muted-foreground text-xs">{binding.workspaceId}</p>
        </div>
      </TableCell>
      <TableCell>
        <div className="bg-card rounded-2xl border px-2 py-1 inline-flex">
          <AgentSelector
            agents={agentSelectorAgents}
            selectedAgent={selectedAgentValue}
            onSelect={(v) =>
              update.mutate(
                {
                  projectId,
                  bindingId: binding.bindingId,
                  agentName: !v || v === agentDefaultLabel(projectDefaultAgent) ? null : v,
                },
                {
                  onSuccess: () => successToast('Channel agent updated'),
                  onError: (e) => errorToastFallback(e),
                },
              )
            }
            disabled={!canManage || update.isPending}
          />
        </div>
      </TableCell>
      <TableCell>
        {canManage ? (
          <div className="flex flex-col gap-1">
            <div className="bg-card rounded-2xl border px-2 py-1 inline-flex w-fit">
              <ModelSelector
                models={models}
                providers={providers}
                selectedModel={selectedModel}
                unsetLabel="Project default"
                onSelect={(m) =>
                  update.mutate(
                    {
                      projectId,
                      bindingId: binding.bindingId,
                      opencodeModel: m ? modelKeyToWire(m) : null,
                    },
                    {
                      onSuccess: () => successToast('Channel model updated'),
                      onError: (e) => errorToastFallback(e),
                    },
                  )
                }
              />
            </div>
            {!binding.opencodeModel ? (
              <p className="text-muted-foreground/70 text-xs">{describeEffectiveModel(binding)}</p>
            ) : null}
          </div>
        ) : (
          <Badge variant="outline" size="sm" className="font-mono">
            {describeEffectiveModel(binding)}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <Select
          value={binding.conversationPolicy}
          onValueChange={(v) =>
            update.mutate(
              {
                projectId,
                bindingId: binding.bindingId,
                conversationPolicy: v as ChannelBinding['conversationPolicy'],
              },
              {
                onSuccess: () => successToast('Join policy updated'),
                onError: (e) => errorToastFallback(e),
              },
            )
          }
          disabled={!canManage || update.isPending}
        >
          <SelectTrigger className="w-44" variant="popover">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONVERSATION_POLICIES.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
    </TableRow>
  );
}

function errorToastFallback(error: unknown) {
  errorToast(error instanceof Error ? error.message : 'Failed to update channel binding');
}

function SlackChannelRow({
  projectId,
  installation,
  oauthInstallUrl,
  canWrite,
}: {
  projectId: string;
  installation: SlackInstallation | null;
  oauthInstallUrl: string | null;
  canWrite: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const disconnect = useDisconnectSlack();
  const [confirming, setConfirming] = useState(false);

  const connected = Boolean(installation);

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell>
        <div className="flex items-center gap-2.5">
          <Icon.Slack className="size-5 shrink-0" />
          <span className="text-sm font-medium">Slack</span>
        </div>
      </TableCell>
      <TableCell>
        {connected ? (
          <Badge variant="success" size="sm">
            Connected
          </Badge>
        ) : (
          <Badge variant="outline" size="sm" className="text-muted-foreground">
            Not connected
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {connected ? (installation?.workspaceName ?? installation?.workspaceId ?? '—') : '—'}
      </TableCell>
      <TableCell>
        {!canWrite ? null : connected ? (
          confirming ? (
            <div className="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={disconnect.isPending}
                onClick={() =>
                  disconnect.mutate(projectId, {
                    onSuccess: () => setConfirming(false),
                  })
                }
              >
                {disconnect.isPending ? (
                  <Loading className="size-3.5 shrink-0 animate-spin" />
                ) : null}
                Disconnect
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => setConfirming(true)}
            >
              <X className="size-3.5 shrink-0" />
              Disconnect
            </Button>
          )
        ) : oauthInstallUrl ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={oauthInstallUrl} target="_blank" rel="noopener noreferrer">
              Install
            </Link>
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function TelegramChannelRow({
  projectId,
  installation,
  canWrite,
}: {
  projectId: string;
  installation: TelegramInstallation | null;
  canWrite: boolean;
}) {
  const disconnect = useDisconnectTelegram();
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const connected = Boolean(installation);

  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell>
          <div className="flex items-center gap-2.5">
            <Send className="text-muted-foreground size-5 shrink-0" />
            <span className="text-sm font-medium">Telegram</span>
            <Badge variant="muted" size="xs">
              Optional
            </Badge>
          </div>
        </TableCell>
        <TableCell>
          {connected ? (
            <Badge variant="success" size="sm">
              Connected
            </Badge>
          ) : (
            <Badge variant="outline" size="sm" className="text-muted-foreground">
              Not connected
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground text-sm">
          {connected ? (
            <code className="text-foreground font-mono text-xs">
              {installation?.botUsername ? `@${installation.botUsername}` : installation?.botId}
            </code>
          ) : (
            '—'
          )}
        </TableCell>
        <TableCell>
          {!canWrite ? null : connected ? (
            confirming ? (
              <div className="flex items-center justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() =>
                    disconnect.mutate(projectId, {
                      onSuccess: () => {
                        setConfirming(false);
                        successToast('Telegram disconnected');
                      },
                      onError: (err) =>
                        errorToast(err instanceof Error ? err.message : 'Failed to disconnect'),
                    })
                  }
                >
                  {disconnect.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setConfirming(true)}
              >
                <X className="size-3.5 shrink-0" />
                Disconnect
              </Button>
            )
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setConnectOpen(true)}>
              Connect
            </Button>
          )}
        </TableCell>
      </TableRow>
      <TelegramConnectModal
        projectId={projectId}
        open={connectOpen}
        onOpenChange={setConnectOpen}
      />
    </>
  );
}

function TelegramConnectModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const connect = useConnectTelegram();
  const [token, setToken] = useState('');

  const close = (next: boolean) => {
    if (connect.isPending) return; // don't lose the in-flight connect
    if (!next) setToken('');
    onOpenChange(next);
  };

  const submit = () => {
    const bot_token = token.trim();
    if (!bot_token) return;
    connect.mutate(
      { projectId, bot_token },
      {
        onSuccess: (result) => {
          successToast(
            `Telegram connected${result.botUsername ? ` — @${result.botUsername}` : ''}`,
            { description: 'Message your bot to start a session; replies land in the chat.' },
          );
          setToken('');
          onOpenChange(false);
        },
        onError: (err) =>
          errorToast(err instanceof Error ? err.message : 'Failed to connect Telegram'),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Connect Telegram</ModalTitle>
          <ModalDescription>
            Paste a bot token from{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              @BotFather
            </a>
            {' '}(<code className="font-mono text-xs">/newbot</code>). Kortix validates it, points
            the bot&apos;s webhook at this project, and keeps the token server-side — it never
            reaches a sandbox.
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <ModalBody className="space-y-2">
            <Label htmlFor="telegram-bot-token">Bot token</Label>
            <Input
              id="telegram-bot-token"
              type="password"
              autoComplete="off"
              placeholder="1234567890:AA…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={connect.isPending}
            />
            <p className="text-muted-foreground text-xs">
              Optional channel — you can disconnect at any time; disconnecting removes the webhook
              and deletes the stored token.
            </p>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={connect.isPending || !token.trim()}>
              {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Connect
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

function TeamsChannelRow({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const { data: install } = useTeamsInstall(projectId);
  const { data: mode } = useTeamsMode(projectId);
  const disconnect = useDisconnectTeams();
  const [confirming, setConfirming] = useState(false);

  if (mode && !mode.enabled) return null;

  const connected = Boolean(install);
  const installUrl = mode?.orgConsentUrl ?? null;
  const deepLinkUrl = install?.orgInstalled ? (mode?.deepLinkUrl ?? null) : null;

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell>
        <div className="flex items-center gap-2.5">
          <Icon.MicrosoftTeams className="size-5 shrink-0" />
          <span className="text-sm font-medium">Microsoft Teams</span>
        </div>
      </TableCell>
      <TableCell>
        {connected ? (
          <Badge variant="success" size="sm">
            Connected
          </Badge>
        ) : (
          <Badge variant="outline" size="sm" className="text-muted-foreground">
            Not connected
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {connected ? (install?.teamName ?? install?.tenantId ?? '—') : '—'}
      </TableCell>
      <TableCell>
        {!canWrite ? null : connected ? (
          confirming ? (
            <div className="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={disconnect.isPending}
                onClick={() =>
                  disconnect.mutate(projectId, {
                    onSuccess: () => setConfirming(false),
                  })
                }
              >
                {disconnect.isPending ? (
                  <Loading className="size-3.5 shrink-0 animate-spin" />
                ) : null}
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-1">
              {deepLinkUrl ? (
                <Button size="sm" variant="secondary" asChild>
                  <Link href={deepLinkUrl} target="_blank" rel="noopener noreferrer">
                    Add to Teams
                  </Link>
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setConfirming(true)}
              >
                <X className="size-3.5 shrink-0" />
                Disconnect
              </Button>
            </div>
          )
        ) : installUrl ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={installUrl} target="_blank" rel="noopener noreferrer">
              Install
            </Link>
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function EmailChannelRow({
  projectId,
  installation,
  canWrite,
}: {
  projectId: string;
  installation: EmailInstallation | null;
  canWrite: boolean;
}) {
  const disconnect = useDisconnectEmail();
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const connected = Boolean(installation);

  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell>
          <div className="flex items-center gap-2.5">
            <Mail className="text-muted-foreground size-5 shrink-0" />
            <span className="text-sm font-medium">Email</span>
          </div>
        </TableCell>
        <TableCell>
          {connected ? (
            <Badge variant="success" size="sm">
              Connected
            </Badge>
          ) : (
            <Badge variant="outline" size="sm" className="text-muted-foreground">
              Not connected
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground text-sm">
          {connected ? (
            <code className="text-foreground font-mono text-xs">{installation?.email ?? '—'}</code>
          ) : (
            '—'
          )}
        </TableCell>
        <TableCell>
          {!canWrite ? null : connected ? (
            confirming ? (
              <div className="flex items-center justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() =>
                    disconnect.mutate(
                      { projectId, connectorSlug: EMAIL_CONNECTOR_SLUG },
                      {
                        onSuccess: () => {
                          setConfirming(false);
                          successToast('Email disconnected');
                        },
                      },
                    )
                  }
                >
                  {disconnect.isPending ? (
                    <Loading className="size-3.5 shrink-0 animate-spin" />
                  ) : null}
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setConfirming(true)}
              >
                <X className="size-3.5 shrink-0" />
                Disconnect
              </Button>
            )
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setConnectOpen(true)}>
              Connect
            </Button>
          )}
        </TableCell>
      </TableRow>

      <Modal open={connectOpen} onOpenChange={setConnectOpen}>
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Connect Email</ModalTitle>
            <ModalDescription>
              Create a managed AgentMail inbox for your agent, or attach one you already have.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[75vh] overflow-y-auto">
            <EmailConnectForm
              projectId={projectId}
              connectorSlug={EMAIL_CONNECTOR_SLUG}
              onConnected={() => {
                setConnectOpen(false);
                successToast('Email connected');
              }}
            />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}

function ConnectedDetails() {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  return (
    <InfoBanner tone="neutral" icon={CheckCircleSolid}>
      <p className="text-sm">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextInviteThe94db1964',
        )}{' '}
        <code className="font-mono text-xs">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextMention67ed74a7',
          )}
        </code>{' '}
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextItA7139ed4f',
        )}{' '}
        <code className="font-mono text-xs">slack</code> CLI.
      </p>
    </InfoBanner>
  );
}

function BringYourOwnPanel({ projectId, inline = false }: { projectId: string; inline?: boolean }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [copied, setCopied] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectSlack();
  const manifest = useSlackManifest(projectId);

  const manifestText = manifest.data ?? '';

  const copyManifest = async () => {
    if (!manifestText) return;
    await navigator.clipboard.writeText(manifestText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const submit = () => {
    setError(null);
    connect.mutate(
      {
        projectId,
        bot_token: botToken.trim(),
        signing_secret: signingSecret.trim(),
      },
      { onError: (e) => setError((e as Error).message) },
    );
  };

  const content =
    step === 1 ? (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextStep12c389f4e',
          )}
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAppManifest040b924e',
              )}
            </span>
            <ButtonGroup>
              <Hint label={copied ? 'Copied' : 'Copy'} side="bottom">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={copyManifest}
                  disabled={!manifestText}
                >
                  {copied ? (
                    <CheckCircleSolid className="size-3.5 shrink-0" />
                  ) : (
                    <Copy className="size-3.5 shrink-0" />
                  )}
                </Button>
              </Hint>
              <Button variant="outline" size="sm" className="gap-1.5" asChild>
                <Link
                  href="https://api.slack.com/apps?new_app=1"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOpenSlacka088997c',
                  )}
                  <ExternalLinkSolid className="size-3.5 shrink-0" />
                </Link>
              </Button>
            </ButtonGroup>
          </div>
          <pre className="border-border bg-muted max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed">
            {manifest.isLoading
              ? 'Loading manifest...'
              : manifest.error
                ? `Failed to load manifest: ${(manifest.error as Error).message}`
                : manifestText}
          </pre>
        </div>

        <ol className="text-muted-foreground list-decimal space-y-1.5 pl-5 text-sm">
          {SLACK_MANIFEST_STEPS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>

        <div className="flex justify-end">
          <Button size="sm" variant="secondary" onClick={() => setStep(2)}>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextNextPasted1384aaa',
            )}
          </Button>
        </div>
      </div>
    ) : (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextStep22f8cae80',
          )}{' '}
          <code className="font-mono text-xs">project_secrets</code>{' '}
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAlongsideAny8e77bd03',
          )}
        </p>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bot-token">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextBotUser193e4bfd',
              )}
            </Label>
            <Input
              id="bot-token"
              placeholder={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrPlaceholderXoxb84fe69f4',
              )}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSlackYouraeeca6ed',
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signing-secret">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSigningSecret2762795e',
              )}
            </Label>
            <Input
              id="signing-secret"
              placeholder="••••••••"
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSlackYour09fe8ce8',
              )}
            </p>
          </div>
        </div>

        {error ? (
          <InfoBanner tone="destructive" title="Could not connect">
            {error}
          </InfoBanner>
        ) : null}

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
            Back
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={submit}
            disabled={connect.isPending || !botToken.trim() || !signingSecret.trim()}
          >
            {connect.isPending ? <Loading className="mr-2 size-3.5 shrink-0 animate-spin" /> : null}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextConnectSlack5ad82c3b',
            )}
          </Button>
        </div>
      </div>
    );

  if (inline) return content;

  return (
    <Disclosure variant="outline" className="overflow-hidden" open={open} onOpenChange={setOpen}>
      <DisclosureTrigger variant="outline">
        <Button
          variant="ghost-input"
          className={cn('flex h-fit w-full items-center justify-between rounded-none py-2.5')}
        >
          <div className="min-w-0 text-left">
            <p className="text-sm font-medium">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextBringYourc7326733',
              )}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextForSelf3fbeca22',
              )}
            </p>
          </div>
        </Button>
      </DisclosureTrigger>
      <DisclosureContent
        variant="outline"
        contentClassName="border-border bg-popover border-t px-4 py-5"
      >
        {content}
      </DisclosureContent>
    </Disclosure>
  );
}
