import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MarketplaceItemDetail } from '@/lib/marketplace-client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { AuthProvider } from '@/features/providers/auth-provider';
import { MarketplaceDetail } from './marketplace-detail';
import { MarketplaceSurfaceProvider } from './marketplace-surface';

const data: MarketplaceItemDetail = {
  id: 'synthetic:project', registry: 'synthetic', name: 'project', type: 'registry:project',
  title: 'Synthetic project', description: 'Synthetic description', categories: [],
  capabilities: { secrets: [], connectors: [], tools: [], network: [] },
  dependencies: ['second', 'missing', 'first'], fileCount: 0, external: true,
  marketplaceId: 'synthetic', marketplaceLabel: 'Synthetic source', owner: 'synthetic',
  sourceUrl: 'https://example.test/source', files: [{ target: 'README.md', type: 'file' }, { target: 'notes.txt', type: 'file' }], readme: 'Synthetic readme body',
  dependencyItems: [
    { id: 'synthetic:first', name: 'first', title: 'First member', type: 'registry:skill', description: null },
    { id: 'synthetic:second', name: 'second', title: 'Second member', type: 'registry:skill', description: 'Second description' },
  ],
  projectAgents: [{ name: 'review-agent', title: 'Review-agent', description: 'Agent description' }],
  projectTriggers: [{ slug: 'daily-check', description: 'Trigger description', agent: 'review-agent' }],
};

describe('project content rendering', () => {
  for (const embedded of [false, true]) {
    test(`${embedded ? 'embedded' : 'public'} preserves ordered cards and non-navigable extras`, () => {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <MarketplaceSurfaceProvider surface={{ variant: 'public', itemHref: (id) => `/synthetic/${id}`, openItem: () => {} }}>
            <AppRouterContext.Provider value={{ bfcacheId: 'synthetic', back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch: async () => {} }}><AuthProvider><MarketplaceDetail data={data} onBack={embedded ? () => {} : undefined} /></AuthProvider></AppRouterContext.Provider>
          </MarketplaceSurfaceProvider>
        </QueryClientProvider>,
      );
      expect(html.indexOf('Second member')).toBeLessThan(html.indexOf('First member'));
      expect(html).not.toContain('/synthetic/missing');
      expect(html).toContain('href="/synthetic/synthetic:second"');
      expect(html).toContain('Review agent');
      expect(html).toContain('daily check');
      expect(html).not.toContain('/synthetic/agent:');
      expect(html).not.toContain('/synthetic/trigger:');
      expect(html).toContain('Synthetic readme body');
      expect(html).toContain('notes.txt');
      expect(html).toContain(embedded ? 'sm:grid-cols-3' : 'sm:grid-cols-2');
    });
  }
});
