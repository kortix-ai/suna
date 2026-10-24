'use client';

import type { UiTranslator } from '../../../i18n';
import { useTranslations } from '../../../i18n';
import { useLocalizedUiCatalog } from '../../../i18n/ui-catalog/use-localized-ui-catalog';
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
 * column, so this file must not reintroduce one.
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

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { Field, FieldDescription, FieldGroup, FieldTitle } from '../../../primitives/field';
import { InfoBanner } from '../../../primitives/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../../primitives/input-group';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../primitives/select';
import { Skeleton } from '../../../primitives/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '../../../primitives/tabs';
import Loading from '../../../primitives/loading';
import { errorToast, infoToast, successToast, warningToast } from '../../../primitives/toast';
import { ModelSelector } from '../../../session/models/model-selector';
import { AgentSelector } from '../../../session/composer/session-chat-input';
import {
  ChannelDisconnectButton,
  ChannelRow,
} from '../component/channel-row';
import { TeamsChannelMock, TeamsConnectCard } from '../component/teams-connect-card';
import { TelegramChannelRow } from '../component/telegram-channel-row';
import { SlackChannelMock, SlackConnectCard } from '../component/slack-connect-card';
import { ChannelHeroLayoutProvider } from '../component/channel-hero-frame';
import { EmailHero } from '../../connectors/detail/email-inboxes';
import { ChannelBrandMark } from '../../../session/turn/channel-brand';
import {
  type ChannelModelKey,
  channelSettingsPatch,
} from './channel-settings-patch';
import { slackConversationName } from '../../../session/turn/channel-message';
import { bindingTabs } from './channel-binding-tabs';
import { AccessRow } from '../../../access/access/access-row';
import {
  type ChannelBinding,
  useChannelBindings,
  useUpdateChannelBinding,
} from '../../../internal/hooks/use-channel-bindings';
import {
  type SlackInstallation,
  useDisconnectSlack,
  useSlackInstall,
  useSlackMode,
  useTelegramInstall,
} from '../../../internal/hooks/channels/use-channels-installations';
import {
  type TeamsInstallation,
  useDisconnectTeams,
  useTeamsInstall,
  useTeamsMode,
} from '@kortix/sdk/react';
import { modelRefToKey } from '@kortix/sdk';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCan } from '../../../internal/lib/use-project-can';
import { cn } from '../../../internal/lib/utils';
import {
  type Agent,
  flattenModels,
  modelProviderMode,
  useFeatureFlag,
  useRuntimeProviders,
  useVisibleAgents,
} from '@kortix/sdk/react';
import {
  AtIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../../providers/ui-provider';
import { useEffect, useMemo, useState } from 'react';
import { useTunnelConnections } from '@kortix/sdk/react';
import { useProjectComputerAccounts } from '../../../internal/tunnel/computer-connect';
import { useEmailInboxes } from '../../../internal/hooks/channels/use-email-inboxes';
import { appHref } from '../../connectors/connector-routes';
import { FeatureGateScreen } from '../../shared/feature-gate-screen';

/** Reserved slug for the built-in Email channel (see api connectors.ts). */

/** A Kortix channel's own page (`platform`), or every channel (the Channels page). */
export type ChannelPlatform = 'slack' | 'teams' | 'email' | 'telegram';

export function ChannelsSection({ projectId, platform }: { projectId: string; platform?: ChannelPlatform }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  useTeamsInstallReturnToast();
  const { data: install, isLoading: loadingInstall } = useSlackInstall(projectId);
  const { data: mode, isLoading: loadingMode } = useSlackMode(projectId);
  // Teams is on for every project (its feature flag graduated on 2026-10-01).
  const { data: teamsInstall } = useTeamsInstall(projectId);
  const { data: teamsMode } = useTeamsMode(projectId);
  // Not connected, Teams gets the same hero as Slack; connected, it is a row.
  const teamsHero = !teamsInstall && Boolean(teamsMode?.enabled);
  // Email (Resend Inboxes) is experimental behind `email_channel`. Off, it is on
  // no surface, and its inboxes are never read (EmailHero is not mounted).
  const emailFlag = useFeatureFlag(projectId, 'email_channel');
  const emailEnabled = emailFlag.enabled;
  const loading = loadingInstall || loadingMode || emailFlag.isLoading;
  const tPages = useTranslations('connectorPages');
  const oauthInstallUrl = mode?.oauth_available ? mode.install_url : null;
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE).allowed === true;
  // Each platform's row shows how many conversations it has bound and opens
  // the bindings dialog on that platform's tab. A new `session` per opening
  // remounts the dialog, so its tab, search and selection start fresh.
  const bindingsQuery = useChannelBindings(projectId);
  const channelCounts = new Map(
    bindingTabs(bindingsQuery.data?.bindings ?? []).map((tab) => [tab.platform, tab.count]),
  );
  const [channelsDialog, setChannelsDialog] = useState({ open: false, platform: 'slack', session: 0 });
  const openChannels = (platform: string) =>
    setChannelsDialog((dialog) => ({ open: true, platform, session: dialog.session + 1 }));

  // A channel's own page draws it as a hero. The Channels tab lists every
  // channel as one compact row that opens that page (`ChannelsList`).
  const platforms: ChannelPlatform[] = platform ? [platform] : [];
  // The Kortix tab also holds the computer, where this deployment can pair one
  // (the machine list answers 503 where computers are off).
  const computersEnabled = useTunnelConnections({ refetchInterval: false }).isSuccess;

  const hero = (pf: ChannelPlatform) => {
    switch (pf) {
      case 'slack':
        return install ? (
          <>
            <SlackChannelRow
              projectId={projectId}
              installation={install}
              canWrite={canWrite}
              channelCount={channelCounts.get('slack') ?? 0}
              onOpenChannels={() => openChannels('slack')}
            />
            <SlackFollowUp projectId={projectId} />
          </>
        ) : (
          <SlackConnectCard projectId={projectId} oauthInstallUrl={oauthInstallUrl} canWrite={canWrite} />
        );
      case 'teams':
        return teamsHero && teamsMode ? (
          <TeamsConnectCard projectId={projectId} mode={teamsMode} canWrite={canWrite} />
        ) : (
          <>
            <TeamsChannelRow
              projectId={projectId}
              canWrite={canWrite}
              channelCount={channelCounts.get('teams') ?? 0}
              onOpenChannels={() => openChannels('teams')}
            />
            {teamsInstall?.appUpdateAvailable ? (
              <TeamsAppUpdateNotice install={teamsInstall} tI18nComplete={tI18nComplete} />
            ) : null}
          </>
        );
      case 'email':
        // Each inbox is an account on `kortix_email`: the hero counts them, Manage lists them.
        return <EmailHero projectId={projectId} canWrite={canWrite} />;
      case 'telegram':
        return <TelegramChannelRow projectId={projectId} canWrite={canWrite} />;
    }
  };

  // The Email page with the flag off: the standard flag-off screen, with its enable action.
  if (platform === 'email' && !emailFlag.isLoading && !emailEnabled) {
    return (
      <FeatureGateScreen
        featureKey="email_channel"
        featureName={tPages('emailGateName')}
        description={tPages('emailGateDescription')}
      />
    );
  }

  if (!platform) {
    return (
      <ChannelsList
        projectId={projectId}
        loading={loading}
        slack={Boolean(install)}
        slackDetail={install ? (install.workspaceName ?? install.workspaceId) : null}
        teams={Boolean(teamsInstall)}
        teamsDetail={teamsInstall ? (teamsInstall.teamName ?? teamsInstall.tenantId ?? null) : null}
        email={emailEnabled}
        computer={computersEnabled}
      />
    );
  }

  return (
    /* Full width of the Connectors shell: the heroes are split cards whose
       chat preview needs the room. No heading and no scroll container here;
       both belong to the `CapabilityPageShell` in `connectors-page.tsx`. */
    <ChannelHeroLayoutProvider>
      <div className="w-full space-y-6">
        {loading
          ? platforms.map((pf) => <Skeleton key={pf} className="h-72 w-full rounded-lg" />)
          : platforms.map((pf) => (
              <div key={pf} className="space-y-4">
                {hero(pf)}
              </div>
            ))}
        <ChannelBindingsDialog
          key={channelsDialog.session}
          projectId={projectId}
          canWrite={canWrite}
          platform={channelsDialog.platform}
          open={channelsDialog.open}
          onOpenChange={(open) => setChannelsDialog((dialog) => ({ ...dialog, open }))}
        />
      </div>
    </ChannelHeroLayoutProvider>
  );
}

