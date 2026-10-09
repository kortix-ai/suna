'use client';

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
  appNameKey,
  catalogEntryConnectors,
  type CatalogEntry,
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
import { InstallMenu } from '@/features/workspace/capabilities/connectors/install/install-menu';
import {
  installableVariants,
  surfaceInstallName,
} from '@/features/workspace/capabilities/connectors/install/pick-surface';
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
const PAGE_COLUMN = 'mx-auto w-full max-w-5xl space-y-6 px-4 py-10 pb-20 lg:py-14';

/** A surface row under "Ways to connect". The surface modal's own row. */
const SURFACE_ROW = 'flex items-center gap-3 px-4 py-3';

/** One bordered group of rows, divided. Shared by both lists on the page. */
const ROW_GROUP = 'bg-popover divide-y overflow-hidden rounded-md border';

const surfaceLabel = (kind: string) => (kind === 'openapi' ? 'OpenAPI' : kind.toUpperCase());

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
  const canShare =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, { accountId })
      .allowed === true;

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
  const discoverId =
    app?.source === 'discover' ? app.id : (managedQuery.data?.directId ?? null);
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

  const { install, pendingKey } = useInstall(projectId);
  // Which of this page's Install controls started the running install, so only
  // that one shows progress; the others are disabled until it ends.
  const [pendingControl, setPendingControl] = useState<string | null>(null);

  // The query that resolves this app, or `null` when nothing can.
  const appQuery =
    app?.source === 'discover' ? discoverQuery : managedRunnable ? managedQuery : null;
  const waiting = managedSlug !== null && connectStatus.state === 'asking';

  const detail = discoverId !== null ? discoverQuery.data : undefined;
  const managed =
    (managedRunnable ? managedQuery.data : managedTwinQuery.data) ?? undefined;
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
        icon: managed?.imgSrc ?? detail.item.icon,
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

  // The connector list is part of the page, not a late addition: Install reads
  // it to reuse the app's connector, and a list that is still empty would make
  // it create a second one.
  if (waiting || (appQuery && (appQuery.isPending || connectorsQuery.isPending))) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy>
        <div className={PAGE_COLUMN}>
          <Skeleton className="h-4 w-24 rounded-sm py-0" />
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 py-0" />
            <Skeleton className="h-6 w-48 rounded-sm py-0" />
          </div>
          <Skeleton className="h-16 w-full py-0" />
          <Skeleton className="h-16 w-full py-0" />
        </div>
      </div>
    );
  }

  // A failed background refetch keeps its data, and the page with it.
  const failed =
    [appQuery, connectorsQuery].find((query) => query?.isError && query.data === undefined) ?? null;
  if (appQuery && failed) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={PAGE_COLUMN}>
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
        </div>
      </div>
    );
  }

  if (!app || !resolved) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={PAGE_COLUMN}>
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
        </div>
      </div>
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
      <InstallMenu
        label={t('install')}
        aria-label={t('installNamed', { name })}
        variant={variant}
        canShare={canShare}
        onlyYou={tSharing('onlyYou')}
        everyone={everyoneLabel}
        onInstall={(audience) => {
          setPendingControl(key);
          install(target, audience, { connectors, app });
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={PAGE_COLUMN}>
        <Button asChild variant="text" size="sm" className="-ml-1 w-fit px-0 has-[>svg]:px-0">
          <Link href={connectorsHref(projectId)}>
            <CaretLeftIcon className="size-3.5 shrink-0" />
            {tI18nComplete.raw('textc3d2e79ebdd0')}
          </Link>
        </Button>

        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {resolved.icon ? (
              // The connector page's icon tile (`ConnectorAppIcon`, size `lg`).
              <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm">
                {/* eslint-disable-next-line @next/next/no-img-element -- a third-party favicon; the Next loader is bypassed anyway. */}
                <img
                  src={resolved.icon}
                  alt=""
                  width={36}
                  height={36}
                  referrerPolicy="no-referrer"
                  className="size-9 object-contain"
                />
              </span>
            ) : (
              <EntityAvatar icon={GlobeIcon} size="lg" label={resolved.name} />
            )}
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
      </div>
    </div>
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
