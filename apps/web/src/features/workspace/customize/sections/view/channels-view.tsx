'use client';

/**
 * Channels — where a project's agent becomes reachable from Slack, Email, and
 * Microsoft Teams.
 *
 * ## Where this renders (it is a section, not a page)
 *
 * This exports `ChannelsSection`: the channels CONTENT and nothing else — no
 * heading, no column, no scroll container. Its one mount is the Channels scope
 * of `/projects/<id>/connectors` (`connectors-page.tsx`), which owns the
 * `CapabilityPageShell` around it.
 *
 * Channels was briefly its own top-level Customize tab and rendered its own
 * shell here. It is not any more, and the reason is a product call, not a
 * layout one: a person who wants their agent reachable from Slack is doing the
 * same job as a person wiring up any other outside tool, and asking them to
 * know that one lives under "Channels" and the other under "Connectors" is
 * asking them to know our table layout. The two are still different backend
 * resources — `/projects/{id}/channels/*` (inbound: installations, chat
 * identity, per-channel bindings) versus `/projects/{id}/connectors/*`
 * (outbound: tool and OAuth access) — and nothing here merges them. Only the
 * navigation merged.
 *
 * Nesting a second `CapabilityPageShell` inside the page's would print a
 * second `<h1>` and a second `overflow-y-auto` inside the layout's one bounded
 * column, so this file must not reintroduce one; `channels-view.chrome.test.ts`
 * pins that.
 *
 * ## The redesign (this file's shape changed; the data layer did not)
 *
 * Every query, mutation, feature flag, and permission check below is the same
 * one this view used before. What changed is the FORM the state is rendered
 * in, because the old form had a specific failure: it presented a
 * four-column `<Table>` (Platform / Status / Workspace / Actions) as the
 * primary install surface. In the state every new workspace starts in —
 * nothing connected — column two read "Not connected" on every row and column
 * three was an em dash on every row. A table exists so you can compare values
 * down a column; there were none. It was a grid drawn around three buttons.
 *
 * **The form now follows the state:**
 *
 * | State | Form | Why |
 * | --- | --- | --- |
 * | Slack not connected | Hero panel with a preview of the agent answering in a thread (`slack-connect-card.tsx`) | The decision needs the payoff in front of it, not after |
 * | Slack connected | One compact entity row + the bindings table | Now there is real data, so the table earns its place |
 * | Email / Teams | Compact entity rows (`channel-row.tsx`), always | Second line says what the channel DOES when off, what it's bound to when on — never an em dash |
 *
 * **Other fixes carried by this rewrite:**
 *
 * - **One primary CTA.** The section header used to render "Add to Slack"
 *   while the Slack table row rendered "Install" — two buttons firing the same
 *   OAuth redirect. The header action is gone; the hero owns the CTA.
 * - **The payoff moved in front of the commitment.** "Invite the bot to any
 *   channel and @mention it" used to render only when `install` was truthy, so
 *   the explanation of the feature arrived strictly after you had authorised
 *   it. It is now hero copy, and its post-connect form is a next-step hint
 *   that retires itself once a channel is actually bound (`bindings.length`),
 *   instead of a permanent banner restating what you already did.
 * - **Bring-your-own-Slack is a wizard, not a JSON dump.** The old inline
 *   `Disclosure` opened onto a raw manifest `<pre>`, a prose step counter, and
 *   two fields named after Slack's API. It is now a three-step `Stepper` in a
 *   Modal with the JSON opt-in — see `slack-byo-wizard.tsx` for the full
 *   rationale.
 * - **Self-hosted is a path, not an empty state.** No managed Slack app
 *   (`mode.oauth_available === false`) used to render `EmptyState` — the
 *   component for "there is nothing here" — framing a supported route as a
 *   dead end. It gets the same hero, with the wizard behind its button.
 * - **`ConnectedDetails` deleted.** It was defined and never referenced; the
 *   identical JSX was inlined at the call site.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
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
import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import { Slack } from '@/features/icon/icons/slack';
import { ModelSelector } from '@/features/session/model-selector';
import { AgentSelector, flattenModels } from '@/features/session/session-chat-input';
import {
  ChannelDisconnectButton,
  ChannelRow,
} from '@/features/workspace/customize/sections/component/channel-row';
import { SlackConnectCard } from '@/features/workspace/customize/sections/component/slack-connect-card';
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
  useDisconnectEmail,
  useDisconnectSlack,
  useEmailInstall,
  useSlackInstall,
  useSlackMode,
} from '@/hooks/channels/use-channels-installations';
import {
  useDisconnectTeams,
  useTeamsInstall,
  useTeamsMode,
} from '@/hooks/channels/use-teams-installations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  type Agent,
  contract,
  modelKeyToWire,
  qk,
  useFeatureFlag,
  useRuntimeProviders,
  useVisibleAgents,
  wireToModelKey,
} from '@kortix/sdk/react';
import { AtIcon, EnvelopeIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';

/** Reserved slug for the built-in Email channel (see api connectors.ts). */
const EMAIL_CONNECTOR_SLUG = 'kortix_email';

