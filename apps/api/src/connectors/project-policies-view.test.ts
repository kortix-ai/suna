import { beforeEach, describe, expect, mock, test } from 'bun:test';

// KRTX-2527: right after `kortix connectors policy <slug> set '*' ask`
// succeeds, `kortix connectors policy ls` printed "No explicit project
// policies" — the project view read only the top-level `policies:` list and
// `policy:` block, never the per-connector rules the set command had just
// committed to the same manifest. The view must carry the per-connector rule
// counts so the parent view reflects rules set seconds earlier.

let storedConnectors: Record<string, unknown>[] = [];

const fakeDb: any = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [
          {
            projectId: 'project-1',
            accountId: 'account-1',
            name: 'Policy view test',
            repoUrl: 'https://example.test/policies.git',
            manifestPath: 'kortix.yaml',
            defaultBranch: 'main',
            metadata: {},
          },
        ],
      }),
    }),
  }),
};

mock.module('../shared/db', () => ({ db: fakeDb }));
// Spread the real module: `mock.module` replaces it WHOLESALE, and the import
// graph of manifest-crud pulls other exports of this file (parseGitHubRepoUrl).
import * as realGit from '../projects/lib/git';
mock.module('../projects/lib/git', () => ({
  ...realGit,
  withProjectGitAuth: async (project: Record<string, unknown>) => ({
    ...project,
    gitAuthToken: 'test-token',
    gitAuthHeaders: {},
  }),
}));
// Spread the real module (see the git mock above): surface re-exports
// withProjectGitAuth that the graph pulls from here.
import * as realSurface from '../projects/surface';
mock.module('../projects/surface', () => ({
  ...realSurface,
  loadManifestForEdit: async () => ({
    schemaVersion: 2,
    format: 'yaml',
    path: 'kortix.yaml',
    revision: '1',
    raw: {
      kortix_version: 2,
      policy: { default_mode: 'allow_all' },
      connectors: structuredClone(storedConnectors),
    },
  }),
}));

const { getProjectPoliciesFromManifest } = await import('./manifest-crud');

beforeEach(() => {
  storedConnectors = [];
});

describe('getProjectPoliciesFromManifest — per-connector rule counts', () => {
  test('a connector rule set seconds earlier appears in the project view', async () => {
    storedConnectors = [
      {
        slug: 'dogfood-mcp',
        provider: 'mcp',
        url: 'https://mcp.example.test/mcp',
        policies: [{ match: '*', action: 'require_approval' }],
      },
    ];
    const view = await getProjectPoliciesFromManifest('project-1');
    expect(view?.connectorRules).toEqual([{ slug: 'dogfood-mcp', rules: 1 }]);
    // The project-wide fields keep their meaning: no top-level policies.
    expect(view?.policies).toEqual([]);
    expect(view?.defaultMode).toBe('allow_all');
  });

  test('connectors without rules are not listed', async () => {
    storedConnectors = [
      { slug: 'plain', provider: 'http', baseUrl: 'https://example.test' },
      {
        slug: 'ruled',
        provider: 'http',
        baseUrl: 'https://example.test',
        policies: [
          { match: 'a*', action: 'always_run' },
          { match: 'b*', action: 'block' },
        ],
      },
    ];
    const view = await getProjectPoliciesFromManifest('project-1');
    expect(view?.connectorRules).toEqual([{ slug: 'ruled', rules: 2 }]);
  });

  test('a manifest with no connector rules reports an empty list', async () => {
    storedConnectors = [{ slug: 'plain', provider: 'http', baseUrl: 'https://example.test' }];
    const view = await getProjectPoliciesFromManifest('project-1');
    expect(view?.connectorRules).toEqual([]);
  });
});
