'use client';

import {
  getDiscoverConnector,
  listConnectors,
  listDiscoverConnectors,
  listPipedreamApps,
  type AdminConnector,
  type DiscoverConnectorDetail,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { GlobeIcon, MonitorIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import {
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  computersCatalogEntry,
  foldKey,
  type CatalogEntry,
} from '../catalog/catalog-entry';
import { connectedConnectorHref, parseCatalogSource } from '../connector-routes';
import { ConnectorAdvanced } from './connector-advanced';
import { connectorSetupSteps, type ConnectorTechnicalRow } from './connector-detail-copy';
import {
  ConnectorDetailLayout,
  ConnectorDocumentationLinks,
  ConnectorSetupGuide,
  type ConnectorDocumentationLink,
} from './connector-detail-layout';

const DiscoverAddFlow = dynamic(
  () => import('../add/discover-add-flow').then((module) => module.DiscoverAddFlow),
  { ssr: false },
);
const EasyConnectAddFlow = dynamic(
  () => import('../add/easy-connect-add-flow').then((module) => module.EasyConnectAddFlow),
  { ssr: false },
);
const ComputersAddFlow = dynamic(
  () => import('../add/computers-add-flow').then((module) => module.ComputersAddFlow),
  { ssr: false },
);

function CatalogDetailIcon({ entry }: { entry: CatalogEntry }) {
  if (entry.icon) {
    return (
      <span className="border-border/60 bg-card flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border">
        {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary third-party catalogue icons. */}
        <img
          src={entry.icon}
          alt=""
          width={40}
          height={40}
          referrerPolicy="no-referrer"
          className="size-10 object-contain"
        />
      </span>
    );
  }
  return (
    <span className="bg-primary/6 flex size-10 shrink-0 items-center justify-center rounded-md">
      {entry.source === 'computer' ? (
        <MonitorIcon className="size-5 shrink-0" />
      ) : (
        <GlobeIcon className="size-5 shrink-0" />
      )}
    </span>
  );
}

function CatalogConnectorSkeleton({ projectId }: { projectId: string }) {
  return (
    <ConnectorDetailLayout
      backHref={`/projects/${encodeURIComponent(projectId)}/connectors`}
      icon={<Skeleton className="size-10 shrink-0 rounded-md" />}
      title={<Skeleton className="h-7 w-52 rounded-sm" />}
      primaryTitle="Loading connector"
      primaryDescription="Reading catalogue metadata and connection requirements."
    >
      <Skeleton className="h-44 rounded-md" />
    </ConnectorDetailLayout>
  );
}

function exactConnectorMatch(
  connectors: readonly AdminConnector[],
  entry: CatalogEntry,
): AdminConnector | null {
  const keys = new Set([foldKey(entry.slug), foldKey(entry.name)]);
  return (
    connectors.find(
      (connector) => keys.has(foldKey(connector.slug)) || keys.has(foldKey(connector.name)),
    ) ?? null
  );
}

export function CatalogConnectorPage({
  projectId,
  sourceValue,
  slug,
}: {
  projectId: string;
  sourceValue: string;
  slug: string;
}) {
  const source = parseCatalogSource(sourceValue);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [actionOpen, setActionOpen] = useState(false);

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
  });
  const connectors = useMemo(() => connectorsQuery.data?.connectors ?? [], [connectorsQuery.data]);
  const existingSlugs = useMemo(() => connectors.map((item) => item.slug), [connectors]);

  const discoverQuery = useQuery({
    queryKey: ['catalog-connector-route', 'discover', projectId, slug],
    queryFn: async () => {
      const page = await listDiscoverConnectors(projectId, slug);
      return page.items.find((item) => foldKey(item.slug) === foldKey(slug)) ?? null;
    },
    enabled: source === 'discover',
    staleTime: 15 * 60_000,
  });
  const easyConnectQuery = useQuery({
    queryKey: ['catalog-connector-route', 'easy-connect', projectId, slug],
    queryFn: async () => {
      const page = await listPipedreamApps(projectId, slug);
      return (
        page.apps.find(
          (app) => foldKey(app.slug) === foldKey(slug) || foldKey(app.name) === foldKey(slug),
        ) ?? null
      );
    },
    enabled: source === 'easy-connect',
    staleTime: 15 * 60_000,
  });

  const discoverEntry: Extract<CatalogEntry, { source: 'discover' }> | null = discoverQuery.data
    ? (catalogEntryFromDiscover(discoverQuery.data) as Extract<
        CatalogEntry,
        { source: 'discover' }
      >)
    : null;
  const easyConnectEntry: Extract<CatalogEntry, { source: 'easy-connect' }> | null =
    easyConnectQuery.data
      ? (catalogEntryFromEasyConnect(easyConnectQuery.data) as Extract<
          CatalogEntry,
          { source: 'easy-connect' }
        >)
      : null;
  const entry =
    source === 'computer'
      ? computersCatalogEntry()
      : source === 'discover'
        ? discoverEntry
        : source === 'easy-connect'
          ? easyConnectEntry
          : null;

  const discoverDetailQuery = useQuery({
    queryKey: ['discover-connector-detail', projectId, discoverEntry?.connector.id],
    queryFn: () =>
      discoverEntry
        ? getDiscoverConnector(projectId, discoverEntry.connector.id)
        : Promise.reject(new Error('No Discover connector selected')),
    enabled: Boolean(discoverEntry),
    staleTime: 15 * 60_000,
  });

  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;

  if (!source) {
    return (
      <CatalogNotFound
        projectId={projectId}
        title="Catalogue source not found"
        description={`“${sourceValue}” is not a supported connector catalogue.`}
      />
    );
  }

  const entryLoading =
    (source === 'discover' && discoverQuery.isLoading) ||
    (source === 'easy-connect' && easyConnectQuery.isLoading);
  if (entryLoading) return <CatalogConnectorSkeleton projectId={projectId} />;

  const entryError =
    source === 'discover'
      ? discoverQuery.error
      : source === 'easy-connect'
        ? easyConnectQuery.error
        : null;
  if (entryError) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-12">
        <ErrorState
          size="sm"
          title="Couldn’t load connector"
          description={
            entryError instanceof Error ? entryError.message : 'The catalogue request failed.'
          }
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void (source === 'discover' ? discoverQuery.refetch() : easyConnectQuery.refetch())
              }
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!entry) {
    return (
      <CatalogNotFound
        projectId={projectId}
        title="Connector not found"
        description={`No ${source} catalogue connector matches “${slug}”.`}
      />
    );
  }

  const connectedConnector = exactConnectorMatch(connectors, entry);
  const discoverDetail = discoverDetailQuery.data ?? null;
  const added = (addedSlug?: string) => {
    setActionOpen(false);
    void queryClient.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    if (addedSlug) router.push(connectedConnectorHref(projectId, addedSlug));
  };

  const provider =
    entry.source === 'easy-connect'
      ? (entry.app.provider ?? 'pipedream')
      : entry.source === 'computer'
        ? 'computer'
        : entry.connector.kind === 'mcp'
          ? 'mcp'
          : entry.connector.kind === 'graphql'
            ? 'graphql'
            : 'openapi';
  const firstVariant = discoverDetail?.variants[0] ?? null;
  const requestAuthType =
    entry.source === 'easy-connect'
      ? entry.app.authType === 'oauth'
        ? 'oauth2'
        : entry.app.authType === 'none'
          ? 'none'
          : 'custom'
      : (firstVariant?.connector?.auth?.type ?? (firstVariant?.requiresAuth ? 'custom' : 'none'));
  const technicalRows = catalogTechnicalRows(entry, discoverDetail);
  const documentationLinks = catalogDocumentationLinks(entry, discoverDetail);

  const primaryAction = connectedConnector ? (
    <Button asChild className="max-sm:w-full">
      <Link href={connectedConnectorHref(projectId, connectedConnector.slug)}>
        Open project connector
      </Link>
    </Button>
  ) : canWrite ? (
    <Button className="gap-1.5 max-sm:w-full" onClick={() => setActionOpen(true)}>
      <PlusIcon className="size-4 shrink-0" />
      {entry.source === 'easy-connect'
        ? 'Add and connect'
        : entry.source === 'computer'
          ? 'Create profile'
          : 'Add connector'}
    </Button>
  ) : undefined;

  return (
    <ConnectorDetailLayout
      backHref={`/projects/${encodeURIComponent(projectId)}/connectors`}
      icon={<CatalogDetailIcon entry={entry} />}
      title={entry.name}
      description={entry.description}
      status={
        connectedConnector ? (
          <Badge variant="success" size="sm">
            Added
          </Badge>
        ) : undefined
      }
      primaryTitle={connectedConnector ? 'Already added to this project' : 'Add to this project'}
      primaryDescription={
        connectedConnector
          ? 'Open the project connector to manage its account, tools, and configuration.'
          : canWrite
            ? 'Create the connector first. Complete authorization or credential setup next.'
            : 'You can review this connector, but a project manager must add it.'
      }
      primaryAction={primaryAction}
    >
      <ConnectorSetupGuide
        steps={connectorSetupSteps({
          provider,
          authorizationStrategy: 'project',
          connected: Boolean(connectedConnector),
          requestAuthType,
        })}
      />

      <ConnectorDocumentationLinks links={documentationLinks} />

      {entry.source === 'discover' ? (
        <AvailableSurfaces detail={discoverDetail} loading={discoverDetailQuery.isLoading} />
      ) : null}

      <ConnectorAdvanced rows={technicalRows} />

      {actionOpen ? (
        entry.source === 'discover' ? (
          <DiscoverAddFlow
            projectId={projectId}
            connector={entry.connector}
            existingSlugs={existingSlugs}
            canWrite={canWrite}
            onClose={() => setActionOpen(false)}
            onAdded={added}
          />
        ) : entry.source === 'easy-connect' ? (
          <EasyConnectAddFlow
            projectId={projectId}
            app={entry.app}
            existingSlugs={existingSlugs}
            canWrite={canWrite}
            onClose={() => setActionOpen(false)}
            onAdded={added}
          />
        ) : (
          <ComputersAddFlow
            projectId={projectId}
            open
            existingSlugs={existingSlugs}
            canWrite={canWrite}
            onClose={() => setActionOpen(false)}
            onAdded={added}
          />
        )
      ) : null}
    </ConnectorDetailLayout>
  );
}