/** A channel's page: the catalogue's native entry for it. */
function channelPageHref(projectId: string, app: ChannelPlatform | 'computer'): string {
  return appHref(projectId, { source: 'discover', slug: app, id: `native:${app}` });
}

/**
 * The Channels tab: one compact row per channel, connected or not, each
 * opening the channel's own page, where its hero sets it up. Five heroes one
 * under the other read as five ads; a list reads as what you have.
 */
function ChannelsList({
  projectId,
  loading,
  slack,
  slackDetail,
  teams,
  teamsDetail,
  email,
  computer,
}: {
  projectId: string;
  loading: boolean;
  slack: boolean;
  slackDetail: string | null;
  teams: boolean;
  teamsDetail: string | null;
  email: boolean;
  computer: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tPages = useTranslations('connectorPages');
  const inboxes = useEmailInboxes(email ? projectId : null);
  const telegram = useTelegramInstall(projectId);
  const computers = useProjectComputerAccounts(projectId);
  const inboxCount = inboxes.data?.length ?? 0;
  const rows: Array<{
    app: ChannelPlatform | 'computer';
    name: string;
    connected: boolean;
    detail: string | null;
    pitch: string;
  }> = [
    { app: 'slack', name: 'Slack', connected: slack, detail: slackDetail, pitch: tI18nComplete.raw('text9bd1c37ed121') },
    { app: 'teams', name: 'Microsoft Teams', connected: teams, detail: teamsDetail, pitch: tI18nComplete.raw('text9225e456b795') },
    ...(email
      ? [
          {
            app: 'email' as const,
            name: tPages('channelNameEmail'),
            connected: inboxCount > 0,
            detail: inboxCount > 0 ? tPages('channelInboxCount', { count: inboxCount }) : null,
            pitch: tPages('channelPitchEmail'),
          },
        ]
      : []),
    {
      app: 'telegram',
      name: 'Telegram',
      connected: Boolean(telegram.data),
      detail: null,
      pitch: tI18nComplete.raw('text51e6bc656528'),
    },
    ...(computer
      ? [
          {
            app: 'computer' as const,
            name: tPages('channelNameComputer'),
            connected: computers.accounts.length > 0,
            detail:
              computers.accounts.map((account) => account.label?.trim()).filter(Boolean).join(', ') || null,
            pitch: tPages('channelPitchComputer'),
          },
        ]
      : []),
  ];
  if (loading) {
    return (
      <div className="w-full max-w-3xl space-y-2">
        {rows.map((row) => (
          <Skeleton key={row.app} className="h-14 rounded-md" />
        ))}
      </div>
    );
  }
  return (
    <ul className="w-full max-w-3xl space-y-2">
      {rows.map((row) => (
        <ChannelRow
          key={row.app}
          app={row.app}
          name={row.name}
          connected={row.connected}
          detail={row.detail}
          pitch={row.pitch}
          actions={
            <Button asChild size="sm" variant={row.connected ? 'outline' : 'secondary'}>
              <Link href={channelPageHref(projectId, row.app)} aria-label={tPages('channelOpenNamed', { name: row.name })}>
                {row.connected ? tPages('open') : tPages('waySetUp')}
              </Link>
            </Button>
          }
        />
      ))}
    </ul>
  );
}

/** Slack as a peer row, once it is connected. */
function SlackChannelRow({
  projectId,
  installation,
  canWrite,
  channelCount,
  onOpenChannels,
}: {
  projectId: string;
  installation: SlackInstallation;
  canWrite: boolean;
  channelCount: number;
  onOpenChannels: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tPages = useTranslations('connectorPages');
  const disconnect = useDisconnectSlack();

  return (
    <ChannelRow
      app="slack"
      name="Slack"
      connected
      detail={installation.workspaceName ?? installation.workspaceId}
      pitch={tI18nComplete.raw('text9bd1c37ed121')}
      hero={{
        title: tI18nComplete.raw('text89e9e20668f3'),
        connectedTitle: tPages('channelConnectedTitle', { name: 'Slack' }),
        preview: <SlackChannelMock />,
      }}
      actions={
        <>
          {channelCount > 0 ? <ChannelsButton count={channelCount} onOpen={onOpenChannels} /> : null}
          {canWrite ? (
            <ChannelDisconnectButton
              pending={disconnect.isPending}
              onConfirm={(done) =>
                disconnect.mutate(projectId, {
                  onSuccess: () => {
                    done();
                    successToast(tI18nComplete.raw('textd948c285986a'));
                  },
                })
              }
            />
          ) : null}
        </>
      }
    />
  );
}

/** "12 channels" on a connected platform's row: opens the bindings dialog on its tab. */
function ChannelsButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Button size="sm" variant="secondary" className="gap-1" onClick={onOpen}>
      {tI18nComplete('text5dae52a3f448', { count })}
      <CaretRightIcon className="size-3.5 shrink-0" />
    </Button>
  );
}

