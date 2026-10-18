'use client';
import { DetailPageShell } from './detail-page-shell';

import { getDiscoverConnector, getProjectDetail, listConnectors } from '@kortix/sdk';
import { contract, FRESHNESS, qk, useProjectAccountId } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  GlobeIcon,
  PlugIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  type CatalogEntry,
  appNameKey,
  catalogEntryConnectors,
  discoverEntryIcon,
} from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
import {
  listConnectCatalogPage,
  useConnectProviderStatus,
} from '@/features/workspace/capabilities/connectors/catalog/use-catalog';
import {
  connectorDisplayName,
  connectorSummary,
} from '@/features/workspace/capabilities/connectors/connector-filter';
import {
  appRefFromLocation,
  connectorHref,
  connectorsHref,
} from '@/features/workspace/capabilities/connectors/connector-routes';
import {
  discoverInstallTarget,
  easyConnectInstallTarget,
  type InstallTarget,
} from '@/features/workspace/capabilities/connectors/install/install';
import { InstallButton } from '@/features/workspace/capabilities/connectors/install/install-menu';
import {
  installableVariants,
  surfaceInstallName,
} from '@/features/workspace/capabilities/connectors/install/pick-surface';
import { mcpServerFor, type McpServerApp } from '@/features/workspace/capabilities/connectors/install/mcp-first';
import { useInstall } from '@/features/workspace/capabilities/connectors/install/use-install';
import { providerLabel } from '@/features/workspace/capabilities/connectors/provider-label';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { connectorRunsOver, connectorStatusTone } from './connector-status';
import { findEasyConnectApp } from './find-easy-connect-app';
import { ProviderInfo, providerName } from './provider-info';
import { ConnectorStatusBadge } from './status-badge';

/** The same column as the connector page beside this one (`connector-page.tsx`). */

/** A surface row under "Ways to connect". The surface modal's own row. */
const SURFACE_ROW = 'flex items-center gap-3 px-4 py-3';

/** One bordered group of rows, divided. Shared by both lists on the page. */
const ROW_GROUP = 'bg-popover divide-y overflow-hidden rounded-md border';

const surfaceLabel = (kind: string) => (kind === 'openapi' ? 'OpenAPI' : kind.toUpperCase());

/**
 * The app page's icon tile (`ConnectorAppIcon`, size `lg`): the resolved
 * favicon, or the glyph tile when the record has none — and the same glyph
 * tile when the URL fails to load, which used to render the browser's
 * broken-image glyph beside the title. Mirrors the catalogue card's
 * `ConnectorIcon`. The latch is per URL (`failedUrl`), so the late-arriving
 * managed logo — which swaps the URL — gets a fresh try without a call-site
 * key.
 */
function AppIcon({ icon, name }: { icon: string | null; name: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!icon || failedUrl === icon) {
    return <EntityAvatar icon={GlobeIcon} size="lg" label={name} />;
  }
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm">
      {/* eslint-disable-next-line @next/next/no-img-element -- a third-party favicon; the Next loader is bypassed anyway. */}
      <img
        src={icon}
        alt=""
        width={36}
        height={36}
        referrerPolicy="no-referrer"
        className="size-9 object-contain"
        onError={() => setFailedUrl(icon)}
      />
    </span>
  );
}

