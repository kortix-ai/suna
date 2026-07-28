'use client';

/**
 * Connectors, signed out.
 *
 * A public catalogue would serve anonymous visitors. Ours is
 * project-scoped: `listDiscoverIntegrations` and `listPipedreamApps` both hit
 * `/executor/projects/:projectId/…` and answer 401 with no session. So this
 * renders the same ProjectSectionPage over a CURATED STATIC list instead —
 * real connectors, real names, honest one-line descriptions, each one checked
 * against the repo by demo-connectors.test.ts. Nothing here is invented.
 *
 * Search and the category pills genuinely work against that list, because
 * browsing is the whole point of the reference screen — a catalogue you cannot
 * search is a picture of a catalogue. Everything that would CHANGE something —
 * the header action, a card, the closing call to action — goes through the
 * sign-in gate.
 *
 * Nothing implies the visitor has connected anything: no Connected pill, no
 * status dot, no tick, no tool counts, and no catalogue total.
 */

import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { ProjectSectionPage } from '@/features/workspace/project-section/project-section-page';

import { ConnectorCatalogueGrid } from './connector-catalogue-grid';
import {
  DEMO_CONNECTOR_FILTERS,
  type DemoConnectorFilter,
  filterDemoConnectors,
  groupDemoConnectors,
} from './demo-connectors';

/** The real docs page for this surface — apps/web/content/docs/connect/connectors.mdx. */
const CONNECTORS_DOCS_HREF = '/docs/connect/connectors';

export function ConnectorsDemo({ navTabs }: { navTabs?: ReactNode }) {
  const { gate } = useSignInGate();
  const onGate = () => gate('/');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<DemoConnectorFilter>('all');

  const sections = groupDemoConnectors(filterDemoConnectors(query, filter));

  return (
    <ProjectSectionPage
      navTabs={navTabs}
      title="Connectors"
      description="Connect the tools your agent is allowed to act in."
      docsHref={CONNECTORS_DOCS_HREF}
      width="wide"
      search={{ value: query, onChange: setQuery, placeholder: 'Search connectors' }}
      action={
        <Button type="button" size="sm" onClick={onGate}>
          <Plus className="size-4" />
          Add connector
        </Button>
      }
      filters={
        <div className="flex flex-wrap items-center gap-1">
          {DEMO_CONNECTOR_FILTERS.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={filter === option.id ? 'secondary' : 'ghost'}
              aria-current={filter === option.id ? 'page' : undefined}
              onClick={() => setFilter(option.id)}
              className="rounded-full"
            >
              {option.label}
            </Button>
          ))}
        </div>
      }
      state={sections.length > 0 ? 'ready' : 'no-results'}
      noResultsMessage="Nothing in this sample matches. Sign in to search the full catalogue."
    >
      <div className="space-y-6">
        {sections.map((section) => (
          <ConnectorCatalogueGrid
            key={section.group.id}
            label={section.group.label}
            items={section.connectors}
            onSelect={onGate}
          />
        ))}

        <div className="border-border/60 flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-sm">
            A sample of what Kortix connects to. Sign in for the full catalogue — one-click OAuth
            apps, any OpenAPI or GraphQL API, and remote MCP servers.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onGate} className="shrink-0">
            Sign in to browse
          </Button>
        </div>
      </div>
    </ProjectSectionPage>
  );
}

export default ConnectorsDemo;