/**
 * What follows a connected Slack before its first channel: the one-time "now
 * do this in Slack" nudge. It retires itself as soon as `bindings.length > 0`:
 * a bound channel is proof the user already invited the bot and mentioned it,
 * and from then on the Slack row's "N channels" opens the bindings dialog.
 */
function SlackFollowUp({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const bindingsQuery = useChannelBindings(projectId);
  const bindings = bindingsQuery.data?.bindings ?? [];

  return bindings.length === 0 && !bindingsQuery.isLoading ? (
    <InfoBanner tone="neutral" icon={AtIcon} title={tI18nComplete.raw('textd63af8edd3d6')}>
      {tI18nComplete.raw('text1fd9ae1607aa')}{' '}
      <span className="text-foreground font-medium">{tI18nComplete.raw('text476b90bdc143')}</span>{' '}
      {tI18nComplete.raw('textb81b729b4538')}
    </InfoBanner>
  ) : null;
}

/**
 * Per-conversation agent/model/join-policy overrides — the web management
 * surface for `chat_channel_bindings` (spec §2.5 "Channels become
 * manageable"). The in-chat `/kortix agent|model|policy` commands edit the
 * same row; this edits it through `PATCH …/channels/bindings/:id`.
 *
 * One dialog with a tab per platform, opened from each platform's row. It
 * shows either the list or one channel's settings: a row swaps the content,
 * and Back or Save returns to the list. It replaced a table of every Slack and
 * Teams conversation on the page, which grew with each channel and DM; a list
 * dialog that opened a second dialog would stack two modals.
 *
 * The list is read-only. It used to carry three live pickers per row: with ~30
 * conversations (a real project's count) that was ~90 controls.
 */
function ChannelBindingsDialog({
  projectId,
  canWrite,
  platform,
  open,
  onOpenChange,
}: {
  projectId: string;
  canWrite: boolean;
  /** The tab it opens on. */
  platform: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const conversationPolicies = useLocalizedUiCatalog(CONVERSATION_POLICIES);
  const bindingsQuery = useChannelBindings(projectId);
  const projectDefaultAgent = bindingsQuery.data?.projectDefaultAgent ?? null;
  const [tab, setTab] = useState(platform);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      (bindingsQuery.data?.bindings ?? [])
        .map((binding) => ({
          binding,
          name: bindingName(binding, tI18nComplete),
          scope: bindingScope(binding, tI18nComplete),
        }))
        // Threads of one Teams channel share a name; their titles order them.
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true }) ||
            a.scope.localeCompare(b.scope, undefined, { numeric: true }),
        ),
    [bindingsQuery.data, tI18nComplete],
  );
  const tabs = bindingTabs(rows.map((row) => row.binding));
  // The tab it was opened on, unless that platform has nothing bound.
  const active = tabs.some((t) => t.platform === tab) ? tab : (tabs[0]?.platform ?? tab);
  const inTab = rows.filter((row) => row.binding.platform === active);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? inTab.filter(({ binding, name, scope }) =>
        [name, scope, binding.agentName ?? '', binding.opencodeModel ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : inTab;
  // `selected` goes null when the conversation was removed while open.
  const selected = rows.find((row) => row.binding.bindingId === selectedId) ?? null;
  const back = () => setSelectedId(null);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {selected ? (
        <ChannelSettingsModalContent
          projectId={projectId}
          binding={selected.binding}
          name={selected.name}
          scope={selected.scope}
          projectDefaultAgent={projectDefaultAgent}
          canWrite={canWrite}
          onBack={back}
        />
      ) : (
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>{tI18nComplete.raw('text5f61b63c2c4a')}</ModalTitle>
            <ModalDescription>{tI18nComplete.raw('text1f2550ed44dc')}</ModalDescription>
          </ModalHeader>
          <ModalBody className="space-y-3 pt-4">
            {tabs.length > 1 ? (
              <Tabs
                value={active}
                onValueChange={(value) => {
                  setTab(value);
                  setQuery('');
                }}
              >
                <TabsListCompact>
                  {tabs.map((t) => (
                    <TabsTriggerCompact key={t.platform} value={t.platform} className="gap-1.5">
                      {PLATFORM_NAMES[t.platform] ?? t.platform}
                      <span className="text-muted-foreground tabular-nums">{t.count}</span>
                    </TabsTriggerCompact>
                  ))}
                </TabsListCompact>
              </Tabs>
            ) : null}
            {inTab.length >= BINDING_SEARCH_MIN ? (
              <InputGroupSearch>
                <InputGroupSearchIcon>
                  <MagnifyingGlassIcon />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  placeholder={tI18nComplete.raw('text49c266baaaa7')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  size="sm"
                />
                <InputGroupSearchClear onClick={() => setQuery('')} />
              </InputGroupSearch>
            ) : null}
            {bindingsQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 rounded-md" />
                <Skeleton className="h-12 rounded-md" />
              </div>
            ) : visible.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                {tI18nComplete.raw('texte8dd87902b91')}
              </p>
            ) : (
              // The list scrolls; the tabs and search above it stay put. Capped at
              // the viewport less ~21rem of header, tabs, search and footer, so
              // the footer stays on screen at the 720 × 480 desktop minimum,
              // where this modal is a bottom sheet.
              <ul className="max-h-[min(45vh,calc(100dvh-21rem))] space-y-2 overflow-y-auto">
                {visible.map(({ binding, name, scope }) => (
                  // The overrides ride the meta line: AccessRow's trailing slot
                  // stops clicks for its kebab, which would leave a dead zone.
                  <AccessRow
                    key={binding.bindingId}
                    title={<span title={binding.channelId}>{name}</span>}
                    metaParts={[
                      scope,
                      <BindingOverrides key="overrides" binding={binding} policies={conversationPolicies} />,
                    ]}
                    onClick={() => setSelectedId(binding.bindingId)}
                  />
                ))}
              </ul>
            )}
          </ModalBody>
          <ModalFooter className="pt-2 pb-5">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              {tI18nComplete.raw('text11a6767d5674')}
            </Button>
          </ModalFooter>
        </ModalContent>
      )}
    </Modal>
  );
}

