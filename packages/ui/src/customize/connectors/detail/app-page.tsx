'use client';
import { DetailPageShell } from './detail-page-shell';
import { ConnectorLogo } from '../../../internal/connector-logo/connector-logo';
import { ChannelHeroLogoInHeader } from '../../sections/component/channel-hero-frame';
import { discoverLogoSource, type ConnectorLogoSource } from '../../../internal/connector-logo/connector-logo-source';
import { ComputerAppPage } from './computer-app-page';

import {
  getDiscoverConnector,
  getDiscoverConnectorTools,
  getProjectDetail,
  listConnections,
  listConnectors,
} from '@kortix/sdk';
import { contract, FRESHNESS, qk, useProjectAccountId } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  DotsThreeIcon,
  GlobeIcon,
  PlugIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { lazyClient } from '../../../lib/lazy-client';
import { UiLink as Link, useUiRouter, useUiSearchParams } from '../../../providers/ui-provider';
import { Fragment, useEffect, useState, type ReactNode } from 'react';

import { Badge } from '../../../primitives/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../primitives/dropdown-menu';
import { humanizeToolName, toolBucket } from '../tools/tool-groups';
import { connectorAccounts } from './use-connector-detail';
import { Button } from '../../../primitives/button';
import { Skeleton } from '../../../primitives/skeleton';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import {
  type CatalogEntry,
  appNameKey,
  catalogEntryConnectors,
  connectToolkitApp,
} from '../catalog/catalog-entry';
import {
  listConnectCatalogPage,
  useConnectProviderStatus,
} from '../catalog/use-catalog';
import {
  connectorDisplayName,
  connectorSummary,
} from '../connector-filter';
import {
  COMPUTER_APP_ID,
  appHref,
  appRefFromLocation,
  connectorHref,
  connectorsHref,
  waysFromParams,
} from '../connector-routes';
import {
  discoverInstallTarget,
  easyConnectInstallTarget,
  type InstallTarget,
} from '../install/install';
import { InstallButton } from '../install/install-menu';
import { InstallDialog, wayDescription } from '../install/install-dialog';
import { wayKindLabel, type WayKind } from '../install/way-kind';
import {
  installableVariants,
  surfaceInstallName,
} from '../install/pick-surface';
import { mcpServerFor, type McpServerApp } from '../install/mcp-first';
import { useInstall } from '../install/use-install';
import { providerLabel } from '../provider-label';
import { useTranslations } from '../../../i18n';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCan } from '../../../internal/lib/use-project-can';

import { connectorRunsOver, connectorStatusTone } from './connector-status';
import { ProviderInfo, providerName } from './provider-info';
import { ConnectorStatusBadge } from './status-badge';

/** The same column as the connector page beside this one (`connector-page.tsx`). */

/** A surface row under "Ways to connect". The surface modal's own row. */
const SURFACE_ROW = 'flex items-center gap-3 px-4 py-3';

/** One bordered group of rows, divided. Shared by both lists on the page. */
const ROW_GROUP = 'bg-popover divide-y overflow-hidden rounded-md border';

const surfaceLabel = (kind: string) => wayKindLabel(kind as WayKind);

/** Tools shown before "Show all". */
const TOOLS_PREVIEW = 40;

/** What the page needs from either catalogue. */
interface ResolvedApp {
  name: string;
  description: string | null;
  /** The logo source: the same as the app's catalogue card. */
  logo: ConnectorLogoSource;
  /** The install target of each way to connect, recommended first. `kind`
   *  is the badge beside the name. `variantId` reads its tools. */
  surfaces: Array<{
    key: string;
    label: string;
    kind: WayKind;
    /** `null` for a Kortix channel: it is set up on the channel page (`setupHref`). */
    target: InstallTarget | null;
    setupHref?: string;
    oneClick: boolean;
    recommended: boolean;
    variantId: string | null;
    url: string | null;
  }>;
  /** Surfaces Kortix cannot install, with where to read about them. */
  references: Array<{ key: string; label: string; kind: string; href: string | null }>;
}

/**
 * `/projects/<id>/customize/connectors/<app>` — one catalogue app: what it is,
 * the one Install button, the connectors this project already has for it, and
 * the other ways to connect it.
 *
 * It replaces the surface-picker modal. A non-default surface is chosen only
 * here, under "Ways to connect".
 */

