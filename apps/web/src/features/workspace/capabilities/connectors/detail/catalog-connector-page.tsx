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
import { CaretRightIcon, GlobeIcon, MonitorIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SplitSheet, SplitSheetMain, SplitSheetTrigger } from '@/components/ui/split-sheet';
import { ErrorState } from '@/features/layout/section/error-state';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import {
  catalogEntryConnectors,
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  computersCatalogEntry,
  foldKey,
  type CatalogEntry,
} from '../catalog/catalog-entry';
import { appConnectorHref, connectedConnectorHref, parseCatalogSource } from '../connector-routes';
import { connectorStatusLine } from '../connector-status-line';
import { providerLabel } from '../provider-label';
import { recommendedSurfaceVariant } from './connector-detail-copy';
import { connectorDocLinks } from './connector-doc-links';
import {
  ConnectorDetailLayout,
  ConnectorDetailSkeleton,
  ConnectorDocumentationLinks,
  type ConnectorDocumentationLink,
} from './connector-detail-layout';

const DiscoverAddSheet = dynamic(
  () => import('../add/discover-add-sheet').then((module) => module.DiscoverAddSheet),
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
        <Image
          src={entry.icon}
          alt=""
          width={40}
          height={40}
          unoptimized
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

function CatalogConnectorSkeleton() {
  return <ConnectorDetailSkeleton />;
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const source = parseCatalogSource(sourceValue);
  const router = useRouter();
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const [actionOpen, setActionOpen] = useState(false);
  const [installFor, setInstallFor] = useState<'project' | 'user' | null>(null);

  // The card's Install dropdown lands here with `?add=1&for=project|me` —
  // open the add panel with that scope preselected, then strip the params so
  // refresh and back do not re-open it.
  const addRequested = search?.get('add') === '1';
  useEffect(() => {
    if (!addRequested) return;
    setInstallFor(search?.get('for') === 'me' ? 'user' : 'project');
    setActionOpen(true);
    const params = new URLSearchParams(window.location.search);
    params.delete('add');
    params.delete('for');
    const suffix = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      suffix ? `${window.location.pathname}?${suffix}` : window.location.pathname,
    );
  }, [addRequested, search]);

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
      const bySlug = <T extends { slug: string }>(items: T[]): T | null =>
        items.find((item) => foldKey(item.slug) === foldKey(slug)) ?? null;
      const page = await listDiscoverConnectors(projectId, slug);
      const hit = bySlug(page.items);
      if (hit) return hit;
      // An API predating the slug-in-search-haystack fix answers zero rows
      // for a slug like "deepwiki-com" — its only other spelling in the index
      // is the DOMAIN, "deepwiki.com". Retry with the domain spelling before
      // declaring the entry gone.
      const domainSpelling = slug.replace(/-/g, '.');
      if (domainSpelling === slug) return null;
      const fallback = await listDiscoverConnectors(projectId, domainSpelling);
      return bySlug(fallback.items);
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
      ? computersCatalogEntry(tI18nComplete)
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
  if (entryLoading) return <CatalogConnectorSkeleton />;

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

  const projectMatches = catalogEntryConnectors(connectors, entry);
  const alreadyAdded = projectMatches.length > 0;
  const discoverDetail = discoverDetailQuery.data ?? null;
  const added = (addedSlug?: string) => {
    setActionOpen(false);
    void queryClient.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    // `?connect=1`: the connector page opens straight into its connect dialog
    // when a credential is still needed, so adding flows into connecting
    // without hunting for the next button. The page ignores it when nothing
    // is left to connect (managed flows authorize during add).
    if (addedSlug) {
      // Catalogue apps land in the SPLIT view — app context kept on the left,
      // the new connector (with its connect dialog) in the right column.
      // `?src=apps` marks the Easy Connect catalogue for the left pane.
      const target =
        entry.source === 'discover'
          ? `${appConnectorHref(projectId, entry.slug, addedSlug)}?connect=1`
          : entry.source === 'easy-connect'
            ? `${appConnectorHref(projectId, entry.slug, addedSlug)}?src=apps&connect=1`
            : `${connectedConnectorHref(projectId, addedSlug)}?connect=1`;
      router.push(target);
    }
  };

  // The surface this page leads with. MCP wins whenever the app publishes an
  // addable MCP surface (COR-17) — the entry's own `kind` only describes the
  // catalogue row, not the best way in.
  const firstVariant = discoverDetail ? recommendedSurfaceVariant(discoverDetail.variants) : null;
  const discoverKind =
    firstVariant?.kind ?? (entry.source === 'discover' ? entry.connector.kind : null);
  const provider =
    entry.source === 'easy-connect'
      ? (entry.app.provider ?? 'pipedream')
      : entry.source === 'computer'
        ? 'computer'
        : discoverKind === 'mcp'
          ? 'mcp'
          : discoverKind === 'graphql'
            ? 'graphql'
            : discoverKind === 'postman'
              ? 'postman'
              : discoverKind === 'http'
                ? 'http'
                : 'openapi';
  const requestAuthType =
    entry.source === 'easy-connect'
      ? entry.app.authType === 'oauth'
        ? 'oauth2'
        : entry.app.authType === 'none'
          ? 'none'
          : 'custom'
      : (firstVariant?.connector?.auth?.type ?? (firstVariant?.requiresAuth ? 'custom' : 'none'));
  const documentationLinks = catalogDocumentationLinks(entry, discoverDetail, provider);

  // Adding is ALWAYS on the table for writers — one app can back many
  // connections (Canva, Canva 2, …), so "already added" never hides the way
  // to add another. The already-added connectors get their own direct links
  // in the "In this project" list below.
  const addLabel =
    entry.source === 'easy-connect'
      ? alreadyAdded
        ? 'Connect another'
        : 'Add and connect'
      : entry.source === 'computer'
        ? 'Create profile'
        : alreadyAdded
          ? 'Add another'
          : 'Add connector';
  const primaryAction = canWrite ? (
    entry.source === 'discover' ? (
      // The split column's own trigger: it toggles the panel AND moves focus
      // into it, and closing returns focus here.
      <SplitSheetTrigger asChild>
        <Button className="gap-1.5 max-sm:w-full">
          <PlusIcon className="size-4 shrink-0" />
          {addLabel}
        </Button>
      </SplitSheetTrigger>
    ) : (
      <Button className="gap-1.5 max-sm:w-full" onClick={() => setActionOpen(true)}>
        <PlusIcon className="size-4 shrink-0" />
        {addLabel}
      </Button>
    )
  ) : alreadyAdded ? (
    <Button asChild variant="outline" className="max-sm:w-full">
      <Link href={connectedConnectorHref(projectId, projectMatches[0].slug)}>Open connector</Link>
    </Button>
  ) : undefined;

  return (
    /* The add panel is a SPLIT column, not an overlay: opening it narrows the
       page and the catalogue stays readable beside the form. Only discover
       entries split — the other sources keep their own modal flows, so the
       grid must not open an empty second column for them. */
    <SplitSheet
      open={entry.source === 'discover' && actionOpen}
      onOpenChange={setActionOpen}
      size="lg"
      className="min-h-0 flex-1"
    >
      <SplitSheetMain className="flex flex-col">
        <ConnectorDetailLayout
          backHref={`/projects/${encodeURIComponent(projectId)}/connectors`}
          icon={<CatalogDetailIcon entry={entry} />}
      title={entry.name}
      description={entry.description}
      status={
        alreadyAdded ? (
          <Badge variant="success" size="sm">
            {projectMatches.length === 1 ? 'Added' : `Added ×${projectMatches.length}`}
          </Badge>
        ) : undefined
      }
      primaryTitle={alreadyAdded ? 'Added to this project' : 'Add to this project'}
      primaryDescription={
        alreadyAdded
          ? 'Open a connector below, or add another — each connection gets its own name.'
          : canWrite
            ? 'One click here, then connect it on its own page.'
            : 'You can review this connector, but a project manager must add it.'
      }
      primaryAction={primaryAction}
    >
      {/* Direct links to every connector already created from this entry —
          the shortcut Jay asked for: card → its live page, no re-adding. */}
      {alreadyAdded ? (
        <section className="space-y-2" aria-labelledby="connector-matches-title">
          <h2 id="connector-matches-title" className="text-foreground text-sm font-medium">
            In this project
          </h2>
          <ul className="space-y-2">
            {projectMatches.map((match) => (
              <li key={match.slug}>
                <Link
                  href={
                    entry.source === 'discover'
                      ? appConnectorHref(projectId, entry.slug, match.slug)
                      : entry.source === 'easy-connect'
                        ? `${appConnectorHref(projectId, entry.slug, match.slug)}?src=apps`
                        : connectedConnectorHref(projectId, match.slug)
                  }
                  className="group bg-popover hover:bg-accent flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {match.name?.trim() || match.slug}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {connectorStatusLine(match, providerLabel(match.provider))}
                    </span>
                  </span>
                  <CaretRightIcon className="text-muted-foreground/60 size-4 shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}



      <ConnectorDocumentationLinks links={documentationLinks} />

      {/* Modal flows for the non-discover sources, mounted PERSISTENTLY with
          open driven by props — never `{actionOpen ? <Flow/> : null}`. These
          flows hold multi-step internal state, and a conditional mount
          destroys it mid-hand-off (the "Add connector does nothing, no
          request" bug). Discover entries use the split column instead — see
          the DiscoverAddSheet sibling under <SplitSheet>. */}
      {entry.source === 'easy-connect' ? (
        <EasyConnectAddFlow
          projectId={projectId}
          app={actionOpen ? entry.app : null}
          existingSlugs={existingSlugs}
          canWrite={canWrite}
          onClose={() => setActionOpen(false)}
          onAdded={added}
        />
      ) : entry.source === 'computer' ? (
        <ComputersAddFlow
          projectId={projectId}
          open={actionOpen}
          existingSlugs={existingSlugs}
          canWrite={canWrite}
          onClose={() => setActionOpen(false)}
          onAdded={added}
        />
      ) : null}
        </ConnectorDetailLayout>
      </SplitSheetMain>

      {entry.source === 'discover' ? (
        <DiscoverAddSheet
          projectId={projectId}
          initialStrategy={installFor ?? undefined}
          connector={entry.connector}
          existingSlugs={existingSlugs}
          canWrite={canWrite}
          onAdded={added}
        />
      ) : null}
    </SplitSheet>
  );
}

function catalogDocumentationLinks(
  entry: CatalogEntry,
  detail: DiscoverConnectorDetail | null,
  provider: AdminConnector['provider'],
): ConnectorDocumentationLink[] {
  // Seeded from the curated map: the Kortix guide anchored to this provider's
  // section, plus the app's own developer docs when we know them — the same
  // links the connected page shows, so the story does not change after Add.
  const links: ConnectorDocumentationLink[] = [
    ...connectorDocLinks({ provider, slug: entry.slug, name: entry.name }),
  ];
  if (
    entry.source === 'discover' &&
    entry.connector.url?.startsWith('http') &&
    !links.some((link) => link.href === entry.connector.url)
  ) {
    links.push({ label: 'Official website', href: entry.connector.url, external: true });
  }
  for (const variant of detail?.variants ?? []) {
    if (!variant.docs?.startsWith('http')) continue;
    if (links.some((link) => link.href === variant.docs)) continue;
    links.push({ label: `${variant.name} docs`, href: variant.docs, external: true });
  }
  return links.slice(0, 6);
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