/** What the page needs from either catalogue. */
interface ResolvedApp {
  name: string;
  description: string | null;
  icon: string | null;
  /** The install target of each surface, recommended first. `kind` is the
   *  badge beside the name; a managed surface has none. */
  surfaces: Array<{ key: string; label: string; kind: string | null; target: InstallTarget }>;
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

const AddMcpServerDialog = dynamic(
  () =>
    import('@/features/workspace/capabilities/connectors/add-mcp/add-mcp-server-dialog').then(
      (m) => m.AddMcpServerDialog,
    ),
  { ssr: false },
);
export function AppPage({ projectId, appSegment }: { projectId: string; appSegment: string }) {
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tSharing = useTranslations('accessSharing');
  const search = useSearchParams();
  const app = appRefFromLocation(appSegment, search);

  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract(FRESHNESS.connectors),
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

  const { appQuery, waiting, resolved, managed, detail, provider } = useAppData(projectId, app);

  const { install, pendingKey, setPendingKey } = useInstall(projectId);
  // The app's own MCP server, when Install connects through it (one-click
  // sign-in): the MCP dialog opens for it instead of the managed app.
  const [mcpApp, setMcpApp] = useState<McpServerApp | null>(null);
  // Which of this page's Install controls started the running install, so only
  // that one shows progress; the others are disabled until it ends.
  const [pendingControl, setPendingControl] = useState<string | null>(null);

  // The connector list is part of the page, not a late addition: Install reads
  // it to reuse the app's connector, and a list that is still empty would make
  // it create a second one.
  if (waiting || (appQuery && (appQuery.isPending || connectorsQuery.isPending))) {
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
  const installing = pendingKey === app.slug;
  /** `name` tells the page's Install controls apart for assistive tech; `key`
   *  tells them apart for the progress indicator. */
  const installMenu = (
    key: string,
    target: InstallTarget,
    variant: 'default' | 'secondary',
    name: string,
  ) =>
    canWrite ? (
      <InstallButton
        label={t('install')}
        aria-label={t('installNamed', { name })}
        variant={variant}
        onInstall={() => {
          setPendingControl(key);
          const mcpUrl = target.managed ? managed?.directMcpUrl : null;
          if (!mcpUrl) {
            install(target, { connectors, app });
            return;
          }
          setPendingKey(app.slug);
          void mcpServerFor(projectId, { name: name, directMcpUrl: mcpUrl }).then((server) => {
            setPendingKey(null);
            if (server) setMcpApp(server);
            else install(target, { connectors, app });
          });
        }}
        pending={installing && pendingControl === key}
        disabled={installing}
      />
    ) : null;
  const primary = resolved.surfaces[0] ?? null;
  const waysCount = resolved.surfaces.length + resolved.references.length;
  const infoCells: Array<{
    key: string;
    label: string;
    labelAddon?: ReactNode;
    value: ReactNode;
  }> = [];
  // The Provider cell follows the primary way to connect: the app itself for
  // its API/MCP server, Kortix for a managed-only app.
  const managedOnly = managed && !detail;
  const managedBy = managedOnly ? connectorRunsOver(provider) : null;
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
  if (primary?.kind) infoCells.push({ key: 'runs', label: t('infoRunsOver'), value: primary.kind });
  if (waysCount > 1)
    infoCells.push({ key: 'ways', label: t('waysToConnect'), value: String(waysCount) });

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
          <AppIcon icon={resolved.icon} name={resolved.name} />
          <h1 className="text-foreground min-w-0 text-xl font-medium text-balance wrap-break-word">
            {resolved.name}
          </h1>
        </div>
        {primary ? (
          <div className="shrink-0">
            {installMenu('header', primary.target, 'default', resolved.name)}
          </div>
        ) : null}
      </header>

      {infoCells.length > 0 || resolved.description ? (
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
          <div className="space-y-1">
            <h2 className="text-foreground text-sm font-medium">
              {projectName ? t('installedIn', { project: projectName }) : t('installedHere')}
            </h2>
            <p className="text-muted-foreground text-xs">{t('installedHint')}</p>
          </div>
          <ul className={ROW_GROUP}>
            {inProject.map((connector) => {
              const tone = connectorStatusTone(connector);
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
      {resolved.surfaces.length > 1 || resolved.references.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-foreground text-sm font-medium">{t('waysToConnect')}</h2>
          <ul className={ROW_GROUP}>
            {resolved.surfaces.map((surface) => (
              <li key={surface.key} className={SURFACE_ROW}>
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="text-foreground truncate text-sm font-medium">
                    {surface.label}
                  </span>
                  {surface.kind ? (
                    <Badge variant="muted" size="xs">
                      {surface.kind}
                    </Badge>
                  ) : null}
                </span>
                {installMenu(surface.key, surface.target, 'secondary', surface.label)}
              </li>
            ))}
            {resolved.references.map((reference) => (
              <li key={reference.key} className={SURFACE_ROW}>
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="text-foreground truncate text-sm font-medium">
                    {reference.label}
                  </span>
                  <Badge variant="muted" size="xs">
                    {reference.kind}
                  </Badge>
                </span>
                {reference.href ? (
                  <Button asChild variant="outline" size="sm" className="shrink-0">
                    <a href={reference.href} target="_blank" rel="noreferrer">
                      {tI18nComplete.raw('text7af023c43013')}
                      <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                    </a>
                  </Button>
                ) : (
                  <Badge variant="secondary" size="sm">
                    {tI18nComplete.raw('textdf0453d185c4')}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </section>
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
  const t = useTranslations('connectorPages');
  const managedSlug = app?.source === 'easy-connect' ? app.slug : null;
  const connectStatus = useConnectProviderStatus(true);
  const provider = connectStatus.provider ?? 'composio';
  // `absent`: this deployment has no managed provider, so the app cannot exist.
  // `unknown` proceeds, as the catalogue does (`useCatalog`).
  const managedRunnable =
    managedSlug !== null &&
    (connectStatus.state === 'configured' || connectStatus.state === 'unknown');
  const managedQuery = useQuery({
    queryKey: ['easy-connect-app', projectId, provider, managedSlug],
    queryFn: () =>
      findEasyConnectApp(listConnectCatalogPage, { projectId, provider, slug: managedSlug ?? '' }),
    enabled: managedRunnable,
    staleTime: 5 * 60_000,
  });

  // One app, both ways to connect. A managed app names its API/MCP twin
  // (`directId`); an API/MCP app finds its managed twin by name below.
  // Same key as the install hook and the old surface modal: one fetch.
  const discoverId = app?.source === 'discover' ? app.id : (managedQuery.data?.directId ?? null);
  const discoverQuery = useQuery({
    queryKey: ['discover-connector-detail', projectId, discoverId],
    queryFn: () => getDiscoverConnector(projectId, discoverId ?? ''),
    enabled: discoverId !== null,
    staleTime: 15 * 60_000,
  });
  const twinName = app?.source === 'discover' ? (discoverQuery.data?.item.name ?? null) : null;
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
  const appQuery =
    app?.source === 'discover' ? discoverQuery : managedRunnable ? managedQuery : null;
  const waiting = managedSlug !== null && connectStatus.state === 'asking';

  const detail = discoverId !== null ? discoverQuery.data : undefined;
  const managed = (managedRunnable ? managedQuery.data : managedTwinQuery.data) ?? undefined;
  // The managed App as one more way to connect, after the API/MCP surfaces.
  const managedSurface = managed
    ? {
        key: `managed:${managed.slug}`,
        label: t('managedSurfaceLabel', { name: managed.name }),
        kind: 'App',
        target: easyConnectInstallTarget(managed),
      }
    : null;
  const resolved: ResolvedApp | null = detail
    ? {
        name: managed?.name ?? detail.item.name,
        description: detail.item.description ?? managed?.description ?? null,
        // The managed logo is sharp where the catalogue's favicon is not.
        icon: managed?.imgSrc ?? discoverEntryIcon(detail.item),
        surfaces: [
          ...installableVariants(detail.variants).map((variant, index) => ({
            key: `${variant.kind}:${variant.id}`,
            label: variant.name,
            kind: surfaceLabel(variant.kind),
            target: discoverInstallTarget(
              surfaceInstallName(detail.item.name, variant, index),
              variant,
            ),
          })),
          ...(managedSurface ? [managedSurface] : []),
        ],
        references: detail.variants
          .filter((variant) => !variant.connector)
          .map((variant) => ({
            key: `${variant.kind}:${variant.id}`,
            label: variant.name,
            kind: surfaceLabel(variant.kind),
            href: variant.docs ?? variant.url,
          })),
      }
    : managed
      ? {
          name: managed.name,
          description: managed.description,
          icon: managed.imgSrc,
          surfaces: managedSurface ? [managedSurface] : [],
          references: [],
        }
      : null;

  return { appQuery, waiting, resolved, managed, detail, provider };
}