/** Brand names, as the platform rows spell them. */
const PLATFORM_NAMES: Record<string, string> = { slack: 'Slack', teams: 'Microsoft Teams' };

/** A row's settings at a glance: only what overrides the project, else "Project default". */
function BindingOverrides({
  binding,
  policies,
}: {
  binding: ChannelBinding;
  policies: Array<{ value: ChannelBinding['conversationPolicy']; label: string }>;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const modelUnavailable = binding.opencodeModel !== null && binding.effectiveModel.source !== 'explicit';
  const overrides = [
    binding.agentName,
    binding.opencodeModel ? stripGatewayNamespace(binding.opencodeModel) : null,
    binding.conversationPolicy === 'project_open'
      ? null
      : (policies.find((p) => p.value === binding.conversationPolicy)?.label ?? binding.conversationPolicy),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      title={describeEffectiveModel(binding)}
      className={cn('inline-flex items-center gap-1', overrides && 'text-foreground')}
    >
      {modelUnavailable ? (
        <WarningCircleIcon weight="fill" className="text-kortix-orange size-3.5 shrink-0" />
      ) : null}
      {overrides || tI18nComplete.raw('texte8cb80e5c5cb')}
    </span>
  );
}

/** The schedule modal's field frame, around each picker in the settings dialog. */
/** Rows before the list grows a search field — the `AgentSelector` rule (7). */
const BINDING_SEARCH_MIN = 7;

const CONVERSATION_POLICIES: Array<{ value: ChannelBinding['conversationPolicy']; label: string }> =
  [
    { value: 'project_open', label: 'Project members can join' },
    { value: 'owner_only', label: 'Owner only' },
    { value: 'owner_approval', label: 'Owner approval' },
  ];

/** What a join policy does, under the picker (channels/teams/participants.ts). */
function policyDescription(
  policy: ChannelBinding['conversationPolicy'],
  tI18nComplete: UiTranslator,
): string {
  if (policy === 'project_open') return tI18nComplete.raw('texte83e9ba50357');
  if (policy === 'owner_only') return tI18nComplete.raw('text4540af5229a8');
  return tI18nComplete.raw('textda4bd8bdfe42');
}

/** Label for the synthetic agent-picker entry meaning "inherit the project's default agent". */
function agentDefaultLabel(projectDefaultAgent: string | null): string {
  return projectDefaultAgent ? `Project default (${projectDefaultAgent})` : 'Project default';
}

/** Bare model id → the compact form callers below already assume (`kortix/x` → `x`). */
function stripGatewayNamespace(model: string): string {
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
    const label = stripGatewayNamespace(binding.opencodeModel);
    return binding.effectiveModel.source === 'explicit'
      ? label
      : `${label} (unavailable — using default)`;
  }
  const resolved = binding.effectiveModel.model;
  return resolved ? `Project default (${stripGatewayNamespace(resolved)})` : 'Project default';
}