const ChannelsSection = lazyClient(() =>
  import('../../sections/view/channels-view').then((m) => m.ChannelsSection),
);

const AddMcpServerDialog = lazyClient(() =>
  import('../add-mcp/add-mcp-server-dialog').then(
    (m) => m.AddMcpServerDialog,
  ),
);
export function AppPage({ projectId, appSegment }: { projectId: string; appSegment: string }) {
  const search = useUiSearchParams();
  if (search?.get('id') === COMPUTER_APP_ID) return <ComputerAppPage projectId={projectId} />;
  return <CatalogAppPage projectId={projectId} appSegment={appSegment} />;
}

function CatalogAppPage({ projectId, appSegment }: { projectId: string; appSegment: string }) {
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tSharing = useTranslations('accessSharing');
  const search = useUiSearchParams();
  const router = useUiRouter();
  const app = appRefFromLocation(appSegment, search);
  // `?ways=1`: stay on this page for an installed app (another profile).
  const ways = waysFromParams(search);

  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract(FRESHNESS.connectors),
  });

  // Same key and fetcher as the Accounts tab: the "Installed" rows count accounts like it.
  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
  });

  const projectQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = projectQuery.data?.project?.name ?? '';
  const everyoneLabel = projectName
    ? tSharing('everyone', { project: projectName })
    : tSharing('visibilityEveryone');

  // Which way's tools the Tools section lists: the recommended one until the
  // user picks another under "Ways to connect".
  const [toolsWay, setToolsWay] = useState<string | null>(null);
  const [allTools, setAllTools] = useState(false);
  const { appQuery, resolved, managed, detail, provider } = useAppData(projectId, app);
  const shownWay =
    resolved?.surfaces.find((surface) => surface.variantId !== null && surface.variantId === toolsWay) ??
    resolved?.surfaces.find((surface) => surface.variantId !== null) ??
    null;
  const toolsQuery = useQuery({
    queryKey: ['discover-connector-tools', projectId, detail?.item.id ?? null, shownWay?.variantId ?? null],
    queryFn: () => getDiscoverConnectorTools(projectId, detail?.item.id ?? '', shownWay?.variantId ?? undefined),
    enabled: Boolean(detail && shownWay?.variantId),
    staleTime: 15 * 60_000,
    retry: false,
  });

  const { install, ask, confirm, request, setRequest, pendingKey, setPendingKey } = useInstall(projectId);

  // The app's own MCP server, when Install connects through it (one-click
  // sign-in): the MCP dialog opens for it instead of the managed app.
  const [mcpApp, setMcpApp] = useState<McpServerApp | null>(null);
  // Which of this page's Install controls started the running install, so only
  // that one shows progress; the others are disabled until it ends.
  const [pendingControl, setPendingControl] = useState<string | null>(null);

  // One page per app: once the project has exactly one profile of it, the
  // app's page is that connector's page. A Kortix channel keeps its own page.
  const installedOnce =
    app && resolved && detail?.item.kind !== 'kortix' && !ways
      ? catalogEntryConnectors(connectorsQuery.data?.connectors ?? [], {
          source: app.source,
          slug: app.slug,
          name: resolved.name,
        } as CatalogEntry)
      : [];
  const redirectTo =
    installedOnce.length === 1 && app ? connectorHref(projectId, installedOnce[0]!.slug, { app }) : null;
  useEffect(() => {
    if (redirectTo) router.replace(redirectTo);
  }, [redirectTo, router]);

  // The connector list is part of the page, not a late addition: Install reads
  // it to reuse the app's connector, and a list that is still empty would make
  // it create a second one.
  if (redirectTo || (appQuery && (appQuery.isPending || connectorsQuery.isPending))) {
    return (
      <DetailPageShell busy>
        <Skeleton className="h-4 w-24 rounded-sm py-0" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 py-0" />
          <Skeleton className="h-6 w-48 rounded-sm py-0" />
        </div>
        <Skeleton className="h-16 w-full py-0" />
        <Skeleton className="h-16 w-full py-0" />
      </DetailPageShell>
    );
  }

  // A failed background refetch keeps its data, and the page with it.
  const failed =
    [appQuery, connectorsQuery].find((query) => query?.isError && query.data === undefined) ?? null;
  if (appQuery && failed) {
    return (
      <DetailPageShell>
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('text3f2d97c61a7e')}
          description={
            failed.error instanceof Error
              ? failed.error.message
              : tI18nComplete.raw('texta0c2cc1374d9')
          }
          action={
            <Button variant="outline" size="sm" onClick={() => void failed.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      </DetailPageShell>
    );
  }

  if (!app || !resolved) {
    return (
      <DetailPageShell>
        <EmptyState
          icon={PlugIcon}
          size="sm"
          title={t('notFoundTitle')}
          description={t('notFoundDescription')}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href={connectorsHref(projectId)}>{t('backToConnectors')}</Link>
            </Button>
          }
        />
      </DetailPageShell>
    );
  }

  const connectors = connectorsQuery.data?.connectors ?? [];
  // `catalogEntryConnectors` reads only `source`, `slug`, and `name`.
  const entry = { source: app.source, slug: app.slug, name: resolved.name } as CatalogEntry;
  const inProject = catalogEntryConnectors(connectors, entry);
  // `GMAIL_SEND_EMAIL` reads "Send email" on the Gmail page, as on the Tools tab.
  const appNames = [app.slug, resolved.name];
  const installing = pendingKey === app.slug;
  /** `name` tells the page's Install controls apart for assistive tech; `key`
   *  tells them apart for the progress indicator. */
  type Surface = ResolvedApp['surfaces'][number];
  /** Install one way: a one-click MCP server opens the MCP dialog, which
   *  names the profile; every other way asks for the name first. */
  const startInstall = (key: string, surface: Surface, name: string, asNewProfile = false) => {
    const target = surface.target;
    if (!target) return;
    setPendingControl(key);
    // The way the user picked is the way installed.
    const mcpUrl = surface.kind === 'mcp' && surface.oneClick ? surface.url : null;
    const askName = () =>
      ask({ target, way: { kind: surface.kind, oneClick: surface.oneClick, provider: target.provider }, connectors, app, asNewProfile });
    if (!mcpUrl) {
      askName();
      return;
    }
    setPendingKey(app.slug);
    void mcpServerFor(projectId, { name, directMcpUrl: mcpUrl }).then((server) => {
      setPendingKey(null);
      if (server) setMcpApp(server);
      else askName();
    });
  };
  /** `name` tells the page's Install controls apart for assistive tech; `key`
   *  tells them apart for the progress indicator. */
  // The profile this way already installed, if any: its action is Add
  // account on that profile, never a second profile.
  const installedFor = (surface: Surface) =>
    surface.target ? inProject.find((connector) => connector.provider === surface.target?.provider) ?? null : null;
  const installMenu = (key: string, surface: Surface, variant: 'default' | 'secondary', name: string) => {
    const installed = installedFor(surface);
    if (installed && !surface.setupHref) {
      const addAccount = (
        <Button asChild size="sm" variant={variant} className="shrink-0">
          <Link
            href={connectorHref(projectId, installed.slug, { app, addAccount: true })}
            aria-label={t('addAccountNamed', { name: connectorDisplayName(installed) })}
          >
            {tSharing('addAccount')}
          </Link>
        </Button>
      );
      // The header holds one action. A second profile of an installed way is
      // rare and quiet: the row's overflow menu, never a button beside Add account.
      if (key === 'header' || !canWrite) return addAccount;
      return (
        <span className="flex shrink-0 items-center gap-1">
          {addAccount}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t('wayMoreNamed', { name })}
                disabled={installing}
              >
                <DotsThreeIcon className="size-4 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => startInstall(key, surface, name, true)}>
                {t('anotherProfileTitle')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      );
    }
    return surface.setupHref ? (
      <Button asChild size="sm" variant={variant} className="shrink-0">
        <Link href={surface.setupHref} aria-label={t('setUpNamed', { name })}>
          {t('waySetUp')}
        </Link>
      </Button>
    ) : canWrite ? (
      <InstallButton
        label={t('install')}
        aria-label={t('installNamed', { name })}
        variant={variant}
        onInstall={() => startInstall(key, surface, name)}
        pending={installing && pendingControl === key}
        disabled={installing}
      />
    ) : null;
  };
  const primary = resolved.surfaces[0] ?? null;
  // A Kortix channel's own page draws the channel as its hero; the ways list
  // keeps only the other ways (the vendor's MCP server, Composio, the API).
  // Computer has a page of its own (`ComputerAppPage`).
  const kortixApp = detail?.item.kind === 'kortix' ? (detail.item.kortix?.app ?? null) : null;
  const channelPlatform = kortixApp && kortixApp !== 'computer' ? kortixApp : null;
  const waySurfaces = channelPlatform
    ? resolved.surfaces.filter((surface) => surface.kind !== 'kortix')
    : resolved.surfaces;
  const infoCells: Array<{
    key: string;
    label: string;
    labelAddon?: ReactNode;
    value: ReactNode;
  }> = [];
  // The Provider cell follows the primary way to connect: the app itself for
  // its API/MCP server, the partner for a managed way.
  const managedBy =
    primary?.kind === 'composio'
      ? 'Composio'
      : primary?.kind === 'kortix'
        ? 'Kortix'
        : primary?.kind === 'pipedream'
          ? connectorRunsOver(provider)
          : null;
  if (primary)
    infoCells.push({
      key: 'provider',
      label: t('infoRunsThrough'),
      labelAddon: <ProviderInfo appName={resolved.name} managedBy={managedBy} />,
      value: providerName(resolved.name, managedBy),
    });
  if (managed) {
    const signIn = managedSignIn(managed.authType);
    if (signIn) infoCells.push({ key: 'auth', label: t('infoSignsInWith'), value: t(signIn) });
    const category = managed.categories[0];
    if (category)
      infoCells.push({
        key: 'category',
        label: t('infoCategory'),
        value: readableCategory(category),
      });
    if (managed.hasTriggers)
      infoCells.push({ key: 'events', label: t('infoAppEvents'), value: t('infoAppEventsYes') });
  }
  if (primary?.kind)
    infoCells.push({ key: 'runs', label: t('infoRunsOver'), value: wayKindLabel(primary.kind) });

  return (
    <DetailPageShell>
      <Button asChild variant="text" size="sm" className="-ml-1 w-fit px-0 has-[>svg]:px-0">
        <Link href={connectorsHref(projectId)}>
          <CaretLeftIcon className="size-3.5 shrink-0" />
          {tI18nComplete.raw('textc3d2e79ebdd0')}
        </Link>
      </Button>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <ConnectorLogo source={resolved.logo} size="lg" />
          <h1 className="text-foreground min-w-0 text-xl font-medium text-balance wrap-break-word">
            {resolved.name}
          </h1>
        </div>
        {primary && !channelPlatform ? (
          <div className="flex shrink-0 items-center gap-2">
            {resolved.surfaces.length > 1 && !installedFor(primary) ? (
              <span className="text-muted-foreground text-xs">
                {primary.kind === 'kortix'
                  ? t('setUpWhere')
                  : t('installsWay', { kind: wayKindLabel(primary.kind) })}
              </span>
            ) : null}
            {installMenu('header', primary, 'default', resolved.name) ?? (
              // A member without connector write: say who can, not nothing.
              <span className="text-muted-foreground text-xs">{t('askAdminToInstall')}</span>
            )}
          </div>
        ) : null}
      </header>

      {/* A Kortix channel's page: its hero, connected or not, says it all. */}
      {channelPlatform ? (
        // The header above shows the app's logo: the hero below does not repeat it.
        <ChannelHeroLogoInHeader>
          <ChannelsSection projectId={projectId} platform={channelPlatform} />
        </ChannelHeroLogoInHeader>
      ) : null}

      {!channelPlatform && (infoCells.length > 0 || resolved.description) ? (
        <div className="bg-popover divide-border divide-y overflow-hidden rounded-md border">
          {infoCells.length > 0 ? (
            <dl className="flex flex-wrap gap-x-8 gap-y-3 px-4 py-3">
              {infoCells.map((cell) => (
                <div key={cell.key} className="min-w-0 space-y-0.5">
                  <dt className="text-muted-foreground flex h-4 items-center justify-between gap-2 text-xs">
                    <span>{cell.label}</span>
                    {cell.labelAddon}
                  </dt>
                  <dd className="text-foreground truncate text-sm font-medium">{cell.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {resolved.description ? (
            <div className="space-y-1.5 px-4 py-4">
              <h2 className="text-muted-foreground text-xs">{t('overview')}</h2>
              <p className="text-foreground text-sm text-pretty">{resolved.description}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {inProject.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-foreground text-sm font-medium">
            {projectName ? t('installedIn', { project: projectName }) : t('installedHere')}
          </h2>
          <ul className={ROW_GROUP}>
            {inProject.map((connector) => {
              const tone = connectorStatusTone(
                connector,
                connectionsQuery.data ? connectorAccounts(connectionsQuery.data.connections, connector).length : undefined,
              );
              return (
                <li key={connector.slug}>
                  <Link
                    href={connectorHref(projectId, connector.slug, { app })}
                    className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3 transition-colors"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {connectorDisplayName(connector)}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {connectorSummary(connector, providerLabel(connector.provider))}
                      </span>
                    </span>
                    <span className="flex w-28 shrink-0 items-center">
                      <ConnectorStatusBadge tone={tone} />
                    </span>
                    <span className="text-muted-foreground flex w-16 shrink-0 items-center justify-end gap-1 text-xs">
                      {t('open')}
                      <CaretRightIcon aria-hidden className="size-4" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {resolved.surfaces.length === 0 && resolved.references.length === 0 ? (
        <EmptyState
          icon={GlobeIcon}
          size="sm"
          title={tI18nComplete.raw('text363579e1d66b')}
          description={tI18nComplete.raw('text4d286e47d580')}
        />
      ) : null}

      {/* One installable surface and nothing else is no choice: the header's
            Install covers it. */}
      {waySurfaces.length > (channelPlatform ? 0 : 1) || resolved.references.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-foreground text-sm font-medium">
            {channelPlatform ? t('otherWaysToConnect') : t('waysToConnect')}
          </h2>
          {waySurfaces.length > 0 ? (
          <ul className={ROW_GROUP}>
            {waySurfaces.map((surface) => (
              <li key={surface.key} className={SURFACE_ROW}>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="text-foreground truncate text-sm font-medium">{surface.label}</span>
                    <Badge variant="muted" size="xs">
                      {wayKindLabel(surface.kind)}
                    </Badge>
                    {surface.oneClick ? (
                      <Badge variant="secondary" size="xs">
                        {t('wayOneClick')}
                      </Badge>
                    ) : null}
                    {surface.recommended ? (
                      <Badge variant="success" size="xs">
                        {t('wayRecommended')}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground block text-xs text-pretty">
                    {wayDescription(t, { kind: surface.kind, oneClick: surface.oneClick, provider: surface.target?.provider }, resolved.name)}
                  </span>
                </span>
                {surface.variantId && detail ? (
                  <Button
                    type="button"
                    variant={shownWay?.variantId === surface.variantId ? 'secondary' : 'outline-ghost'}
                    size="sm"
                    aria-pressed={shownWay?.variantId === surface.variantId}
                    onClick={() => {
                      setToolsWay(surface.variantId);
                      setAllTools(false);
                    }}
                  >
                    {t('wayTools')}
                  </Button>
                ) : null}
                {installMenu(surface.key, surface, 'secondary', surface.label)}
              </li>
            ))}
          </ul>
          ) : null}
          {/* A way Kortix cannot install is a pointer, not a row with a dead end. */}
          {resolved.references.length > 0 ? (
            <p className="text-muted-foreground text-xs text-pretty">
              {t('otherWaysLead')}{' '}
              {resolved.references.map((reference, index) => (
                <Fragment key={reference.key}>
                  {index > 0 ? ', ' : null}
                  {reference.href ? (
                    <a
                      href={reference.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground inline-flex items-center gap-0.5 underline-offset-4 hover:underline"
                    >
                      {reference.label}
                      <ArrowSquareOutIcon aria-hidden className="size-3 shrink-0" />
                    </a>
                  ) : (
                    reference.label
                  )}
                </Fragment>
              ))}
            </p>
          ) : null}
        </section>
      ) : null}
      {shownWay ? (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-foreground text-sm font-medium">
              {t('toolsOf', { kind: wayKindLabel(shownWay.kind) })}
            </h2>
            {toolsQuery.data ? (
              <span className="text-muted-foreground text-xs tabular-nums">
                {t('toolsCount', { count: toolsQuery.data.total })}
              </span>
            ) : null}
          </div>
          {toolsQuery.isPending ? (
            <Skeleton className="h-24 w-full py-0" />
          ) : toolsQuery.isError ? (
            <p className="text-muted-foreground text-sm">{t('toolsUnavailable')}</p>
          ) : toolsQuery.data && toolsQuery.data.tools.length > 0 ? (
            <>
              <p className="text-muted-foreground text-xs">{t(`toolsSource_${toolsQuery.data.source}`)}</p>
              {groupAppTools(
                allTools ? toolsQuery.data.tools : toolsQuery.data.tools.slice(0, TOOLS_PREVIEW),
                appNames,
              ).map((group) => (
                <div key={group.key} className="space-y-2">
                  <h3 className="text-muted-foreground text-xs">
                    {tI18nComplete.raw(TOOL_GROUP_LABEL[group.key])} · {group.tools.length}
                  </h3>
                  <ul className={ROW_GROUP}>
                    {group.tools.map((tool) => {
                      const title = humanizeToolName(tool.name, appNames);
                      return (
                        <li key={tool.name} className="min-w-0 px-4 py-2.5">
                          {/* The Tools tab's row: the title in words, the id in mono, one line of description. */}
                          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                            <span className="text-foreground text-sm font-medium">{title}</span>
                            {title !== tool.name ? (
                              <code className="text-muted-foreground max-w-full truncate font-mono text-xs">
                                {tool.name}
                              </code>
                            ) : null}
                          </span>
                          {tool.description ? (
                            <span className="text-muted-foreground block truncate text-xs" title={tool.description}>
                              {tool.description}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {!allTools && toolsQuery.data.tools.length > TOOLS_PREVIEW ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setAllTools(true)}>
                  {t('toolsShowAll', { count: toolsQuery.data.tools.length })}
                </Button>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t('toolsAfterInstall', { kind: wayKindLabel(shownWay.kind) })}
            </p>
          )}
        </section>
      ) : null}
      {request ? (
        <InstallDialog
          key={request.target.appName}
          appName={request.target.appName}
          way={request.way}
          open
          pending={false}
          onOpenChange={(open) => !open && setRequest(null)}
          onConfirm={confirm}
        />
      ) : null}
      {mcpApp ? (
        <AddMcpServerDialog
          key={mcpApp.url}
          projectId={projectId}
          app={mcpApp}
          open
          onOpenChange={(open) => !open && setMcpApp(null)}
          takenSlugs={connectors.map((connector) => connector.slug)}
          onAdded={() => void connectorsQuery.refetch()}
        />
      ) : null}
    </DetailPageShell>
  );
}

const TOOL_GROUP_LABEL = {
  read: 'textdd28b5cb26fd',
  write: 'texted26c1af81cf',
  unclassified: 'text7c0a91e5b3d2',
} as const;

/** A catalogue way's tools in the Tools tab's buckets, by the same rule. */
function groupAppTools<T extends { name: string; description?: string | null; risk?: string | null }>(
  tools: readonly T[],
  appNames: readonly string[],
) {
  const groups = { read: [] as T[], write: [] as T[], unclassified: [] as T[] };
  for (const tool of tools) {
    groups[toolBucket({ path: tool.name, name: tool.name, risk: tool.risk ?? 'unknown' }, appNames)].push(tool);
  }
  return (['read', 'write', 'unclassified'] as const)
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, tools: groups[key] }));
}

/** The managed catalogue's `authType` as a `connectorPages` key. */
function managedSignIn(authType: string | null): 'authOAuth' | 'authApiKey' | 'authNone' | null {
  if (authType === 'oauth') return 'authOAuth';
  if (authType === 'keys') return 'authApiKey';
  if (authType === 'none') return 'authNone';
  return null;
}

/** A catalogue category key as words: `images-&-design` → `Images & design`. */
function readableCategory(key: string): string {
  const words = key.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function useAppData(projectId: string, app: ReturnType<typeof appRefFromLocation>) {
  const connectStatus = useConnectProviderStatus(true);
  const provider = connectStatus.provider ?? 'composio';
  // Same key as the install hook: one fetch.
  const discoverId = app?.id ?? null;
  const discoverQuery = useQuery({
    queryKey: ['discover-connector-detail', projectId, discoverId],
    queryFn: () => getDiscoverConnector(projectId, discoverId ?? ''),
    enabled: discoverId !== null,
    staleTime: 15 * 60_000,
  });
  // The managed (Composio) twin found by name: it adds the sign-in, category
  // and app-event facts, and is a way to connect when the record lists none.
  const twinName = discoverQuery.data?.item.name ?? null;
  const managedTwinQuery = useQuery({
    queryKey: ['easy-connect-twin', projectId, provider, twinName],
    queryFn: async () => {
      const page = await listConnectCatalogPage({
        projectId,
        provider,
        q: twinName ?? '',
        limit: 10,
      });
      const key = appNameKey(twinName ?? '');
      return page.apps.find((candidate) => appNameKey(candidate.name) === key) ?? null;
    },
    enabled:
      twinName !== null &&
      (connectStatus.state === 'configured' || connectStatus.state === 'unknown'),
    staleTime: 5 * 60_000,
  });

  // The query that resolves this app, or `null` when nothing can.
  const appQuery = app ? discoverQuery : null;

  const detail = discoverId !== null ? discoverQuery.data : undefined;
  const managed = managedTwinQuery.data ?? undefined;
  // The managed app as one more way to connect, after the API/MCP surfaces,
  // unless the catalogue already lists it (it ranks every way).
  const listsComposio = detail?.variants.some((variant) => variant.kind === 'composio') === true;
  const managedSurface =
    managed && !listsComposio
      ? {
          key: `managed:${managed.slug}`,
          label: managed.name,
          kind: (provider === 'pipedream' ? 'pipedream' : 'composio') as WayKind,
          target: easyConnectInstallTarget(managed),
          oneClick: true,
          recommended: false,
          variantId: null,
          url: null,
        }
      : null;
  const installable = detail ? installableVariants(detail.variants) : [];
  const resolved: ResolvedApp | null = detail
    ? {
        name: managed?.name ?? detail.item.name,
        description: detail.item.description ?? managed?.description ?? null,
        // The catalogue card's source, so the page and the card show one logo.
        logo: discoverLogoSource(detail.item),
        // Server order: best way first, the recommended one marked.
        surfaces: [
          ...detail.variants.flatMap((variant): ResolvedApp['surfaces'] => {
            if (variant.kind === 'kortix') {
              return [
                {
                  key: `kortix:${variant.id}`,
                  label: variant.name,
                  kind: 'kortix' as WayKind,
                  target: null,
                  setupHref: appHref(projectId, { source: 'discover', slug: variant.kortix?.app ?? 'kortix', id: variant.id }),
                  oneClick: true,
                  recommended: variant.recommended === true,
                  variantId: null,
                  url: null,
                },
              ];
            }
            if (variant.kind === 'composio') {
              return variant.composio
                ? [
                    {
                      key: `composio:${variant.id}`,
                      label: variant.name,
                      kind: 'composio' as WayKind,
                      target: easyConnectInstallTarget(connectToolkitApp(variant.composio)),
                      oneClick: true,
                      recommended: variant.recommended === true,
                      variantId: variant.id,
                      url: null,
                    },
                  ]
                : [];
            }
            const index = installable.findIndex((candidate) => candidate.id === variant.id);
            const usable = installable[index];
            if (!usable) return [];
            return [
              {
                key: `${variant.kind}:${variant.id}`,
                label: variant.name,
                kind: variant.kind as WayKind,
                target: discoverInstallTarget(surfaceInstallName(detail.item.name, usable, index), usable),
                oneClick: variant.oneClick === true,
                recommended: variant.recommended === true,
                variantId: variant.id,
                url: variant.url,
              },
            ];
          }),
          ...(managedSurface ? [managedSurface] : []),
        ],
        references: detail.variants
          .filter((variant) => !variant.connector && variant.kind !== 'composio' && variant.kind !== 'kortix')
          .map((variant) => ({
            key: `${variant.kind}:${variant.id}`,
            label: variant.name,
            kind: surfaceLabel(variant.kind),
            href: variant.docs ?? variant.url,
          })),
      }
    : null;

  return { appQuery, resolved, managed, detail, provider };
}