function catalogTechnicalRows(
  entry: CatalogEntry,
  detail: DiscoverConnectorDetail | null,
): ConnectorTechnicalRow[] {
  if (entry.source === 'computer') {
    return [
      { label: 'Transport', value: 'Kortix Agent Tunnel' },
      { label: 'Authentication', value: 'Paired machine identity' },
      { label: 'Access', value: 'Selected machines in this profile' },
    ];
  }
  if (entry.source === 'easy-connect') {
    return [
      { label: 'Transport', value: 'Managed app connection' },
      { label: 'Authentication', value: entry.app.authType ?? 'Provider-defined' },
      { label: 'Access', value: 'Project · one shared connection' },
    ];
  }

  const variant = detail?.variants[0];
  const endpoint = variant?.connector?.endpoint ?? variant?.connector?.url ?? variant?.url;
  const transports = variant?.transports.length
    ? variant.transports.map((transport) => transport.toUpperCase()).join(', ')
    : variant?.connector?.transport?.toUpperCase();
  return [
    ...(variant ? [{ label: 'Surface', value: variant.kind.toUpperCase() }] : []),
    ...(transports ? [{ label: 'Transport', value: transports }] : []),
    ...(endpoint ? [{ label: 'Endpoint', value: endpoint }] : []),
    {
      label: 'Authentication',
      value: variant?.requiresAuth
        ? (variant.connector?.auth?.type ?? 'Credential required')
        : 'None',
    },
    { label: 'Access', value: 'Project · one shared connection' },
  ];
}