function BindingBrandMark({ platform }: { platform: string }) {
  if (platform !== 'teams' && platform !== 'slack') return null;
  return <ChannelBrandMark platform={platform === 'teams' ? 'Teams' : 'Slack'} />;
}

/**
 * One conversation's settings. A field holds `undefined` until it is touched,
 * so it shows the live binding; Save sends only the fields that differ from
 * it, in one PATCH. The route applies agent, model, then policy, so a refused
 * model keeps an agent change — the list refetches either way
 * (`useUpdateChannelBinding`), and the next Save sends what is still different.
 */
function ChannelSettingsModalContent({
  projectId,
  binding,
  name,
  scope,
  projectDefaultAgent,
  canWrite,
  onBack,
}: {
  projectId: string;
  binding: ChannelBinding;
  name: string;
  scope: string;
  projectDefaultAgent: string | null;
  canWrite: boolean;
  /** Back to the channel list: the Back button, and after a save. */
  onBack: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const conversationPolicies = useLocalizedUiCatalog(CONVERSATION_POLICIES);
  const defaultAgentLabel = agentDefaultLabel(projectDefaultAgent);

  // Same agent source as the chat input / schedules pickers (spec: "use the
  // same component everywhere"). `projectId` does a server-side fetch of the
  // declared manifest agents — no live sandbox/session required, so it works
  // on a settings page with nothing running.
  const visibleAgents = useVisibleAgents({ projectId });
  const agents = useMemo<Agent[]>(() => {
    const defaultEntry = {
      name: defaultAgentLabel,
      description: tI18nComplete.raw('text12dc6dbd8fc8'),
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
  }, [defaultAgentLabel, tI18nComplete, visibleAgents, binding.agentName]);

  const { data: providers } = useRuntimeProviders();
  const models = useMemo(
    () => flattenModels(providers, { providerMode: modelProviderMode(providers) }),
    [providers],
  );
  const boundModel: ChannelModelKey = binding.opencodeModel
    ? modelRefToKey(binding.opencodeModel)
    : null;

  const [agentDraft, setAgentDraft] = useState<string | null | undefined>(undefined);
  const [modelDraft, setModelDraft] = useState<ChannelModelKey | undefined>(undefined);
  const [policyDraft, setPolicyDraft] = useState<ChannelBinding['conversationPolicy'] | undefined>(
    undefined,
  );
  const agentName = agentDraft === undefined ? binding.agentName : agentDraft;
  const model = modelDraft === undefined ? boundModel : modelDraft;
  const policy = policyDraft ?? binding.conversationPolicy;

  const patch = channelSettingsPatch(
    { agentName: binding.agentName, model: boundModel, conversationPolicy: binding.conversationPolicy },
    { agentName, model, conversationPolicy: policy },
  );
  const dirty = Object.keys(patch).length > 0;

  const update = useUpdateChannelBinding();
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    update.mutate(
      { projectId, bindingId: binding.bindingId, ...patch },
      {
        onSuccess: () => {
          successToast(tI18nComplete.raw('text255e5c59ef00'));
          onBack();
        },
        onError: (error) => errorToastFallback(error, tI18nComplete),
      },
    );
  };

  return (
    <ModalContent className="lg:max-w-lg">
      <ModalHeader>
        <ModalTitle>{tI18nComplete.raw('textafc219f2a1e7')}</ModalTitle>
        <ModalDescription>{tI18nComplete.raw('text95112f275fba')}</ModalDescription>
      </ModalHeader>
      <form onSubmit={save}>
        {/* The header and footer take 153px: the whole form fits from 720px tall,
            and the footer stays on screen at the 720 × 480 desktop minimum. */}
        <ModalBody className="max-h-[calc(100dvh-15rem)] space-y-5 overflow-y-auto pt-4">
          <div className="bg-popover flex min-w-0 items-center gap-3 rounded-md border px-3 py-2.5">
            <BindingBrandMark platform={binding.platform} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" title={binding.channelId}>
                {name}
              </p>
              <p className="text-muted-foreground truncate text-xs">{scope}</p>
            </div>
          </div>

          <FieldGroup className="gap-5">
            <Field data-disabled={!canWrite}>
              <FieldTitle>{tI18nComplete.raw('text11b39c93777e')}</FieldTitle>
              {/* `field`: the selector is the bordered h-9 box itself, the same
                  box as the Select below, not the composer chip in a frame. */}
              <AgentSelector
                agents={agents}
                selectedAgent={agentName ?? defaultAgentLabel}
                onSelect={(v) => setAgentDraft(!v || v === defaultAgentLabel ? null : v)}
                disabled={!canWrite}
                appearance="field"
              />
              <FieldDescription className="text-xs">
                {tI18nComplete.raw('text12dc6dbd8fc8')}
              </FieldDescription>
            </Field>

            <Field data-disabled={!canWrite}>
              <FieldTitle>{tI18nComplete.raw('text5e2c614c23f0')}</FieldTitle>
              <ModelSelector
                models={models}
                providers={providers}
                selectedModel={model}
                unsetLabel={tI18nComplete.raw('texte8cb80e5c5cb')}
                onSelect={setModelDraft}
                disabled={!canWrite}
                appearance="field"
              />
              <FieldDescription className="text-xs">
                {/* What the unset or refused pin runs instead, when it is known. */}
                {modelDraft === undefined &&
                binding.effectiveModel.source !== 'explicit' &&
                (binding.opencodeModel || binding.effectiveModel.model)
                  ? `${describeEffectiveModel(binding)}. `
                  : null}
                {tI18nComplete.raw('text9116af1ce384')}
              </FieldDescription>
            </Field>

            <Field data-disabled={!canWrite}>
              <FieldTitle>{tI18nComplete.raw('textb1ca871c6696')}</FieldTitle>
              <Select
                value={policy}
                onValueChange={(v) => setPolicyDraft(v as ChannelBinding['conversationPolicy'])}
                disabled={!canWrite}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {conversationPolicies.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription className="text-xs">
                {policyDescription(policy, tI18nComplete)}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </ModalBody>
        <ModalFooter className="pt-2 pb-5 sm:justify-between">
          {/* The way out is back to the list, for every member; unsaved
              picks are dropped. */}
          <Button type="button" variant="outline-ghost" className="gap-1" onClick={onBack}>
            <CaretLeftIcon className="size-3.5 shrink-0" />
            {tI18nComplete.raw('text76900f1bfd16')}
          </Button>
          {canWrite ? (
            <Button type="submit" disabled={!dirty || update.isPending}>
              {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('text1509f561f241')}
            </Button>
          ) : null}
        </ModalFooter>
      </form>
    </ModalContent>
  );
}

/** A conversation's display name: the Slack or Teams name, else its kind. */
function bindingName(binding: ChannelBinding, tI18nComplete: UiTranslator): string {
  if (binding.platform === 'slack') return slackBindingName(binding, tI18nComplete);
  return binding.channelName ?? bindingFallbackName(binding, tI18nComplete);
}

/** The line under the name: the conversation's kind, or a Teams channel thread's title. */
function bindingScope(binding: ChannelBinding, tI18nComplete: UiTranslator): string {
  if (binding.platform === 'teams') {
    // Every thread of a channel is its own binding named `Team › Channel`;
    // its session title tells them apart.
    if (binding.threadTitle) return tI18nComplete('text5097881a690f', { title: binding.threadTitle });
    return bindingScopeLabel(binding.channelType, tI18nComplete);
  }
  if (binding.platform === 'slack') return slackScopeLabel(binding, tI18nComplete);
  return binding.workspaceId;
}


/**
 * A binding with no captured name.
 *
 * Teams conversation ids are ~100 characters
 * (`19:…@thread.tacv2;messageid=…`), so falling back to the raw id filled the
 * name column with an opaque string that told a reader nothing — seen on dev
 * for channels bound before the name was read off the activity. The scope
 * reads better, and the full id is still on the row's `title`.
 */
function bindingFallbackName(
  binding: { platform: string; channelId: string; channelType: string | null },
  tI18nComplete: UiTranslator,
): string {
  if (binding.platform !== 'teams') return binding.channelId;
  // A thread bound before its kind was read has none stored; its id says it.
  if (binding.channelType === 'channel' || binding.channelId.includes(';messageid=')) return tI18nComplete.raw('text5cb103d6008c');
  return tI18nComplete.raw('text31d248c44579');
}

type SlackBindingLabel = Pick<ChannelBinding, 'channelId' | 'channelName' | 'channelType' | 'channelUnavailable'>;

/**
 * A Slack row reads `#general`, a person's name for a DM, or the members of a
 * group DM: the name the API stores after asking Slack. Until then, or when
 * Slack no longer has the conversation, the kind says what it is and the id
 * stays on the row's `title`.
 */
function slackBindingName(binding: SlackBindingLabel, tI18nComplete: UiTranslator): string {
  const name = slackConversationName(binding);
  if (name) return name;
  if (binding.channelUnavailable) return tI18nComplete.raw('textf5738ddc651d');
  if (binding.channelType === 'im') return tI18nComplete.raw('textcd3e16057d09');
  if (binding.channelType === 'mpim') return tI18nComplete.raw('textcbe7c5d45160');
  return binding.channelId;
}

/** Slack rows: the conversation's kind, not the workspace id every row shared. */
function slackScopeLabel(binding: SlackBindingLabel, tI18nComplete: UiTranslator): string {
  // A deleted channel has no kind left to show; its id is what identifies it.
  if (binding.channelUnavailable) return binding.channelId;
  switch (binding.channelType) {
    case 'private_channel':
      return tI18nComplete.raw('text87f9f3ba9b60');
    case 'im':
      return tI18nComplete.raw('textcd3e16057d09');
    case 'mpim':
      return tI18nComplete.raw('textcbe7c5d45160');
    case 'channel':
      return tI18nComplete.raw('textce4683e7013a');
    default:
      return tI18nComplete.raw('textda7d161a2777');
  }
}

/** Teams rows: the conversation scope reads better than a tenant GUID underneath the name. */
function bindingScopeLabel(channelType: string | null, tI18nComplete: UiTranslator): string {
  if (channelType === 'personal') return tI18nComplete.raw('text895ce927db2e');
  if (channelType === 'groupChat') return tI18nComplete.raw('text28c7d3f8b75d');
  return tI18nComplete.raw('textce4683e7013a');
}

function errorToastFallback(error: unknown, tI18nComplete: UiTranslator) {
  errorToast(error instanceof Error ? error.message : tI18nComplete.raw('textf8bc408a8d81'));
}

/**
 * The API's one-click install callback lands here with `?teams=<status>`.
 * Turn it into a toast once and strip it from the URL so a reload does not
 * repeat it. The install row itself renders the PERSISTED outcome
 * (`publishState`), so this is only the announcement — a `publishing` status
 * keeps the row live through the SDK hook's polling.
 */
function useTeamsInstallReturnToast() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const searchParams = useUiSearchParams();
  const router = useUiRouter();
  const pathname = useUiPathname();
  const status = searchParams?.get('teams') ?? null;

  useEffect(() => {
    if (!status) return;
    switch (status) {
      case 'connected':
        successToast(tI18nComplete.raw('textbfd886d0029b'));
        break;
      case 'review':
        infoToast(tI18nComplete.raw('text65228e6e414d'));
        break;
      case 'failed':
        errorToast(tI18nComplete.raw('textf5262c55d1be'));
        break;
      case 'publishing':
        infoToast(tI18nComplete.raw('text76930360e909'));
        break;
      case 'declined':
        warningToast(tI18nComplete.raw('textb8d155eea2ab'));
        break;
      case 'unconfigured':
        warningToast(tI18nComplete.raw('text57ef9e5e8110'));
        break;
      default:
        break;
    }
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    next.delete('teams');
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [status, searchParams, router, pathname, tI18nComplete]);
}

/**
 * The org-catalog publish outcome, as a badge beside the row name. Null when
 * there is nothing to say: a manual/BYO install never publishes, and a
 * published app already shows its "Open in Teams" action.
 */
function TeamsPublishBadge({
  install,
  tI18nComplete,
}: {
  install: TeamsInstallation;
  tI18nComplete: UiTranslator;
}) {
  switch (install.publishState) {
    case 'publishing':
      return (
        <Badge variant="muted">
          <Loading className="size-3" />
          {tI18nComplete.raw('text36f6474748b3')}
        </Badge>
      );
    case 'review':
      return <Badge variant="warning">{tI18nComplete.raw('text45b9df5730ac')}</Badge>;
    case 'failed':
      return (
        <Badge variant="destructive" title={install.publishError ?? undefined}>
          {tI18nComplete.raw('textdf5e72815836')}
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * The org catalog serves an older Kortix app than this deployment publishes.
 * On 1.0.0 (no permission to read channel messages) every thread read in a
 * team fails. Two people fix it, in order: a Teams admin publishes the update
 * (the Teams row's button), then a team owner accepts it in each team where
 * Teams offers it. Teams never installs an update that adds a permission or a
 * message action on its own, and that second step is the one nobody guesses,
 * so the notice names it. The server decides when to show it.
 */
function TeamsAppUpdateNotice({
  install,
  tI18nComplete,
}: {
  install: TeamsInstallation;
  tI18nComplete: UiTranslator;
}) {
  const latest = install.latestAppVersion ?? '';
  return (
    <InfoBanner tone="warning" title={tI18nComplete.raw('text80043b03898d')}>
      {install.appVersion
        ? tI18nComplete('textdf757dbe33eb', { value0: install.appVersion, value1: latest })
        : tI18nComplete('textcd2c4b26eedd', { value0: latest })}
    </InfoBanner>
  );
}

function TeamsChannelRow({
  projectId,
  canWrite,
  channelCount,
  onOpenChannels,
}: {
  projectId: string;
  canWrite: boolean;
  channelCount: number;
  onOpenChannels: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tPages = useTranslations('connectorPages');
  const { data: install } = useTeamsInstall(projectId);
  const { data: mode } = useTeamsMode(projectId);
  const disconnect = useDisconnectTeams();

  const connected = Boolean(install);
  const installUrl = mode?.orgConsentUrl ?? null;
  const deepLinkUrl = install?.orgInstalled ? (mode?.deepLinkUrl ?? null) : null;
  // The consent URL doubles as the retry AND the upgrade: consenting again
  // re-runs the publish against the tenant that is already bound, and for an
  // app already in the catalog the API submits this manifest version as a new
  // app definition. Hidden only while a publish is in flight or awaiting
  // review; a BYO install has no consent URL, so it never shows.
  const publishInFlight =
    install?.publishState === 'publishing' || install?.publishState === 'review';
  const retryUrl = install && !publishInFlight ? installUrl : null;
  const retryLabel =
    install?.publishState === 'failed'
      ? tI18nComplete.raw('text942087cc2d41')
      : install?.appUpdateAvailable
        ? tI18nComplete.raw('texte15f213fa506')
        : tI18nComplete.raw('text8ccfe10f2f2d');
  // The Graph reason, verbatim, under the row: a tooltip on the badge is not
  // discoverable enough for the one line that says what to fix.
  const detail =
    install?.publishState === 'failed' && install.publishError
      ? `${install.teamName ?? install.tenantId} · ${install.publishError}`
      : (install?.teamName ?? install?.tenantId ?? null);

  return (
    <ChannelRow
      app="teams"
      name="Microsoft Teams"
      connected={connected}
      detail={detail}
      pitch={tI18nComplete.raw('text9225e456b795')}
      hero={{
        title: tI18nComplete.raw('textc1bd5ca19f5f'),
        connectedTitle: tPages('channelConnectedTitle', { name: 'Microsoft Teams' }),
        preview: <TeamsChannelMock />,
      }}
      badge={install ? <TeamsPublishBadge install={install} tI18nComplete={tI18nComplete} /> : null}
      actions={
        <>
          {connected && channelCount > 0 ? (
            <ChannelsButton count={channelCount} onOpen={onOpenChannels} />
          ) : null}
          {!canWrite ? null : connected ? (
          <>
            {deepLinkUrl ? (
              <Button size="sm" variant="secondary" asChild>
                <Link href={deepLinkUrl} target="_blank" rel="noopener noreferrer">
                  {tI18nComplete.raw('text1fece1858ee9')}
                </Link>
              </Button>
            ) : null}
            {retryUrl ? (
              <Button size="sm" variant="secondary" asChild>
                <Link href={retryUrl} target="_blank" rel="noopener noreferrer">
                  {retryLabel}
                </Link>
              </Button>
            ) : null}
            <ChannelDisconnectButton
              pending={disconnect.isPending}
              onConfirm={(done) =>
                disconnect.mutate(projectId, {
                  onSuccess: () => {
                    done();
                    successToast(tI18nComplete.raw('textf2e69a5e24ba'));
                  },
                })
              }
            />
          </>
        ) : installUrl ? (
          <Button className="transition-transform active:scale-96" asChild>
            <Link href={installUrl} target="_blank" rel="noopener noreferrer">
              {tI18nComplete.raw('text1a2303ede074')}
            </Link>
          </Button>
        ) : null}
        </>
      }
    />
  );
}