/**
 * Skeleton shapes match what replaces them: one tall hero panel, then two
 * short rows. Matching the shape is the point — a placeholder that settles
 * into a different geometry reads as a layout jump, not as loading.
 */
const CHANNEL_LOADING_ROWS = ['channel-loading-1', 'channel-loading-2'];

export function ChannelsSection({ projectId }: { projectId: string }) {
  // This view used to read the flags off the project SUMMARY query
  // (`qk.project.summary` / `getProject`, whose payload nests them one level
  // shallower). It now reads the one gating primitive, which is backed by
  // `qk.project.detail` — the entry the Customize panel that hosts this view
  // already holds, so the switch removes a fetch rather than adding one.
  //
  // The LOADING semantics are preserved deliberately: unlike its siblings, this
  // surface WAITS on the flag before painting (`emailFlag.isLoading` feeds
  // `loading` below), so the header action cannot flash the wrong state, and
  // `useEmailInstall` stays unfired until the flag resolves.
  const emailFlag = useFeatureFlag(projectId, 'agentmail_email');
  const teamsFlag = useFeatureFlag(projectId, 'teams');
  const emailChannelEnabled = emailFlag.enabled;
  const teamsChannelEnabled = teamsFlag.enabled;
  const { data: install, isLoading: loadingInstall } = useSlackInstall(projectId);
  const { data: mode, isLoading: loadingMode } = useSlackMode(projectId);
  const { data: emailInstall, isLoading: loadingEmail } = useEmailInstall(
    emailChannelEnabled ? projectId : null,
    EMAIL_CONNECTOR_SLUG,
  );
  const loading =
    loadingInstall ||
    loadingMode ||
    emailFlag.isLoading ||
    teamsFlag.isLoading ||
    (emailChannelEnabled && loadingEmail);
  const oauthInstallUrl = mode?.oauth_available ? mode.install_url : null;
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE).allowed === true;

  // Once Slack is connected it stops being the headline and becomes a peer of
  // Email and Teams — same row, same list. So the "More channels" label only
  // earns its place while the hero is above it; with Slack in the list, the
  // rows ARE the channel list and the section header already says "Channels".
  const slackRow = Boolean(install);
  const hasRows = slackRow || emailChannelEnabled || teamsChannelEnabled;
  const showMoreLabel = !slackRow && hasRows;

  return (
    /* Narrower than the page it sits in, and deliberately so. The Connectors
       shell is `max-w-5xl` because a 3-up card grid needs it; everything below
       is a stack of full-width rows and one hero card, and at 1024px the hero's
       `aspect-[3/1]` cover band renders ~341px of mostly-empty gradient above
       four lines of copy. Capped at `max-w-3xl` it is ~256px — the same band the
       cover was drawn for.

       Left-aligned, not `mx-auto`: the shell's `<h1>` starts at the container's
       left edge, and a centred column under a left-aligned heading reads as a
       misalignment rather than as a narrower measure.

       No heading and no scroll container here. Both belong to the
       `CapabilityPageShell` in `connectors-page.tsx`; a second of either would
       print a second `<h1>` and scroll the wrong box. */
    <div className="w-full max-w-3xl space-y-6">
      {loading ? (
        <>
          <Skeleton className="h-64 rounded-md" />
          <div className="space-y-2">
            {CHANNEL_LOADING_ROWS.map((key) => (
              <Skeleton key={key} className="h-14 rounded-md" />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Slack, not connected: the hero. Connected, it drops into the row
              list below and this branch renders nothing. */}
          {install ? null : (
            <SlackConnectCard
              projectId={projectId}
              oauthInstallUrl={oauthInstallUrl}
              canWrite={canWrite}
            />
          )}

          {hasRows ? (
            <section className="space-y-2">
              {showMoreLabel ? <Label>More channels</Label> : null}
              <ul className="space-y-2">
                {install ? (
                  <SlackChannelRow
                    projectId={projectId}
                    installation={install}
                    canWrite={canWrite}
                  />
                ) : null}
                {emailChannelEnabled ? (
                  <EmailChannelRow
                    projectId={projectId}
                    installation={emailInstall ?? null}
                    canWrite={canWrite}
                  />
                ) : null}
                {teamsChannelEnabled ? (
                  <TeamsChannelRow projectId={projectId} canWrite={canWrite} />
                ) : null}
              </ul>
            </section>
          ) : null}

          {install ? <SlackFollowUp projectId={projectId} canWrite={canWrite} /> : null}

          {teamsChannelEnabled ? <TeamsChannelPanel projectId={projectId} /> : null}
        </>
      )}
    </div>
  );
}

/** Slack as a peer row, once it is connected. */
function SlackChannelRow({
  projectId,
  installation,
  canWrite,
}: {
  projectId: string;
  installation: SlackInstallation;
  canWrite: boolean;
}) {
  const disconnect = useDisconnectSlack();

  return (
    <ChannelRow
      icon={<Slack className="size-5 shrink-0" />}
      name="Slack"
      connected
      detail={installation.workspaceName ?? installation.workspaceId}
      pitch="Mention your agent in any channel."
      actions={
        canWrite ? (
          <ChannelDisconnectButton
            pending={disconnect.isPending}
            onConfirm={(done) =>
              disconnect.mutate(projectId, {
                onSuccess: () => {
                  done();
                  successToast('Slack disconnected');
                },
              })
            }
          />
        ) : null
      }
    />
  );
}

/**
 * What follows a connected Slack: the one-time "now do this in Slack" nudge,
 * then the per-channel bindings table.
 *
 * The nudge is the old permanent `InfoBanner` turned into a next step. It
 * retires itself as soon as `bindings.length > 0` — a bound channel is proof
 * the user already invited the bot and mentioned it, so restating the
 * instruction forever is a banner they read past on every visit. The two
 * blocks are mutually exclusive in practice: no bindings means the nudge and
 * no table, and bindings mean the table and no nudge.
 */
function SlackFollowUp({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const bindingsQuery = useChannelBindings(projectId);
  const bindings = bindingsQuery.data?.bindings ?? [];

  return (
    <div className="space-y-4">
      {bindings.length === 0 && !bindingsQuery.isLoading ? (
        <InfoBanner tone="neutral" icon={AtIcon} title="One more step, in Slack">
          Invite <span className="text-foreground font-medium">@Kortix</span> to a channel, then
          mention it. Each mention starts a fresh run and the agent answers in that thread.
        </InfoBanner>
      ) : null}

      <ChannelBindingsSection projectId={projectId} canWrite={canWrite} />
    </div>
  );
}

/**
 * Per-channel agent/model/join-policy overrides — the web management surface
 * for `chat_channel_bindings` (spec §2.5 "Channels become manageable"). Today
 * the only other way to change these is the in-Slack `/kortix agent|model|policy`
 * commands; this edits the same row through `PATCH …/channels/bindings/:id`.
 */
function ChannelBindingsSection({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
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
  // The binding PATCH route asserts `project.connector.write`, and `canWrite`
  // already probes exactly that. This used to AND it with the roster's coarse
  // `can_manage` flag — a role label by another name, and strictly redundant
  // once the leaf is asked for directly.
  const canManage = canWrite;

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

  const { data: providers } = useRuntimeProviders();
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
        {/* rounded-full, not the rounded-2xl this used to carry: the selector
            inside renders a fully-round h-8 pill trigger, so a 16px-radius
            frame around it read as two mismatched curves. */}
        <div className="bg-card inline-flex rounded-full border px-2 py-1">
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
            <div className="bg-card inline-flex w-fit rounded-full border px-2 py-1">
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
          <SelectTrigger className="w-44">
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

function TeamsChannelRow({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const { data: install } = useTeamsInstall(projectId);
  const { data: mode } = useTeamsMode(projectId);
  const disconnect = useDisconnectTeams();

  const connected = Boolean(install);
  const installUrl = mode?.orgConsentUrl ?? null;
  const deepLinkUrl = install?.orgInstalled ? (mode?.deepLinkUrl ?? null) : null;

  return (
    <ChannelRow
      icon={<MicrosoftTeams className="size-5 shrink-0" />}
      name="Microsoft Teams"
      connected={connected}
      detail={install?.teamName ?? install?.tenantId ?? null}
      pitch="Mention your agent in a Teams channel or chat."
      actions={
        !canWrite ? null : connected ? (
          <>
            {deepLinkUrl ? (
              <Button size="sm" variant="secondary" asChild>
                <Link href={deepLinkUrl} target="_blank" rel="noopener noreferrer">
                  Add to Teams
                </Link>
              </Button>
            ) : null}
            <ChannelDisconnectButton
              pending={disconnect.isPending}
              onConfirm={(done) =>
                disconnect.mutate(projectId, {
                  onSuccess: () => {
                    done();
                    successToast('Microsoft Teams disconnected');
                  },
                })
              }
            />
          </>
        ) : installUrl ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={installUrl} target="_blank" rel="noopener noreferrer">
              Connect
            </Link>
          </Button>
        ) : null
      }
    />
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

  const connected = Boolean(installation);

  return (
    <>
      <ChannelRow
        icon={<EnvelopeIcon className="text-muted-foreground size-5 shrink-0" />}
        name="Email"
        connected={connected}
        detail={installation?.email ?? null}
        pitch="Give your agent an inbox it can read and reply from."
        actions={
          !canWrite ? null : connected ? (
            <ChannelDisconnectButton
              pending={disconnect.isPending}
              onConfirm={(done) =>
                disconnect.mutate(
                  { projectId, connectorSlug: EMAIL_CONNECTOR_SLUG },
                  {
                    onSuccess: () => {
                      done();
                      successToast('Email disconnected');
                    },
                  },
                )
              }
            />
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setConnectOpen(true)}>
              Connect
            </Button>
          )
        }
      />

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