function catalogDocumentationLinks(
  entry: CatalogEntry,
  detail: DiscoverConnectorDetail | null,
): ConnectorDocumentationLink[] {
  const links: ConnectorDocumentationLink[] = [
    { label: 'Kortix connector docs', href: '/docs/connect/connectors' },
  ];
  if (entry.source === 'discover' && entry.connector.url?.startsWith('http')) {
    links.push({ label: 'Official website', href: entry.connector.url, external: true });
  }
  for (const variant of detail?.variants ?? []) {
    if (!variant.docs?.startsWith('http')) continue;
    if (links.some((link) => link.href === variant.docs)) continue;
    links.push({ label: `${variant.name} docs`, href: variant.docs, external: true });
  }
  return links.slice(0, 5);
}

function AvailableSurfaces({
  detail,
  loading,
}: {
  detail: DiscoverConnectorDetail | null;
  loading: boolean;
}) {
  if (loading) return <Skeleton className="h-28 rounded-md" />;
  if (!detail?.variants.length) return null;
  return (
    <section className="space-y-3" aria-labelledby="connector-surfaces-title">
      <h2 id="connector-surfaces-title" className="text-foreground text-sm font-medium">
        Available surfaces
      </h2>
      <ul role="list" className="space-y-2">
        {detail.variants.map((variant) => (
          <li
            key={`${variant.kind}:${variant.id}`}
            className="bg-popover rounded-md border px-4 py-3"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="text-foreground min-w-0 flex-1 text-base font-medium sm:text-sm">
                {variant.name}
              </p>
              <Badge variant="outline" size="sm">
                {variant.kind.toUpperCase()}
              </Badge>
              {variant.transports.map((transport) => (
                <Badge key={transport} variant="secondary" size="sm">
                  {transport.toUpperCase()}
                </Badge>
              ))}
              <Badge variant={variant.requiresAuth ? 'info' : 'success'} size="sm">
                {variant.requiresAuth ? 'Authentication required' : 'No authentication'}
              </Badge>
            </div>
            {variant.description ? (
              <p className="text-muted-foreground pt-1 text-base text-pretty sm:text-sm">
                {variant.description}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CatalogNotFound({
  projectId,
  title,
  description,
}: {
  projectId: string;
  title: string;
  description: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-12">
      <ErrorState
        size="sm"
        title={title}
        description={description}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${encodeURIComponent(projectId)}/connectors`}>
              Return to connectors
            </Link>
          </Button>
        }
      />
    </div>
  );
}
