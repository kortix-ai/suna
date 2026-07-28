/**
 * Source-text contract for the signed-out Connectors screen.
 *
 * Deliberately not a render test: the component is a client component behind
 * `useSignInGate`, which needs the app router. The rules that matter here are
 * structural — what the screen shows, what it refuses to claim, and that every
 * action goes through the gate — and those are all visible in the source.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEMO_CONNECTORS, groupDemoConnectors } from './demo-connectors';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./connectors-demo.tsx', import.meta.url)),
  'utf8',
);

/**
 * The header comment explains the rules below by naming the things the screen
 * must not do, so the bans are checked against the code alone.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Every `onClick` / `onChange` / `onSelect` handler in the file, as written. */
const HANDLERS = CODE.match(/on(?:Click|Change|Select)[=:]\s*\{?[^,}\n]*/g) ?? [];

describe('it is a real, browsable catalogue', () => {
  test('renders the curated list through the shared catalogue grid', () => {
    expect(SOURCE).toContain('ConnectorCatalogueGrid');
    expect(SOURCE).toContain('items={section.connectors}');
  });

  test('search filters the list instead of being a dead box', () => {
    expect(SOURCE).toContain('filterDemoConnectors');
    expect(SOURCE).toContain('onChange: setQuery');
    expect(SOURCE).toContain('value: query');
  });

  test('the category pills filter the list too', () => {
    expect(SOURCE).toContain('DEMO_CONNECTOR_FILTERS');
    expect(SOURCE).toContain('setFilter(option.id)');
  });

  test('groups render with a heading, in the declared order', () => {
    expect(SOURCE).toContain('groupDemoConnectors');
    expect(SOURCE).toContain('label={section.group.label}');
    expect(groupDemoConnectors(DEMO_CONNECTORS).length).toBeGreaterThan(1);
  });

  test('a search that matches nothing lands on no-results, not a blank ready state', () => {
    expect(SOURCE).toContain("state={sections.length > 0 ? 'ready' : 'no-results'}");
    expect(SOURCE).toContain('noResultsMessage=');
  });
});

describe('it is the real screen, not a lookalike', () => {
  test('uses the shared section shell', () => {
    expect(SOURCE).toContain('<ProjectSectionPage');
    expect(SOURCE).toContain("from '@/features/workspace/project-section/project-section-page'");
  });

  test('is not built from the banned primitives', () => {
    expect(SOURCE).not.toContain('SectionCard');
    expect(SOURCE).not.toContain('page-header');
    expect(SOURCE).not.toContain('<ListRow');
    expect(SOURCE).not.toContain('animate-spin');
    expect(SOURCE).not.toContain('Loader2');
    expect(SOURCE).not.toContain('DialogContent');
  });

  test('the description is one line inside the shell budget', () => {
    const match = SOURCE.match(/description="([^"]*)"/);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').length).toBeLessThanOrEqual(90);
  });

  test('points at a docs page that exists in this repo', () => {
    const match = SOURCE.match(/CONNECTORS_DOCS_HREF = '([^']+)'/);
    expect(match).not.toBeNull();
    const slug = (match?.[1] ?? '').replace(/^\/docs\//, '');
    const page = new URL(`../../../../content/docs/${slug}.mdx`, import.meta.url);
    expect(existsSync(fileURLToPath(page))).toBe(true);
  });
});

describe('every action is gated', () => {
  test('there are handlers to check', () => {
    expect(HANDLERS.length).toBeGreaterThanOrEqual(5);
  });

  test('each one either gates or only updates local browse state', () => {
    for (const handler of HANDLERS) {
      const gates = /onGate|gate\(/.test(handler);
      const browses = /set(?:Query|Filter)/.test(handler);
      expect(gates || browses).toBe(true);
    }
  });

  test('the header action, the cards and the closing CTA all gate', () => {
    expect(SOURCE).toContain('onSelect={onGate}');
    expect(SOURCE).toMatch(/onClick=\{onGate\}[\s\S]*Add connector/);
    expect(SOURCE).toContain('Sign in to browse');
  });

  test('gating goes through the one hook, never a hand-rolled redirect', () => {
    expect(SOURCE).toContain('useSignInGate');
    expect(SOURCE).not.toContain('router.push');
    expect(SOURCE).not.toContain('window.location');
    expect(SOURCE).not.toContain('<a href="/auth');
  });
});

describe('nothing implies the visitor has connected anything', () => {
  test('no connection state, status or tool count appears', () => {
    expect(CODE).not.toMatch(/\bConnected\b/);
    expect(CODE).not.toMatch(/Needs setup/i);
    expect(CODE).not.toMatch(/your connectors/i);
    expect(CODE).not.toMatch(/\d+ tools/i);
  });

  test('the closing line says it is a sample, without claiming a catalogue size', () => {
    expect(CODE).toContain('A sample of what Kortix connects to.');
    expect(CODE).not.toMatch(/\d[\d,]*\s*\+?\s*(apps|integrations|connectors|APIs)/i);
  });

  test('it names only provider kinds the docs actually list', () => {
    // apps/web/content/docs/connect/connectors.mdx: pipedream OAuth, openapi,
    // postman, graphql, http, mcp, channel, computer.
    for (const claim of ['OAuth', 'OpenAPI', 'GraphQL', 'MCP']) {
      expect(SOURCE).toContain(claim);
    }
  });

  test('it fetches nothing — both catalogue endpoints 401 without a session', () => {
    expect(CODE).not.toContain('useQuery');
    expect(CODE).not.toContain("from '@kortix/sdk'");
    expect(CODE).not.toContain('listPipedreamApps');
    expect(CODE).not.toContain('listDiscoverIntegrations');
  });
});
